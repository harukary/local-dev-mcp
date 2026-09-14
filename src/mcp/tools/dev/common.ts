import { createHash } from "node:crypto";
import { existsSync, statSync, realpathSync, lstatSync } from "node:fs";
import { relative, resolve, isAbsolute, dirname, matchesGlob } from "node:path";
import type { AppContext } from "../../server.js";
import type { ProjectConfig } from "../../../types.js";
import { applyWorkingDirectory } from "../../../project/working-directory.js";

function asStructuredContent(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function jsonResult(value: unknown) {
  const structuredContent = asStructuredContent(value);
  return {
    ...(structuredContent ? { structuredContent } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function jsonError(code: string, message: string, details?: unknown) {
  const value = { error: { code, message, details } };
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError: true,
  };
}

export function getActiveProject(ctx: AppContext, chatContextId: string): ProjectConfig | { error: ReturnType<typeof jsonError> } {
  const store = ctx.contextStore as {
    getActiveProject?: (chatContextId: string, isAvailable: (projectId: string) => boolean) => string | undefined;
    getCurrentProject?: (chatContextId: string) => string | undefined;
    getWorkingDirectory?: (chatContextId: string) => string | undefined;
    clearCurrentProject?: (chatContextId: string) => void;
  };
  const isAvailable = (projectId: string) => ctx.registry.has(projectId);
  const projectId = typeof store.getActiveProject === "function"
    ? store.getActiveProject(chatContextId, isAvailable)
    : store.getCurrentProject?.(chatContextId);
  if (!projectId) {
    return { error: jsonError("PROJECT_NOT_SELECTED", "No project is selected for this chat. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  const project = ctx.registry.get(projectId);
  if (!project) {
    store.clearCurrentProject?.(chatContextId);
    return { error: jsonError("PROJECT_NOT_SELECTED", "The selected project is no longer available. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  return applyWorkingDirectory(project, store.getWorkingDirectory?.(chatContextId));
}

export function matchesDeniedPath(relativePath: string, project: ProjectConfig): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const policyRelative = relative(project.policyRoot ?? project.hostRoot, resolve(project.hostRoot, relativePath)).replace(/\\/g, "/");
  for (const raw of project.deniedPaths) {
    const pattern = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    for (const candidate of [normalized, policyRelative]) {
      if (candidate === pattern || candidate.startsWith(`${pattern}/`)) return raw;
      if (matchesGlob(candidate.toLowerCase(), pattern.toLowerCase())) return raw;
    }
  }
  return null;
}

export function includeByGlob(relativePath: string, glob?: string): boolean {
  if (!glob) return true;
  return matchesGlob(relativePath.replace(/\\/g, "/"), glob.replace(/^\.\//, ""));
}

export function resolveProjectPath(project: ProjectConfig, inputPath?: string, options?: { allowDirectory?: boolean }) {
  const root = resolve(project.hostRoot);
  const raw = inputPath && inputPath.trim() ? inputPath : ".";
  const absolutePath = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const relativePath = relative(root, absolutePath) || ".";
  if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    return { ok: false as const, code: "PATH_OUTSIDE_PROJECT", message: "Path must stay inside the selected project root." };
  }
  const denied = relativePath === "." ? null : matchesDeniedPath(relativePath, project);
  if (denied) return { ok: false as const, code: "DENIED_PATH", message: `Path is denied by project policy: ${denied}` };
  // Resolve the existing ancestor as well as existing files, including creation paths.
  try {
  let ancestor = absolutePath;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) return { ok: false as const, code: "BROKEN_SYMLINK", message: "Path includes an unresolved symbolic link." };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ancestor = dirname(ancestor);
  }
  const realPath = resolve(realpathSync(ancestor), relative(ancestor, absolutePath));
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realRelative = relative(realRoot, realPath);
  if (realRelative === ".." || realRelative.startsWith("../") || isAbsolute(realRelative)) {
    return { ok: false as const, code: "PATH_OUTSIDE_PROJECT", message: "Path resolves outside the selected project root." };
  }
  const realDenied = matchesDeniedPath(realRelative, project);
  if (realDenied) return { ok: false as const, code: "DENIED_PATH", message: `Path is denied by project policy: ${realDenied}` };
  if (!options?.allowDirectory && existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    return { ok: false as const, code: "IS_DIRECTORY", message: "Path is a directory." };
  }
  return { ok: true as const, root, absolutePath, relativePath: relativePath.replace(/\\/g, "/") };
  } catch (error) {
    return { ok: false as const, code: "PATH_RESOLUTION_FAILED", message: error instanceof Error ? error.message : String(error) };
  }
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}
