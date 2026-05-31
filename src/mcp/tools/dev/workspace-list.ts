import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AppContext } from "../../server.js";
import type { ProjectConfig } from "../../../types.js";
import { getActiveProject, includeByGlob, jsonError, jsonResult, matchesDeniedPath, resolveProjectPath } from "./common.js";

const DEFAULT_EXCLUDES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);

type Entry = { path: string; type: string; size?: number };

async function walk(root: string, dir: string, project: ProjectConfig, options: { depth: number; includeHidden: boolean; glob?: string }, out: Entry[]) {
  if (options.depth < 0) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!options.includeHidden && entry.name.startsWith(".")) continue;
    if (DEFAULT_EXCLUDES.has(entry.name)) continue;
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
    }
    if (entry.isDirectory()) await walk(root, absolutePath, project, { ...options, depth: options.depth - 1 }, out);
  }
}

export async function handleWorkspaceList(
  ctx: AppContext,
  chatContextId: string,
  args: { path?: string; depth?: number; glob?: string; include_hidden?: boolean }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  const resolved = resolveProjectPath(project, args?.path, { allowDirectory: true });
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);

  try {
    const targetStat = await stat(resolved.absolutePath);
    if (!targetStat.isDirectory()) return jsonError("NOT_DIRECTORY", "Path is not a directory.");
    const entries: Entry[] = [];
    await walk(resolved.root, resolved.absolutePath, project, {
      depth: Math.min(Math.max(args?.depth ?? 2, 0), 8),
      includeHidden: args?.include_hidden === true,
      glob: args?.glob,
    }, entries);
    return jsonResult({ project_id: project.projectId, root: resolved.relativePath, entries, truncated: false });
  } catch (err) {
    return jsonError("LIST_FAILED", err instanceof Error ? err.message : String(err));
  }
}
