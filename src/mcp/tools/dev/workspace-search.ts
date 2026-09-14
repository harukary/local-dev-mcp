import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { utf8Prefix } from "../../output.js";
import { requestSignal } from "../../request-context.js";
import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, matchesDeniedPath, resolveProjectPath } from "./common.js";

const DEFAULT_MAX_RESULTS = 50;
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
  const cache = new Map<string, Promise<string[] | null>>();
  let remainingContextBytes = 16 * 1024 * 1024;
  return await Promise.all(matches.map(async (match) => {
    if (!cache.has(match.path)) {
      const pending = (async () => { try {
        const absolutePath = join(projectRoot, match.path);
        const size = (await stat(absolutePath)).size;
        if (size > MAX_CONTEXT_FILE_BYTES || size > remainingContextBytes) return null;
        remainingContextBytes -= size;
        const content = await readFile(absolutePath);
        return content.byteLength <= MAX_CONTEXT_FILE_BYTES ? content.toString("utf8").split(/\r?\n/) : null;
      } catch { return null; } })();
      cache.set(match.path, pending);
    }
    const lines = await cache.get(match.path);
    if (!lines) return match;
    const index = match.line - 1;
    return {
      ...match,
      before: lines.slice(Math.max(0, index - contextLines), index).map(line => utf8Prefix(line, 2048)),
      after: lines.slice(index + 1, index + 1 + contextLines).map(line => utf8Prefix(line, 2048)),
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
    offset?: number;
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

  const offset = Math.min(100_000, Math.max(0, args?.offset ?? 0));
  const rgArgs = ["--json", "--no-messages", "--sort", "path"];
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
    const signal = requestSignal();
    signal?.throwIfAborted();
    const child = spawn("rg", rgArgs, {
      cwd: project.hostRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error: Error | undefined;
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = utf8Prefix(stderr + chunk.toString(), 4096); });
    const closed = new Promise<number | null>(resolve => {
      child.once("error", err => { error = err; resolve(null); });
      child.once("close", resolve);
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    const cancel = () => { child.kill("SIGKILL"); };
    signal?.addEventListener("abort", cancel, { once: true });
    const rawMatches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = false;
    let streamedBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_RG_BUFFER_BYTES) { truncated = true; child.kill("SIGKILL"); }
    });
    let seen = 0;
    let bytes = 0;
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let code: number | null = null;
    try { for await (const line of reader) {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_RG_BUFFER_BYTES) { truncated = true; child.kill("SIGKILL"); break; }
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
      if (seen++ < offset) continue;
      if (rawMatches.length >= maxResults) {
        truncated = true;
        child.kill("SIGKILL");
        break;
      }
      rawMatches.push({
        path: relativePath,
        line: lineNumber,
        text: utf8Prefix((match.data.lines.text ?? "").replace(/\r?\n$/, ""), 4096),
      });
    } } catch (error) { child.kill("SIGKILL"); throw error; }
    finally {
      reader.close();
      child.stdout.resume();
      code = await closed;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    if (error) throw error;
    if (signal?.aborted) return jsonError("REQUEST_CANCELED", "Search canceled.");
    if (timedOut) return jsonError("SEARCH_TIMEOUT", "Search exceeded 30 seconds; narrow path or glob.");
    if (!truncated && code !== 0 && code !== 1) return jsonError("SEARCH_FAILED", stderr || `ripgrep exited with ${code}`);
    const matches = await addContext(project.hostRoot, rawMatches, contextLines);
    return jsonResult({ project_id: project.projectId, query, root: resolved.relativePath, matches, truncated, max_results: maxResults, offset, next_offset: truncated && matches.length ? offset + matches.length : null, line_preview_max_bytes: 4096, context_preview_max_bytes: 2048 });
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
