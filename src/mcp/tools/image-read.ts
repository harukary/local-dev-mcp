import { readFile, stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { applyWorkingDirectory } from "../../project/working-directory.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FULL_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;
const DEFAULT_PREVIEW_MAX_EDGE = 900;
const PREVIEW_FULL_INLINE_MAX_BYTES = 512 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function handleImageRead(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; mode?: "preview" | "full" | "metadata"; max_preview_edge?: number }
) {
  if (!args?.path) {
    return {
      content: [{ type: "text", text: "Missing required argument: path" }],
      isError: true,
    };
  }

  const currentProjectId = resolveCurrentProjectId(ctx, chatContextId);
  if (!currentProjectId) {
    return errorResult("PROJECT_NOT_SELECTED", "No project is selected for this chat. Call project.select first.", {
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const baseProject = ctx.registry.get(currentProjectId);
  if (!baseProject) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return errorResult("PROJECT_NOT_SELECTED", "No project is selected for this chat. Call project.select first.", {
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const project = applyWorkingDirectory(baseProject, ctx.contextStore.getWorkingDirectory?.(chatContextId));

  const resolved = resolveImagePath(project, args.path);
  if (!resolved.ok) {
    await logImageRead(ctx, chatContextId, project, args.path, resolved.error);
    return errorResult(resolved.code, resolved.error);
  }

  const denied = checkDeniedPaths(project, resolved.relativePath);
  if (denied) {
    await logImageRead(ctx, chatContextId, project, args.path, denied);
    return errorResult("DENIED_PATH", denied);
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absolutePath);
  } catch {
    await logImageRead(ctx, chatContextId, project, args.path, "Image file not found.");
    return errorResult("IMAGE_NOT_FOUND", "Image file not found.");
  }

  if (!fileStat.isFile()) {
    await logImageRead(ctx, chatContextId, project, args.path, "Path is not a regular file.");
    return errorResult("NOT_A_FILE", "Path is not a regular file.");
  }

  if (fileStat.size > MAX_IMAGE_BYTES) {
    const message = `Image is too large (${fileStat.size} bytes). Maximum source size is ${MAX_IMAGE_BYTES} bytes.`;
    await logImageRead(ctx, chatContextId, project, args.path, message);
    return errorResult("IMAGE_TOO_LARGE", message, { size_bytes: fileStat.size, max_bytes: MAX_IMAGE_BYTES });
  }

  const mode = normalizeImageReadMode(args.mode);
  if (mode === "full" && fileStat.size > MAX_FULL_INLINE_IMAGE_BYTES) {
    const message = `Full inline image would be too large for the Secure MCP Tunnel (${fileStat.size} bytes). Maximum raw inline image size is ${MAX_FULL_INLINE_IMAGE_BYTES} bytes; use preview mode instead.`;
    await logImageRead(ctx, chatContextId, project, args.path, message);
    return errorResult("IMAGE_FULL_TOO_LARGE", message, { size_bytes: fileStat.size, max_bytes: MAX_FULL_INLINE_IMAGE_BYTES });
  }

  const bytes = await readFile(resolved.absolutePath);
  const mimeType = detectImageMime(bytes, resolved.absolutePath);
  if (!mimeType) {
    await logImageRead(ctx, chatContextId, project, args.path, "Unsupported or unrecognized image type.");
    return errorResult("UNSUPPORTED_IMAGE_TYPE", "Supported image types: png, jpeg, gif, webp.");
  }

  const dimensions = readImageDimensions(bytes, mimeType);
  const maxPreviewEdge = normalizeMaxPreviewEdge(args.max_preview_edge);
  const inlineImage = await prepareInlineImage(bytes, mimeType, dimensions, mode, maxPreviewEdge);
  const metadata = {
    project_id: project.projectId,
    path: resolved.relativePath,
    absolute_path: resolved.absolutePath,
    mime_type: mimeType,
    size_bytes: fileStat.size,
    width: dimensions?.width,
    height: dimensions?.height,
    returned_image_mode: inlineImage.mode,
    returned_image_mime_type: inlineImage.mimeType,
    returned_image_size_bytes: inlineImage.bytes?.length,
    returned_image_width: inlineImage.dimensions?.width,
    returned_image_height: inlineImage.dimensions?.height,
  };

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "image.read",
    event: "image_read",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: args.path,
    enforcement: "audit_only",
  });

  return {
    structuredContent: metadata,
    content: [
      { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
      ...(inlineImage.bytes
        ? [{
            type: "image" as const,
            data: inlineImage.bytes.toString("base64"),
            mimeType: inlineImage.mimeType!,
          }]
        : []),
    ],
  };
}

function normalizeImageReadMode(mode: string | undefined): "preview" | "full" | "metadata" {
  if (mode === "full" || mode === "metadata") return mode;
  return "preview";
}

function normalizeMaxPreviewEdge(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PREVIEW_MAX_EDGE;
  return Math.min(2000, Math.max(240, Math.round(value)));
}

async function prepareInlineImage(
  bytes: Buffer,
  mimeType: string,
  dimensions: { width: number; height: number } | undefined,
  mode: "preview" | "full" | "metadata",
  maxPreviewEdge: number
): Promise<{
  bytes?: Buffer;
  mimeType?: string;
  mode: "full" | "preview" | "preview_unavailable" | "metadata";
  dimensions?: { width: number; height: number };
}> {
  if (mode === "metadata") return { mode: "metadata" };
  if (mode === "full") return { bytes, mimeType, mode: "full", dimensions };

  const longestEdge = dimensions ? Math.max(dimensions.width, dimensions.height) : undefined;
  if (bytes.length <= PREVIEW_FULL_INLINE_MAX_BYTES && (!longestEdge || longestEdge <= maxPreviewEdge)) {
    return { bytes, mimeType, mode: "full", dimensions };
  }

  const preview = await createPreviewImageWithSips(bytes, mimeType, maxPreviewEdge);
  if (!preview) return { mode: "preview_unavailable" };
  return {
    bytes: preview.bytes,
    mimeType: preview.mimeType,
    mode: "preview",
    dimensions: readImageDimensions(preview.bytes, preview.mimeType),
  };
}

async function createPreviewImageWithSips(
  bytes: Buffer,
  mimeType: string,
  maxEdge: number
): Promise<{ bytes: Buffer; mimeType: string } | undefined> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "local-dev-mcp-image-preview-"));
  const input = join(dir, `input.${extensionForMime(mimeType)}`);
  const output = join(dir, "preview.jpg");
  try {
    await writeFile(input, bytes);
    const ok = await runSips(["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", String(maxEdge), input, "--out", output]);
    if (!ok) return undefined;
    return { bytes: await readFile(output), mimeType: "image/jpeg" };
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function runSips(args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("sips", args, { stdio: "ignore" });
    child.once("error", () => resolvePromise(false));
    child.once("close", (code) => resolvePromise(code === 0));
  });
}

