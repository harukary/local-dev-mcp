import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { getActiveProject, jsonError, jsonResult, matchesDeniedPath } from "./dev/common.js";

const DEFAULT_MAX_RECEIVE_BYTES = 512 * 1024 * 1024;
const HARD_MAX_RECEIVE_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export interface OpenAiProvidedFile {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

interface ArtifactReceiveRuntime {
  fetchImpl: typeof fetch;
  resolveHost: (hostname: string) => Promise<string[]>;
}

const defaultRuntime: ArtifactReceiveRuntime = {
  fetchImpl: fetch,
  resolveHost: async (hostname) => {
    const records = await dnsLookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  },
};

export async function handleArtifactReceive(
  ctx: AppContext,
  chatContextId: string,
  args: { file?: OpenAiProvidedFile; destination?: string; max_bytes?: number },
  runtime: ArtifactReceiveRuntime = defaultRuntime
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  const provided = validateProvidedFile(args?.file);
  if (!provided.ok) {
    return jsonError("INVALID_FILE_REFERENCE", provided.message);
  }

  const maxBytes = normalizeMaxBytes(args.max_bytes);
  const destination = await prepareDestination(project, args.destination, provided.file);
  if (!destination.ok) {
    await logReceiveFailure(ctx, chatContextId, project, provided.file.file_id, args.destination, destination.message);
    return jsonError(destination.code, destination.message);
  }

  const tempPath = resolve(destination.parentAbsolutePath, `.local-dev-upload-${randomUUID()}.part`);
  let downloaded: { sizeBytes: number; sha256: string; responseMimeType?: string } | undefined;

  try {
    downloaded = await downloadToFile(provided.file.download_url, tempPath, maxBytes, runtime);
    await link(tempPath, destination.absolutePath);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    const code = errorCode === "EEXIST" || message.startsWith("Destination already exists")
      ? "FILE_EXISTS"
      : message.startsWith("File exceeds")
        ? "ARTIFACT_TOO_LARGE"
        : message.startsWith("Unsafe download URL")
          ? "UNSAFE_DOWNLOAD_URL"
          : "ARTIFACT_RECEIVE_FAILED";
    await logReceiveFailure(ctx, chatContextId, project, provided.file.file_id, destination.relativePath, message);
    return jsonError(code, message);
  }

  await unlink(tempPath).catch(() => undefined);

  const mimeType = normalizeMimeType(provided.file.mime_type)
    ?? normalizeMimeType(downloaded.responseMimeType)
    ?? "application/octet-stream";
  const metadata = {
    project_id: project.projectId,
    path: destination.relativePath,
    filename: basename(destination.relativePath),
    file_id: provided.file.file_id,
    mime_type: mimeType,
    size_bytes: downloaded.sizeBytes,
    sha256: downloaded.sha256,
    source: "openai_file_param",
  };

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "artifact.receive",
    event: "artifact_receive",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: `${provided.file.file_id} -> ${destination.relativePath}`,
    enforcement: "audit_only",
  });

  return jsonResult(metadata);
}

function validateProvidedFile(value: OpenAiProvidedFile | undefined):
  | { ok: true; file: OpenAiProvidedFile }
  | { ok: false; message: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "Missing required file input. Attach a file in ChatGPT and pass it to artifact.receive." };
  }
  if (typeof value.download_url !== "string" || !value.download_url.trim()) {
    return { ok: false, message: "file.download_url is required." };
  }
  if (typeof value.file_id !== "string" || !value.file_id.trim()) {
    return { ok: false, message: "file.file_id is required." };
  }
  if (value.mime_type !== undefined && typeof value.mime_type !== "string") {
    return { ok: false, message: "file.mime_type must be a string when provided." };
  }
  if (value.file_name !== undefined && typeof value.file_name !== "string") {
    return { ok: false, message: "file.file_name must be a string when provided." };
  }
  return {
    ok: true,
    file: {
      download_url: value.download_url.trim(),
      file_id: value.file_id.trim(),
      mime_type: value.mime_type?.trim() || undefined,
      file_name: value.file_name?.trim() || undefined,
    },
  };
}

async function prepareDestination(
  project: ProjectConfig,
  requestedDestination: string | undefined,
  file: OpenAiProvidedFile
): Promise<
  | { ok: true; absolutePath: string; relativePath: string; parentAbsolutePath: string }
  | { ok: false; code: string; message: string }
> {
  const root = resolve(project.hostRoot);
  const realRoot = await realpath(root);
  const fileName = sanitizeFileName(file.file_name) || "upload.bin";
  const defaultDestination = `generated/uploads/${Date.now()}-${randomUUID().slice(0, 8)}-${fileName}`;
  const rawDestination = requestedDestination?.trim() || defaultDestination;

  if (isAbsolute(rawDestination)) {
    return { ok: false, code: "INVALID_DESTINATION", message: "destination must be project-relative." };
  }

  const requestedAbsolute = resolve(root, rawDestination);
  const relativePath = relative(root, requestedAbsolute).replace(/\\/g, "/");
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false, code: "PATH_OUTSIDE_PROJECT", message: "destination must stay inside the selected project root." };
  }

  const denied = matchesDeniedPath(relativePath, project);
  if (denied) {
    return { ok: false, code: "DENIED_PATH", message: `Destination is denied by project policy: ${denied}` };
  }

  const canonicalAbsolute = resolve(realRoot, relativePath);
  const parentAbsolutePath = dirname(canonicalAbsolute);
  const parentCheck = await ensureSafeParentDirectories(realRoot, parentAbsolutePath);
  if (!parentCheck.ok) return parentCheck;

  try {
    await lstat(canonicalAbsolute);
    return { ok: false, code: "FILE_EXISTS", message: `Destination already exists: ${relativePath}` };
  } catch (err) {
    if (!isNotFoundError(err)) {
      return { ok: false, code: "DESTINATION_UNAVAILABLE", message: `Could not inspect destination: ${relativePath}` };
    }
  }

  return { ok: true, absolutePath: canonicalAbsolute, relativePath, parentAbsolutePath };
}

