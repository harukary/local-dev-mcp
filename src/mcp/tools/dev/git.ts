import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, resolveProjectPath } from "./common.js";
import { git } from "./git-core.js";

const DIFF_MAX_BYTES = 512 * 1024;
const SHOW_MAX_BYTES = 512 * 1024;

type GitFileStatus = {
  status: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
};

type GitStatusSummary = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileStatus[];
};

function parsePorcelainV2(output: string): GitStatusSummary {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      head = oid === "(initial)" ? null : oid.slice(0, 12);
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    if (line.startsWith("? ")) {
      files.push({ status: "??", path: line.slice(2), staged: false, unstaged: true });
      continue;
    }
    if (line.startsWith("! ")) continue;

    const kind = line[0];
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const pathIndex = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    let path = parts.slice(pathIndex).join(" ");
    if (kind === "2") path = path.split("\t", 1)[0];
    files.push({
      status: xy.replace(/\./g, " "),
      path,
      staged: xy[0] !== ".",
      unstaged: xy[1] !== ".",
    });
  }

  return { branch, head, upstream, ahead, behind, clean: files.length === 0, files };
}

async function readStatus(project: Parameters<typeof git>[0], includeUntracked = true): Promise<GitStatusSummary> {
  const args = ["status", "--porcelain=v2", "--branch", includeUntracked ? "--untracked-files=all" : "--untracked-files=no"];
  const { stdout } = await git(project, args);
  return parsePorcelainV2(String(stdout));
}

function validateRef(ref: string | undefined): string | null {
  const value = ref?.trim() || "HEAD";
  if (value.startsWith("-")) return null;
  return value;
}

function parseLog(output: string) {
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", short = "", author = "", authoredAt = "", subject = ""] = record.split("\x1f");
      return { sha, short, author, authored_at: authoredAt, subject };
    });
}

function parseWorktrees(output: string) {
  return output
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const result: Record<string, unknown> = {};
      for (const line of block.split(/\r?\n/)) {
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") result.path = value;
        else if (key === "HEAD") result.head = value.slice(0, 12);
        else if (key === "branch") result.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "detached") result.detached = true;
        else if (key === "bare") result.bare = true;
        else if (key === "locked") result.locked = value || true;
      }
      return result;
    });
}

export async function handleGitStatus(ctx: AppContext, chatContextId: string, args: { include_untracked?: boolean }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  try {
    const status = await readStatus(project, args?.include_untracked !== false);
    return jsonResult({ project_id: project.projectId, ...status });
  } catch (err) {
    return jsonError("GIT_STATUS_FAILED", err instanceof Error ? err.message : String(err));
  }
}

export async function handleGitInspect(
  ctx: AppContext,
  chatContextId: string,
  args: { include_untracked?: boolean; recent_commits?: number; include_worktrees?: boolean; include_diff_stat?: boolean } = {}
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const recentCommits = Math.min(Math.max(args.recent_commits ?? 5, 0), 20);
  try {
    const statusPromise = readStatus(project, args.include_untracked !== false);
    const logPromise = recentCommits > 0
      ? git(project, ["log", `-n${recentCommits}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"])
      : Promise.resolve({ stdout: "", stderr: "" });
    const worktreesPromise = args.include_worktrees === false
      ? Promise.resolve({ stdout: "", stderr: "" })
      : git(project, ["worktree", "list", "--porcelain"]);
    const diffStatPromise = args.include_diff_stat === false
      ? Promise.resolve({ stdout: "", stderr: "" })
      : git(project, ["diff", "--stat"]);

    const [status, logResult, worktreeResult, diffStatResult] = await Promise.all([
      statusPromise,
      logPromise,
      worktreesPromise,
      diffStatPromise,
    ]);

    return jsonResult({
      project_id: project.projectId,
      ...status,
      recent_commits: parseLog(String(logResult.stdout)),
      worktrees: args.include_worktrees === false ? undefined : parseWorktrees(String(worktreeResult.stdout)),
      diff_stat: args.include_diff_stat === false ? undefined : String(diffStatResult.stdout).trim(),
    });
  } catch (err) {
    return jsonError("GIT_INSPECT_FAILED", err instanceof Error ? err.message : String(err));
  }
}

export async function handleGitLog(
  ctx: AppContext,
  chatContextId: string,
  args: { ref?: string; path?: string; limit?: number } = {}
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const ref = validateRef(args.ref);
  if (!ref) return jsonError("INVALID_GIT_REF", "Git ref must not start with '-'.");
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const gitArgs = ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e", ref];
  if (args.path) {
    const resolved = resolveProjectPath(project, args.path);
    if (!resolved.ok) return jsonError(resolved.code, resolved.message);
    gitArgs.push("--", resolved.relativePath);
  }
  try {
    const { stdout } = await git(project, gitArgs);
    return jsonResult({ project_id: project.projectId, ref, path: args.path, commits: parseLog(String(stdout)) });
  } catch (err) {
    return jsonError("GIT_LOG_FAILED", err instanceof Error ? err.message : String(err));
  }
}

export async function handleGitShow(
  ctx: AppContext,
  chatContextId: string,
  args: { ref?: string; path?: string; mode?: "patch" | "stat" | "name-status"; max_bytes?: number } = {}
) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const ref = validateRef(args.ref);
  if (!ref) return jsonError("INVALID_GIT_REF", "Git ref must not start with '-'.");
  const mode = args.mode ?? "patch";
  const gitArgs = ["show", "--no-ext-diff"];
  if (mode === "stat") gitArgs.push("--stat", "--oneline");
  else if (mode === "name-status") gitArgs.push("--name-status", "--oneline");
  gitArgs.push(ref);
  let path: string | undefined;
  if (args.path) {
    const resolved = resolveProjectPath(project, args.path);
    if (!resolved.ok) return jsonError(resolved.code, resolved.message);
    path = resolved.relativePath;
    gitArgs.push("--", path);
  }
  try {
    const { stdout } = await git(project, gitArgs);
    const text = String(stdout);
    const max = Math.min(Math.max(args.max_bytes ?? SHOW_MAX_BYTES, 1024), 2 * 1024 * 1024);
    return jsonResult({
      project_id: project.projectId,
      ref,
      path,
      mode,
      output: text.slice(0, max),
      truncated: text.length > max,
    });
  } catch (err) {
    return jsonError("GIT_SHOW_FAILED", err instanceof Error ? err.message : String(err));
  }
}

export async function handleGitDiff(ctx: AppContext, chatContextId: string, args: { path?: string; staged?: boolean; stat?: boolean; max_bytes?: number }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  try {
    const gitArgs = ["diff"];
    if (args?.staged) gitArgs.push("--staged");
    if (args?.stat) gitArgs.push("--stat");
    if (args?.path) {
      const resolved = resolveProjectPath(project, args.path);
      if (!resolved.ok) return jsonError(resolved.code, resolved.message);
      gitArgs.push("--", resolved.relativePath);
    }
    const { stdout } = await git(project, gitArgs);
    const max = Math.min(Math.max(args?.max_bytes ?? DIFF_MAX_BYTES, 1024), 2 * 1024 * 1024);
    return jsonResult({ project_id: project.projectId, diff: String(stdout).slice(0, max), truncated: String(stdout).length > max });
  } catch (err) {
    return jsonError("GIT_DIFF_FAILED", err instanceof Error ? err.message : String(err));
  }
}
