import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AppContext } from "../../server.js";
import { getActiveProject, jsonError, jsonResult, resolveProjectPath } from "./common.js";
import { git, boundedGit } from "./git-core.js";

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

  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const line = records[index];
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
    if (kind === "2") index++;
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
  const args = ["status", "--porcelain=v2", "-z", "--branch", includeUntracked ? "--untracked-files=all" : "--untracked-files=no"];
  const { stdout } = await git(project, args);
  return parsePorcelainV2(String(stdout));
}

async function readStagedSnapshot(project: Parameters<typeof git>[0]) {
  const { stdout } = await git(project, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z"]);
  const raw = String(stdout);
  const { stdout: namesOut } = await git(project, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  const paths = String(namesOut).split("\0").filter(Boolean);
  return {
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    paths,
    empty: paths.length === 0,
  };
}

async function hasGitOperationState(project: Parameters<typeof git>[0]) {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const { stdout } = await git(project, ["rev-parse", "--git-path", marker]);
    const candidate = String(stdout).trim();
    if (!candidate) continue;
    const absolute = isAbsolute(candidate) ? candidate : resolve(project.hostRoot, candidate);
    if (existsSync(absolute)) return marker;
  }
  return null;
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
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const result: Record<string, unknown> = {};
      for (const line of block.split("\0")) {
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
    const [status, staged] = await Promise.all([
      readStatus(project, args?.include_untracked !== false),
      readStagedSnapshot(project),
    ]);
    return jsonResult({ project_id: project.projectId, ...status, staged_fingerprint: staged.fingerprint, staged_paths: staged.paths });
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
    const logPromise = statusPromise.then(status => recentCommits > 0 && status.head
      ? git(project, ["log", `-n${recentCommits}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"])
      : { stdout: "", stderr: "" });
    const worktreesPromise = args.include_worktrees === false
      ? Promise.resolve({ stdout: "", stderr: "" })
      : git(project, ["worktree", "list", "--porcelain", "-z"]);
    const diffStatPromise = args.include_diff_stat === false
      ? Promise.resolve({ stdout: "", stderr: "" })
      : git(project, ["diff", "--stat"]);

    const stagedPromise = readStagedSnapshot(project);
    const [status, logResult, worktreeResult, diffStatResult, staged] = await Promise.all([
      statusPromise,
      logPromise,
      worktreesPromise,
      diffStatPromise,
      stagedPromise,
    ]);

    return jsonResult({
      project_id: project.projectId,
      ...status,
      staged_fingerprint: staged.fingerprint,
      staged_paths: staged.paths,
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
    const max = Math.min(Math.max(args.max_bytes ?? SHOW_MAX_BYTES, 1024), 2 * 1024 * 1024);
    const bounded = await boundedGit(project, gitArgs, max);
    return jsonResult({
      project_id: project.projectId,
      ref,
      path,
      mode,
      ...bounded,
    });
  } catch (err) {
    return jsonError("GIT_SHOW_FAILED", err instanceof Error ? err.message : String(err));
  }
}

export async function handleGitDiff(ctx: AppContext, chatContextId: string, args: { path?: string; staged?: boolean; stat?: boolean; max_bytes?: number }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  try {
    const gitArgs = ["diff", "--no-ext-diff"];
    if (args?.staged) gitArgs.push("--staged");
    if (args?.stat) gitArgs.push("--stat");
    if (args?.path) {
      const resolved = resolveProjectPath(project, args.path);
      if (!resolved.ok) return jsonError(resolved.code, resolved.message);
      gitArgs.push("--", resolved.relativePath);
    }
    const max = Math.min(Math.max(args?.max_bytes ?? DIFF_MAX_BYTES, 1024), 2 * 1024 * 1024);
    const bounded = await boundedGit(project, gitArgs, max);
    return jsonResult({ project_id: project.projectId, diff: bounded.output, truncated: bounded.truncated });
  } catch (err) {
    return jsonError("GIT_DIFF_FAILED", err instanceof Error ? err.message : String(err));
  }
}

export async function handleGitCommit(ctx: AppContext, chatContextId: string, args: { expected_head?: string; expected_staged_fingerprint?: string; message?: string }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  const expectedHead = args.expected_head?.trim();
  const expectedFingerprint = args.expected_staged_fingerprint?.trim().toLowerCase();
  const message = args.message?.trim();
  if (!expectedHead || !/^[0-9a-f]{7,64}$/i.test(expectedHead)) {
    return jsonError("GIT_COMMIT_EXPECTED_HEAD_REQUIRED", "expected_head must be a 7-64 character hexadecimal commit SHA or abbreviation.");
  }
  if (!expectedFingerprint || !/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
    return jsonError("GIT_COMMIT_STAGED_FINGERPRINT_REQUIRED", "expected_staged_fingerprint must be the 64-character SHA-256 returned by git.status or git.inspect.");
  }
  if (!message || message.length > 200 || /[\r\n\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message)) {
    return jsonError("GIT_COMMIT_INVALID_MESSAGE", "message must be a non-empty single line of at most 200 characters without control characters.");
  }

  try {
    const status = await readStatus(project, true);
    if (!status.branch) return jsonError("GIT_COMMIT_DETACHED_HEAD", "git.commit requires a checked-out branch; detached HEAD is not supported.");
    const operation = await hasGitOperationState(project);
    if (operation) return jsonError("GIT_COMMIT_OPERATION_IN_PROGRESS", `Refusing to commit while Git operation state ${operation} is present.`);

    const [{ stdout: localHeadOut }, { stdout: expectedResolvedOut }, { stdout: unmergedOut }, staged] = await Promise.all([
      git(project, ["rev-parse", "HEAD"]),
      git(project, ["rev-parse", "--verify", `${expectedHead}^{commit}`]),
      git(project, ["diff", "--name-only", "--diff-filter=U", "-z"]),
      readStagedSnapshot(project),
    ]);
    const localHead = String(localHeadOut).trim().toLowerCase();
    const expectedResolved = String(expectedResolvedOut).trim().toLowerCase();
    if (expectedResolved !== localHead) {
      return jsonError("GIT_COMMIT_HEAD_MISMATCH", "expected_head does not resolve to the current local HEAD; refusing to commit on a changed base.", {
        expected_head: expectedResolved,
        actual_head: localHead,
      });
    }
    if (String(unmergedOut).length > 0) return jsonError("GIT_COMMIT_UNMERGED", "Refusing to commit while unresolved merge entries are present.");
    if (staged.empty) return jsonError("GIT_COMMIT_NOTHING_STAGED", "There are no staged changes to commit.");
    if (staged.fingerprint !== expectedFingerprint) {
      return jsonError("GIT_COMMIT_STAGED_MISMATCH", "The staged snapshot changed since it was inspected; refusing to commit.", {
        expected_staged_fingerprint: expectedFingerprint,
        actual_staged_fingerprint: staged.fingerprint,
        staged_paths: staged.paths,
      });
    }

    const startedAt = Date.now();
    try {
      const committed = await git(project, ["commit", "--no-gpg-sign", "-m", message]);
      const { stdout: newHeadOut } = await git(project, ["rev-parse", "HEAD"]);
      const newHead = String(newHeadOut).trim().toLowerCase();
      const { stdout: committedRawOut } = await git(project, ["diff", "--raw", "--no-abbrev", "--no-renames", "-z", localHead, newHead]);
      const committedFingerprint = createHash("sha256").update(String(committedRawOut)).digest("hex");
      const verified = newHead !== localHead && committedFingerprint === expectedFingerprint;
      const after = await readStatus(project, true);
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "git.commit",
        event: verified ? "git_commit_succeeded" : "git_commit_verification_failed",
        projectId: project.projectId,
        cwd: project.hostRoot,
        command: `git commit <verified-staged-snapshot>`,
        riskLevel: "workspace_write",
        enforcement: "audit_only",
        exitCode: verified ? 0 : 1,
        durationMs: Date.now() - startedAt,
        error: verified ? undefined : "Committed tree did not match the verified staged snapshot.",
      });
      if (!verified) {
        return jsonError("GIT_COMMIT_VERIFY_FAILED", "Git created a commit, but its diff did not match the verified staged snapshot. Review the repository before continuing.", {
          previous_head: localHead,
          new_head: newHead,
          expected_staged_fingerprint: expectedFingerprint,
          committed_fingerprint: committedFingerprint,
        });
      }
      return jsonResult({
        project_id: project.projectId,
        status: "committed",
        branch: status.branch,
        previous_head: localHead,
        head: newHead,
        staged_fingerprint: expectedFingerprint,
        committed_paths: staged.paths,
        remaining_files: after.files,
        commit_output: `${String(committed.stdout)}${String(committed.stderr)}`.trim().slice(0, 8192),
        verified: true,
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "git.commit",
        event: "git_commit_failed",
        projectId: project.projectId,
        cwd: project.hostRoot,
        command: `git commit <verified-staged-snapshot>`,
        riskLevel: "workspace_write",
        enforcement: "audit_only",
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        error: messageText,
      });
      return jsonError("GIT_COMMIT_FAILED", messageText, {
        branch: status.branch,
        head: localHead,
        staged_fingerprint: staged.fingerprint,
        staged_paths: staged.paths,
      });
    }
  } catch (err) {
    return jsonError("GIT_COMMIT_PREFLIGHT_FAILED", err instanceof Error ? err.message : String(err));
  }
}

function parseRemoteHead(output: string): string | null {
  const line = output.trim().split("\n").find(Boolean);
  const sha = line?.split(/\s+/)[0];
  return sha && /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

export async function handleGitPush(ctx: AppContext, chatContextId: string, args: { expected_head?: string }) {
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;

  const expectedHead = args.expected_head?.trim();
  if (!expectedHead || !/^[0-9a-f]{7,64}$/i.test(expectedHead)) {
    return jsonError("GIT_PUSH_EXPECTED_HEAD_REQUIRED", "expected_head must be a 7-64 character hexadecimal commit SHA or abbreviation.");
  }

  try {
    const status = await readStatus(project, false);
    if (!status.branch) return jsonError("GIT_PUSH_DETACHED_HEAD", "git.push requires a checked-out branch; detached HEAD is not supported.");
    if (!status.upstream) return jsonError("GIT_PUSH_NO_UPSTREAM", "The current branch has no configured upstream. Configure it explicitly before using git.push.");
    if (status.behind > 0) {
      return jsonError("GIT_PUSH_REMOTE_AHEAD", "The configured upstream contains commits not present locally. Fetch/reconcile before pushing.", {
        branch: status.branch,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
      });
    }

    const [{ stdout: localHeadOut }, { stdout: expectedResolvedOut }, { stdout: remotesOut }] = await Promise.all([
      git(project, ["rev-parse", "HEAD"]),
      git(project, ["rev-parse", "--verify", `${expectedHead}^{commit}`]),
      git(project, ["remote"]),
    ]);
    const localHead = String(localHeadOut).trim().toLowerCase();
    const expectedResolved = String(expectedResolvedOut).trim().toLowerCase();
    if (expectedResolved !== localHead) {
      return jsonError("GIT_PUSH_HEAD_MISMATCH", "expected_head does not resolve to the current local HEAD; refusing to push a different commit.", {
        expected_head: expectedResolved,
        actual_head: localHead,
      });
    }

    const remotes = String(remotesOut).split("\n").map((value) => value.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    const remote = remotes.find((candidate) => status.upstream === candidate || status.upstream?.startsWith(`${candidate}/`));
    if (!remote || status.upstream === remote) {
      return jsonError("GIT_PUSH_INVALID_UPSTREAM", `Could not resolve configured upstream ${status.upstream} to a remote branch.`);
    }
    const remoteBranch = status.upstream.slice(remote.length + 1);
    if (!remoteBranch || remoteBranch.startsWith("-") || remoteBranch.includes("..")) {
      return jsonError("GIT_PUSH_INVALID_UPSTREAM", `Configured upstream branch is not safe to push: ${status.upstream}.`);
    }
    const remoteRef = `refs/heads/${remoteBranch}`;

    if (status.ahead === 0) {
      const { stdout: remoteOut } = await git(project, ["ls-remote", remote, remoteRef]);
      const remoteHead = parseRemoteHead(String(remoteOut));
      const verified = remoteHead === localHead;
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "git.push",
        event: "git_push_noop",
        projectId: project.projectId,
        cwd: project.hostRoot,
        command: `git push ${remote} HEAD:${remoteRef}`,
        riskLevel: "network_or_dependency",
        enforcement: "audit_only",
        exitCode: verified ? 0 : 1,
        error: verified ? undefined : "Configured upstream is not ahead locally but remote HEAD does not match local HEAD.",
      });
      if (!verified) {
        return jsonError("GIT_PUSH_REMOTE_MISMATCH", "Local status reported no commits ahead, but the remote branch HEAD does not match local HEAD. Fetch before retrying.", {
          branch: status.branch,
          upstream: status.upstream,
          local_head: localHead,
          remote_head: remoteHead,
        });
      }
      return jsonResult({
        project_id: project.projectId,
        status: "up_to_date",
        branch: status.branch,
        upstream: status.upstream,
        head: localHead,
        remote_head: remoteHead,
        pushed: false,
        verified: true,
      });
    }

    const startedAt = Date.now();
    try {
      const pushed = await git(project, ["push", "--porcelain", remote, `HEAD:${remoteRef}`]);
      const { stdout: remoteOut } = await git(project, ["ls-remote", remote, remoteRef]);
      const remoteHead = parseRemoteHead(String(remoteOut));
      const verified = remoteHead === localHead;
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "git.push",
        event: verified ? "git_push_succeeded" : "git_push_verification_failed",
        projectId: project.projectId,
        cwd: project.hostRoot,
        command: `git push ${remote} HEAD:${remoteRef}`,
        riskLevel: "network_or_dependency",
        enforcement: "audit_only",
        exitCode: verified ? 0 : 1,
        durationMs: Date.now() - startedAt,
        error: verified ? undefined : "Remote HEAD did not match the pushed local HEAD during read-back.",
      });
      if (!verified) {
        return jsonError("GIT_PUSH_VERIFY_FAILED", "Push returned successfully but remote HEAD verification did not match local HEAD.", {
          branch: status.branch,
          upstream: status.upstream,
          local_head: localHead,
          remote_head: remoteHead,
        });
      }
      return jsonResult({
        project_id: project.projectId,
        status: "pushed",
        branch: status.branch,
        upstream: status.upstream,
        head: localHead,
        remote_head: remoteHead,
        ahead_before: status.ahead,
        pushed: true,
        verified: true,
        git_output: `${String(pushed.stdout)}${String(pushed.stderr)}`.trim().slice(0, 8192),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "git.push",
        event: "git_push_failed",
        projectId: project.projectId,
        cwd: project.hostRoot,
        command: `git push ${remote} HEAD:${remoteRef}`,
        riskLevel: "network_or_dependency",
        enforcement: "audit_only",
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return jsonError("GIT_PUSH_FAILED", message, {
        branch: status.branch,
        upstream: status.upstream,
        head: localHead,
        ahead_before: status.ahead,
      });
    }
  } catch (err) {
    return jsonError("GIT_PUSH_PREFLIGHT_FAILED", err instanceof Error ? err.message : String(err));
  }
}