function resolveImagePath(project: ProjectConfig, inputPath: string):
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; code: string; error: string } {
  const root = resolve(project.hostRoot);
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const relativePath = relative(root, absolutePath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false, code: "PATH_OUTSIDE_PROJECT", error: "Image path must stay inside the selected project root." };
  }
  return { ok: true, absolutePath, relativePath: relativePath || "." };
}

function checkDeniedPaths(project: ProjectConfig, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const deniedPath of project.deniedPaths) {
    const denied = deniedPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized === denied || normalized.startsWith(`${denied}/`) || matchesSimpleGlob(normalized, denied)) {
      return `Image path is denied by project policy: ${deniedPath}`;
    }
  }
  return null;
}

function matchesSimpleGlob(value: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function detectImageMime(bytes: Buffer, filePath: string): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  return ext ? MIME_BY_EXTENSION[ext] : undefined;
}

function readImageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mimeType === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (mimeType === "image/jpeg") return readJpegDimensions(bytes);
  if (mimeType === "image/webp") return readWebpDimensions(bytes);
  return undefined;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const type = bytes.subarray(12, 16).toString("ascii");
  if (type === "VP8 " && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (type === "VP8L" && bytes.length >= 25) {
    const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 6)) };
  }
  if (type === "VP8X" && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  return undefined;
}

async function logImageRead(
  ctx: AppContext,
  chatContextId: string,
  project: ProjectConfig,
  path: string,
  error: string
): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "image.read",
    event: "image_read_failed",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: path,
    enforcement: "blocked",
    error,
  });
}

function errorResult(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...extra } }, null, 2) }],
    isError: true,
  };
}

function resolveCurrentProjectId(ctx: AppContext, chatContextId: string): string | undefined {
  const store = ctx.contextStore as {
    getActiveProject?: (chatContextId: string, isAvailable: (projectId: string) => boolean) => string | undefined;
    getCurrentProject?: (chatContextId: string) => string | undefined;
    clearCurrentProject?: (chatContextId: string) => void;
  };
  const isAvailable = (projectId: string): boolean => typeof ctx.registry.has === "function"
    ? ctx.registry.has(projectId)
    : Boolean(ctx.registry.get(projectId));
  if (typeof store.getActiveProject === "function") return store.getActiveProject(chatContextId, isAvailable);
  const current = store.getCurrentProject?.(chatContextId);
  if (current && !isAvailable(current)) {
    store.clearCurrentProject?.(chatContextId);
    return undefined;
  }
  return current;
}
