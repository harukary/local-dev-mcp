import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AppContext } from "../../server.js";
import type { ProjectConfig } from "../../../types.js";
import { getActiveProject, includeByGlob, jsonError, jsonResult, matchesDeniedPath, resolveProjectPath } from "./common.js";

const DEFAULT_EXCLUDES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const DEFAULT_ARTIFACT_EXCLUDES = new Set(["generated", "logs", ".local-dev-mcp"]);
const DEFAULT_MAX_ENTRIES = 500;
const MAX_ENTRIES = 5000;

type Entry = { path: string; type: string; size?: number };
type WalkOptions = {
  depth: number;
  includeHidden: boolean;
  includeArtifacts: boolean;
  glob?: string;
  maxEntries: number;
};

async function walk(root: string, dir: string, project: ProjectConfig, options: WalkOptions, out: Entry[]): Promise<boolean> {
  if (options.depth < 0 || out.length >= options.maxEntries) return out.length >= options.maxEntries;
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= options.maxEntries) return true;
    if (!options.includeHidden && entry.name.startsWith(".")) continue;
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;
    if (!options.includeArtifacts && DEFAULT_ARTIFACT_EXCLUDES.has(entry.name)) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
    if (matchesDeniedPath(relativePath, project)) continue;
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    if (includeByGlob(relativePath, options.glob)) {
      const row: Entry = { path: relativePath, type };
      if (entry.isFile()) {
        try { row.size = (await stat(absolutePath)).size; } catch { /* ignore */ }
      }
      out.push(row);
      if (out.length >= options.maxEntries) return true;
    }
    if (entry.isDirectory()) {
      const truncated = await walk(root, absolutePath, project, { ...options, depth: options.depth - 1 }, out);
      if (truncated) return true;
    }
  }
  return false;
}

export async function handleWorkspaceList(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; depth?: number; glob?: string; include_hidden?: boolean; include_artifacts?: boolean; max_entries?: number }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  const resolved = resolveProjectPath(project, args?.path, { allowDirectory: true });
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);

  try {
    const targetStat = await stat(resolved.absolutePath);
    if (!targetStat.isDirectory()) return jsonError("NOT_DIRECTORY", "Path is not a directory.");
    const entries: Entry[] = [];
    const maxEntries = Math.min(Math.max(args?.max_entries ?? DEFAULT_MAX_ENTRIES, 1), MAX_ENTRIES);
    const truncated = await walk(resolved.root, resolved.absolutePath, project, {
      depth: Math.min(Math.max(args?.depth ?? 2, 0), 8),
      includeHidden: args?.include_hidden === true,
      includeArtifacts: args?.include_artifacts === true || resolved.relativePath !== ".",
      glob: args?.glob,
      maxEntries,
    }, entries);
    return jsonResult({ project_id: project.projectId, root: resolved.relativePath, entries, truncated, max_entries: maxEntries });
  } catch (err) {
    return jsonError("LIST_FAILED", err instanceof Error ? err.message : String(err));
  }
}
