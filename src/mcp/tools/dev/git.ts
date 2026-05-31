import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, resolveProjectPath } from "./common.js";
import { git } from "./git-core.js";

const DIFF_MAX_BYTES = 512 * 1024;

export async function handleGitStatus(ctx: AppContext, chatContextId: string, args: { include_untracked?: boolean }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  try {
    const [{ stdout: branchOut }, { stdout: headOut }, { stdout: statusOut }] = await Promise.all([
      git(project, ["branch", "--show-current"]),
      git(project, ["rev-parse", "--short", "HEAD"]),
      git(project, ["status", "--porcelain=v1", args?.include_untracked === false ? "--untracked-files=no" : "--untracked-files=all"]),
    ]);
    const statusText = String(statusOut);
    const branchText = String(branchOut);
    const headText = String(headOut);
    const files = statusText.split(/\r?\n/).filter(Boolean).map((line: string) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim(),
      staged: line[0] !== " " && line[0] !== "?",
      unstaged: line[1] !== " " || line[0] === "?",
    }));
    return jsonResult({ project_id: project.projectId, branch: branchText.trim() || null, head: headText.trim() || null, clean: files.length === 0, files });
  } catch (err) {
    return jsonError("GIT_STATUS_FAILED", err instanceof Error ? err.message : String(err));
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
