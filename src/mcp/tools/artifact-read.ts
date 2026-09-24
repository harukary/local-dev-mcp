import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { getActiveProject, jsonError, matchesDeniedPath, sha256 } from "./dev/common.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 6 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 6 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".tsx": "text/typescript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

export async function handleArtifactLink(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  if (!args?.path || !args.path.trim()) {
    return jsonError("MISSING_PATH", "Missing required argument: path.");
  }

  const resolved = await resolveArtifactPath(project, args.path);
  if (!resolved.ok) {
    await logArtifactFailure(ctx, chatContextId, project, args.path, resolved.message, "artifact.link", "artifact_link_failed");
    return jsonError(resolved.code, resolved.message);
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absolutePath);
  } catch {
    await logArtifactFailure(ctx, chatContextId, project, args.path, "File not found.", "artifact.link", "artifact_link_failed");
    return jsonError("FILE_NOT_FOUND", "File not found.");
  }

  if (!fileStat.isFile()) {
    await logArtifactFailure(ctx, chatContextId, project, args.path, "Path is not a regular file.", "artifact.link", "artifact_link_failed");
    return jsonError("NOT_A_FILE", "Path is not a regular file.");
  }
  if (fileStat.size > MAX_ARTIFACT_BYTES) {
    const message = `File is too large to materialize safely through the Secure MCP Tunnel (${fileStat.size} bytes). Maximum raw file size is ${MAX_ARTIFACT_BYTES} bytes.`;
    await logArtifactFailure(ctx, chatContextId, project, args.path, message, "artifact.link", "artifact_link_failed");
    return jsonError("ARTIFACT_TOO_LARGE_FOR_TUNNEL", message, { size_bytes: fileStat.size, max_bytes: MAX_ARTIFACT_BYTES });
  }

  const fileName = basename(resolved.relativePath) || "artifact";
  const mimeType = detectMimeType(resolved.absolutePath);
  const uri = buildArtifactUri(project.projectId, resolved.relativePath);
  const metadata = {
    project_id: project.projectId,
    path: resolved.relativePath,
    filename: fileName,
    mime_type: mimeType,
    size_bytes: fileStat.size,
    transport: "mcp_resource_link",
    uri,
  };

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "artifact.link",
    event: "artifact_link",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: resolved.relativePath,
    enforcement: "audit_only",
  });

  return {
    structuredContent: metadata,
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      {
        type: "resource_link" as const,
        uri,
        name: fileName,
        description: `Local project artifact: ${resolved.relativePath}`,
        mimeType,
        size: fileStat.size,
      },
    ],
  };
}

export async function handleArtifactResourceRead(
  ctx: AppContext,
  chatContextId: string,
  uri: string
) {
  const parsed = parseArtifactUri(uri);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  const project = ctx.registry.get(parsed.projectId);
  if (!project) {
    throw new Error(`Project not found: ${parsed.projectId}`);
  }

  const resolved = await resolveArtifactPath(project, parsed.path);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }

  const fileStat = await stat(resolved.absolutePath).catch(() => null);
  if (!fileStat) throw new Error("File not found.");
  if (!fileStat.isFile()) throw new Error("Path is not a regular file.");
  if (fileStat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`ARTIFACT_TOO_LARGE_FOR_TUNNEL: resource is ${fileStat.size} bytes; maximum raw file size is ${MAX_ARTIFACT_BYTES} bytes.`);
  }

  const bytes = await readFile(resolved.absolutePath);
  const mimeType = detectMimeType(resolved.absolutePath, bytes);

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "resources/read",
    event: "artifact_resource_read",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: resolved.relativePath,
    enforcement: "audit_only",
  });

  return {
    contents: [{ uri, mimeType, blob: bytes.toString("base64") }],
  };
}

