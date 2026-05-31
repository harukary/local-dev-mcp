import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import type { AppContext } from "../../server.js";
import type { ProjectConfig } from "../../../types.js";

export function jsonResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function jsonError(code: string, message: string, details?: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
    isError: true,
  };
}

export function getActiveProject(ctx: AppContext, chatContextId: string): ProjectConfig | { error: ReturnType<typeof jsonError> } {
  const store = ctx.contextStore as {
    getActiveProject?: (chatContextId: string, isAvailable: (projectId: string) => boolean) => string | undefined;
    getCurrentProject?: (chatContextId: string) => string | undefined;
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
  return project;
}

function simpleGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesDeniedPath(relativePath: string, project: ProjectConfig): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const raw of project.deniedPaths) {
    const pattern = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized === pattern || normalized.startsWith(`${pattern}/`)) return raw;
    if ((pattern.includes("*") || pattern.includes("?")) && simpleGlobToRegExp(pattern).test(normalized)) return raw;
  }
  return null;
}

export function includeByGlob(relativePath: string, glob?: string): boolean {
  if (!glob) return true;
  return simpleGlobToRegExp(glob.replace(/^\.\//, "")).test(relativePath.replace(/\\/g, "/"));
}

export function resolveProjectPath(project: ProjectConfig, inputPath?: string, options?: { allowDirectory?: boolean }) {
  const root = resolve(project.hostRoot);
  const raw = inputPath && inputPath.trim() ? inputPath : ".";
  const absolutePath = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const relativePath = relative(root, absolutePath) || ".";
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return { ok: false as const, code: "PATH_OUTSIDE_PROJECT", message: "Path must stay inside the selected project root." };
  }
  const denied = relativePath === "." ? null : matchesDeniedPath(relativePath, project);
  if (denied) return { ok: false as const, code: "DENIED_PATH", message: `Path is denied by project policy: ${denied}` };
  if (!options?.allowDirectory && existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    return { ok: false as const, code: "IS_DIRECTORY", message: "Path is a directory." };
  }
  return { ok: true as const, root, absolutePath, relativePath: relativePath.replace(/\\/g, "/") };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}
