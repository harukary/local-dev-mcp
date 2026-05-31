import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AppContext } from "../../server.js";
import { getActiveProject, isProbablyBinary, jsonError, jsonResult } from "./common.js";
import { handleWorkspaceList } from "./workspace-list.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 100;
const SKIP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".lockb"]);

type WorkspaceListResponse = {
  content?: Array<{ type: string; text?: string }>;
};

async function readTextFile(pathname: string): Promise<string | null> {
  const bytes = await readFile(pathname);
  if (bytes.byteLength > MAX_FILE_BYTES) return null;
  if (isProbablyBinary(bytes)) return null;
  return bytes.toString("utf8");
}

export async function handleWorkspaceSearch(
  ctx: AppContext,
  chatContextId: string,
  args: { query?: string; glob?: string; context_lines?: number; max_results?: number }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const query = args?.query ?? "";
  if (!query) return jsonError("MISSING_QUERY", "workspace.search requires query.");

  const listed = await handleWorkspaceList(ctx, chatContextId, { path: ".", depth: 20, glob: args?.glob });
  const text = (listed as WorkspaceListResponse).content?.[0]?.text;
  const parsed = text ? JSON.parse(text) as { entries?: Array<{ path: string; type: string; size?: number }> } : { entries: [] };
  const contextLines = Math.min(Math.max(args?.context_lines ?? 0, 0), 5);
  const maxResults = Math.min(Math.max(args?.max_results ?? DEFAULT_MAX_RESULTS, 1), 500);
  const matches: unknown[] = [];

  for (const entry of parsed.entries ?? []) {
    if (entry.type !== "file") continue;
    if ((entry.size ?? 0) > MAX_FILE_BYTES) continue;
    if (SKIP_EXTENSIONS.has(extname(entry.path).toLowerCase())) continue;
    try {
      const content = await readTextFile(join(project.hostRoot, entry.path));
      if (content == null) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        matches.push({
          path: entry.path,
          line: index + 1,
          text: lines[index],
          before: contextLines ? lines.slice(Math.max(0, index - contextLines), index) : undefined,
          after: contextLines ? lines.slice(index + 1, index + 1 + contextLines) : undefined,
        });
        if (matches.length >= maxResults) {
          return jsonResult({ project_id: project.projectId, query, matches, truncated: true });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return jsonResult({ project_id: project.projectId, query, matches, truncated: false });
}