export async function handleArtifactRead(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; max_bytes?: number }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  if (!args?.path || !args.path.trim()) {
    return jsonError("MISSING_PATH", "Missing required argument: path.");
  }

  const resolved = await resolveArtifactPath(project, args.path);
  if (!resolved.ok) {
    await logArtifactFailure(ctx, chatContextId, project, args.path, resolved.message);
    return jsonError(resolved.code, resolved.message);
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absolutePath);
  } catch {
    await logArtifactFailure(ctx, chatContextId, project, args.path, "File not found.");
    return jsonError("FILE_NOT_FOUND", "File not found.");
  }

  if (!fileStat.isFile()) {
    await logArtifactFailure(ctx, chatContextId, project, args.path, "Path is not a regular file.");
    return jsonError("NOT_A_FILE", "Path is not a regular file.");
  }

  const maxBytes = normalizeMaxBytes(args.max_bytes);
  if (fileStat.size > maxBytes) {
    const message = `File is too large for a single MCP embedded resource (${fileStat.size} bytes). Maximum is ${maxBytes} bytes.`;
    await logArtifactFailure(ctx, chatContextId, project, args.path, message);
    return jsonError("ARTIFACT_TOO_LARGE", message, { size_bytes: fileStat.size, max_bytes: maxBytes });
  }

  const bytes = await readFile(resolved.absolutePath);
  const digest = sha256(bytes);
  const fileName = basename(resolved.relativePath) || "artifact";
  const mimeType = detectMimeType(resolved.absolutePath, bytes);
  const uri = buildArtifactUri(project.projectId, resolved.relativePath);
  const metadata = {
    project_id: project.projectId,
    path: resolved.relativePath,
    filename: fileName,
    mime_type: mimeType,
    size_bytes: bytes.length,
    sha256: digest,
    transport: "mcp_embedded_resource",
    encoding: "base64",
    uri,
  };

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "artifact.read",
    event: "artifact_read",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: resolved.relativePath,
    enforcement: "audit_only",
  });

  return {
    structuredContent: metadata,
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      {
        type: "resource" as const,
        resource: {
          uri,
          mimeType,
          blob: bytes.toString("base64"),
          _meta: { filename: fileName, size_bytes: bytes.length, sha256: digest },
        },
      },
    ],
  };
}

async function resolveArtifactPath(project: ProjectConfig, inputPath: string): Promise<
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; code: string; message: string }
> {
  const root = resolve(project.hostRoot);
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const relativePath = relative(root, absolutePath).replace(/\\/g, "/") || ".";

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false, code: "PATH_OUTSIDE_PROJECT", message: "Path must stay inside the selected project root." };
  }

  const denied = relativePath === "." ? null : matchesDeniedPath(relativePath, project);
  if (denied) {
    return { ok: false, code: "DENIED_PATH", message: `Path is denied by project policy: ${denied}` };
  }

  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(absolutePath);
    const realRelative = relative(realRoot, realFile);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
      return { ok: false, code: "PATH_OUTSIDE_PROJECT", message: "Path must stay inside the selected project root." };
    }
  } catch {
    // stat() below produces the user-facing file error.
  }

  return { ok: true, absolutePath, relativePath };
}

function normalizeMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ARTIFACT_BYTES;
  return Math.min(MAX_ARTIFACT_BYTES, Math.max(1, Math.round(value)));
}

function buildArtifactUri(projectId: string, relativePath: string): string {
  const encodedProject = encodeURIComponent(projectId);
  const encodedPath = relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `local-dev-artifact://${encodedProject}/${encodedPath}`;
}

function detectMimeType(filePath: string, bytes?: Buffer): string {
  const byExtension = MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (byExtension) return byExtension;
  if (bytes?.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "application/zip";
  return "application/octet-stream";
}

function parseArtifactUri(uri: string):
  | { ok: true; projectId: string; path: string }
  | { ok: false; message: string } {
  const match = uri.match(/^local-dev-artifact:\/\/([^/]+)\/(.+)$/);
  if (!match) return { ok: false, message: `Unknown resource: ${uri}` };

  try {
    const projectId = decodeURIComponent(match[1]);
    const path = match[2].split("/").map((segment) => decodeURIComponent(segment)).join("/");
    if (!projectId || !path) return { ok: false, message: `Unknown resource: ${uri}` };
    return { ok: true, projectId, path };
  } catch {
    return { ok: false, message: `Malformed artifact resource URI: ${uri}` };
  }
}

async function logArtifactFailure(
  ctx: AppContext,
  chatContextId: string,
  project: ProjectConfig,
  path: string,
  error: string,
  tool = "artifact.read",
  event = "artifact_read_failed"
): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool,
    event,
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: path,
    enforcement: "blocked",
    error,
  });
}