async function ensureSafeParentDirectories(
  realRoot: string,
  parentAbsolutePath: string
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const rel = relative(realRoot, parentAbsolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, code: "PATH_OUTSIDE_PROJECT", message: "Destination parent must stay inside the selected project root." };
  }

  let current = realRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        return { ok: false, code: "SYMLINK_DESTINATION", message: "Destination parent must not traverse symlinks." };
      }
      if (!info.isDirectory()) {
        return { ok: false, code: "INVALID_DESTINATION", message: "Destination parent contains a non-directory path component." };
      }
    } catch (err) {
      if (!isNotFoundError(err)) {
        return { ok: false, code: "DESTINATION_UNAVAILABLE", message: "Could not inspect destination parent." };
      }
      await mkdir(current, { mode: 0o700 });
    }
  }

  const realParent = await realpath(parentAbsolutePath);
  const realRelative = relative(realRoot, realParent);
  if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
    return { ok: false, code: "PATH_OUTSIDE_PROJECT", message: "Destination parent must stay inside the selected project root." };
  }
  return { ok: true };
}

async function downloadToFile(
  initialUrl: string,
  tempPath: string,
  maxBytes: number,
  runtime: ArtifactReceiveRuntime
): Promise<{ sizeBytes: number; sha256: string; responseMimeType?: string }> {
  let currentUrl = initialUrl;
  let response: Response | undefined;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertSafeDownloadUrl(currentUrl, runtime);
    response = await runtime.fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { "User-Agent": "local-dev-mcp/artifact.receive" },
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("Download redirect did not include a Location header.");
      if (redirectCount === MAX_REDIRECTS) throw new Error("Download exceeded the redirect limit.");
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    throw new Error(`Download failed with HTTP ${response?.status ?? "unknown"}.`);
  }

  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`File exceeds the receive limit (${declaredLength} bytes > ${maxBytes} bytes).`);
  }
  const handle = await open(tempPath, "wx", 0o600);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`File exceeds the receive limit (${sizeBytes} bytes > ${maxBytes} bytes).`);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } else if (declaredLength !== 0) {
      throw new Error("Download response did not include a body.");
    }
  } finally {
    await handle.close();
  }

  return {
    sizeBytes,
    sha256: hash.digest("hex"),
    responseMimeType: response.headers.get("content-type") ?? undefined,
  };
}

async function assertSafeDownloadUrl(urlValue: string, runtime: ArtifactReceiveRuntime): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("Unsafe download URL: invalid URL.");
  }
  if (url.protocol !== "https:") throw new Error("Unsafe download URL: HTTPS is required.");
  if (url.username || url.password) throw new Error("Unsafe download URL: embedded URL userinfo is not allowed.");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Unsafe download URL: local hostnames are not allowed.");
  }

  if (isIP(hostname)) {
    if (isUnsafeIpAddress(hostname)) throw new Error("Unsafe download URL: local network addresses are not allowed.");
    return;
  }

  const addresses = await runtime.resolveHost(hostname);
  if (addresses.length === 0) throw new Error("Unsafe download URL: hostname did not resolve.");
  if (addresses.some(isUnsafeIpAddress)) {
    throw new Error("Unsafe download URL: hostname resolves to a local network address.");
  }
}

function isUnsafeIpAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return isUnsafeIpAddress(normalized.slice(7));

  if (isIP(normalized) !== 4) return false;
  const parts = normalized.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function normalizeMaxBytes(value: number | undefined): number {
  const envValue = Number(process.env.LOCAL_DEV_MCP_ARTIFACT_RECEIVE_MAX_BYTES);
  const configuredDefault = Number.isFinite(envValue) && envValue > 0
    ? Math.min(HARD_MAX_RECEIVE_BYTES, Math.round(envValue))
    : DEFAULT_MAX_RECEIVE_BYTES;
  if (typeof value !== "number" || !Number.isFinite(value)) return configuredDefault;
  return Math.min(HARD_MAX_RECEIVE_BYTES, Math.max(1, Math.round(value)));
}

function sanitizeFileName(value: string | undefined): string | undefined {
  const leaf = basename(value?.trim() || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\r\n"]/g, "")
    .trim();
  if (!leaf || leaf === "." || leaf === "..") return undefined;
  return leaf.slice(0, 180);
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 255 || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isNotFoundError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT");
}

async function logReceiveFailure(
  ctx: AppContext,
  chatContextId: string,
  project: ProjectConfig,
  fileId: string,
  destination: string | undefined,
  error: string
): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "artifact.receive",
    event: "artifact_receive_failed",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: `${fileId} -> ${destination || "generated/uploads"}`,
    enforcement: "blocked",
    error,
  });
}
