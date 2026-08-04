import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { getActiveProject, jsonError, jsonResult, matchesDeniedPath } from "./dev/common.js";

const DEFAULT_DOWNLOAD_TTL_SECONDS = 10 * 60;
const MAX_DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;

interface CachedDownload {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
}

const downloadCache = new Map<string, CachedDownload>();

export async function handleDownloadLink(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; ttl_seconds?: number; filename?: string }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  if (!args?.path || !args.path.trim()) {
    return jsonError("MISSING_PATH", "Missing required argument: path.");
  }

  const resolved = await resolveDownloadPath(project, args.path);
  if (!resolved.ok) {
    await logDownloadLinkFailure(ctx, chatContextId, project, args.path, resolved.message);
    return jsonError(resolved.code, resolved.message);
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.absolutePath);
  } catch {
    await logDownloadLinkFailure(ctx, chatContextId, project, args.path, "File not found.");
    return jsonError("FILE_NOT_FOUND", "File not found.");
  }

  if (!fileStat.isFile()) {
    await logDownloadLinkFailure(ctx, chatContextId, project, args.path, "Path is not a regular file.");
    return jsonError("NOT_A_FILE", "Path is not a regular file.");
  }

  const ttlSeconds = normalizeTtlSeconds(args.ttl_seconds);
  const id = randomUUID();
  const now = Date.now();
  const fileName = sanitizeFileName(args.filename) || basename(resolved.relativePath) || "download";
  const expiresAt = now + ttlSeconds * 1000;
  downloadCache.set(id, {
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    fileName,
    sizeBytes: fileStat.size,
    createdAt: now,
    expiresAt,
  });
  setTimeout(() => downloadCache.delete(id), ttlSeconds * 1000).unref();

  const downloadUrl = `${getPublicOriginForTool()}/download/${id}`;
  const metadata = {
    project_id: project.projectId,
    path: resolved.relativePath,
    absolute_path: resolved.absolutePath,
    size_bytes: fileStat.size,
    download_url: downloadUrl,
    expires_at: new Date(expiresAt).toISOString(),
    ttl_seconds: ttlSeconds,
    filename: fileName,
    markdown: `[${fileName}](${downloadUrl})`,
  };

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "download.link",
    event: "download_link_created",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: resolved.relativePath,
    enforcement: "audit_only",
  });

  return jsonResult(metadata);
}

export function getCachedDownload(id: string): CachedDownload | undefined {
  const cached = downloadCache.get(id);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    downloadCache.delete(id);
    return undefined;
  }
  return cached;
}

export function clearDownloadCacheForTests(): void {
  downloadCache.clear();
}

async function resolveDownloadPath(project: ProjectConfig, inputPath: string):
  Promise<
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
    return { ok: true, absolutePath, relativePath };
  }

  return { ok: true, absolutePath, relativePath };
}

function normalizeTtlSeconds(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DOWNLOAD_TTL_SECONDS;
  return Math.min(MAX_DOWNLOAD_TTL_SECONDS, Math.max(1, Math.round(value)));
}

function sanitizeFileName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const leaf = basename(trimmed).replace(/[\r\n"]/g, "").trim();
  return leaf || undefined;
}

function getPublicOriginForTool(): string {
  const configured = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through
    }
  }
  return "http://127.0.0.1:3456";
}

async function logDownloadLinkFailure(
  ctx: AppContext,
  chatContextId: string,
  project: ProjectConfig,
  path: string,
  error: string
): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "download.link",
    event: "download_link_failed",
    projectId: project.projectId,
    cwd: project.hostRoot,
    command: path,
    enforcement: "blocked",
    error,
  });
}
