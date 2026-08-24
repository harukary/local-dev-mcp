import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, matchesDeniedPath, resolveProjectPath } from "./common.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const MAX_RG_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_ARTIFACT_EXCLUDES = ["generated/**", "logs/**", ".local-dev-mcp/**"];

type RgMatch = {
  type: "match";
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number?: number;
  };
};

function deniedGlobs(pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return [];
  if (normalized.includes("*") || normalized.includes("?")) return [normalized];
  return [normalized, `${normalized}/**`];
}

async function addContext(projectRoot: string, matches: Array<{ path: string; line: number; text: string }>, contextLines: number) {
  if (contextLines <= 0) return matches;
  const cache = new Map<string, string[] | null>();
  return await Promise.all(matches.map(async (match) => {
    let lines = cache.get(match.path);
    if (lines === undefined) {
      try {
        const absolutePath = join(projectRoot, match.path);
        const content = await readFile(absolutePath);
        lines = content.byteLength <= MAX_CONTEXT_FILE_BYTES ? content.toString("utf8").split(/\r?\n/) : null;
      } catch {
        lines = null;
      }
      cache.set(match.path, lines);
    }
    if (!lines) return match;
    const index = match.line - 1;
    return {
      ...match,
      before: lines.slice(Math.max(0, index - contextLines), index),
      after: lines.slice(index + 1, index + 1 + contextLines),
    };
  }));
}

export async function handleWorkspaceSearch(
  ctx: AppContext,
  chatContextId: string,
  args: {
    query?: string;
    path?: string;
    glob?: string;
    context_lines?: number;
    max_results?: number;
    regex?: boolean;
    case_sensitive?: boolean;
    include_hidden?: boolean;
    include_artifacts?: boolean;
  }
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const query = args?.query ?? "";
  if (!query) return jsonError("MISSING_QUERY", "workspace.search requires query.");

  const resolved = resolveProjectPath(project, args?.path, { allowDirectory: true });
  if (!resolved.ok) return jsonError(resolved.code, resolved.message);
  const contextLines = Math.min(Math.max(args?.context_lines ?? 0, 0), 5);
  const maxResults = Math.min(Math.max(args?.max_results ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS);

  const rgArgs = ["--json", "--no-messages"];
  if (args?.regex !== true) rgArgs.push("--fixed-strings");
  if (args?.case_sensitive === false) rgArgs.push("--ignore-case");
  if (args?.include_hidden === true) rgArgs.push("--hidden");
  if (args?.glob) rgArgs.push("--glob", args.glob);

  if (args?.include_artifacts !== true && resolved.relativePath === ".") {
    for (const pattern of DEFAULT_ARTIFACT_EXCLUDES) rgArgs.push("--glob", `!${pattern}`);
  }
  for (const denied of project.deniedPaths) {
    for (const pattern of deniedGlobs(denied)) rgArgs.push("--glob", `!${pattern}`);
  }

  rgArgs.push("--", query, resolved.relativePath === "." ? "." : resolved.relativePath);

  try {
    const { stdout } = await execFileAsync("rg", rgArgs, {
      cwd: project.hostRoot,
      encoding: "utf8",
      maxBuffer: MAX_RG_BUFFER_BYTES,
    });
    const rawMatches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = false;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      let event: RgMatch | { type?: string };
      try { event = JSON.parse(line) as RgMatch | { type?: string }; } catch { continue; }
      if (event.type !== "match") continue;
      const match = event as RgMatch;
      const rawPath = match.data.path.text;
      const lineNumber = match.data.line_number;
      if (!rawPath || !lineNumber) continue;
      const absolutePath = join(project.hostRoot, rawPath);
      const relativePath = relative(project.hostRoot, absolutePath).replace(/\\/g, "/");
      if (relativePath.startsWith("../") || matchesDeniedPath(relativePath, project)) continue;
      if (rawMatches.length >= maxResults) {
        truncated = true;
        break;
      }
      rawMatches.push({
        path: relativePath,
        line: lineNumber,
        text: (match.data.lines.text ?? "").replace(/\r?\n$/, ""),
      });
    }
    const matches = await addContext(project.hostRoot, rawMatches, contextLines);
    return jsonResult({ project_id: project.projectId, query, root: resolved.relativePath, matches, truncated, max_results: maxResults });
  } catch (err) {
    const failure = err as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (failure.code === 1 || (!failure.stdout && !failure.stderr && String(failure.message).includes("code 1"))) {
      return jsonResult({ project_id: project.projectId, query, root: resolved.relativePath, matches: [], truncated: false, max_results: maxResults });
    }
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
      return jsonError("RG_NOT_FOUND", "workspace.search requires ripgrep (rg) on PATH.");
    }
    return jsonError("SEARCH_FAILED", failure.stderr?.trim() || failure.message || String(err));
  }
}
