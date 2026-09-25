import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleGitInspect, handleGitLog, handleGitPush, handleGitShow, handleGitStatus } from "../../src/mcp/tools/dev/git.js";

let root = "";
let remoteRoot = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  root = "";
  remoteRoot = "";
});

function run(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function setupRepo() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-mcp-git-")));
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test User");
  run("checkout", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  run("add", "a.txt");
  run("commit", "-q", "-m", "initial");
}

function setupUpstream() {
  remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-mcp-git-remote-")));
  execFileSync("git", ["init", "--bare", "-q", remoteRoot]);
  run("remote", "add", "origin", remoteRoot);
  run("push", "-q", "-u", "origin", "main");
}

function context(): AppContext {
  const project: ProjectConfig = {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot: root,
    sandboxRoot: root,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths: [".env", "secrets"],
    redactionProfile: "default",
  };
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", "alpha");
  return {
    registry: {
      get: (id: string) => id === "alpha" ? project : undefined,
      has: (id: string) => id === "alpha",
      getAll: () => [project],
    },
    contextStore,
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function body(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("typed git tools", () => {
  it("inspects an unborn repository and preserves unusual filenames", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-mcp-git-")));
    run("init", "-q");
    const filename = "space and\ttab\nnewline.txt";
    writeFileSync(join(root, filename), "text");
    const value = body(await handleGitInspect(context(), "chat-a", {}));
    expect(value.recent_commits).toEqual([]);
    expect(value.files).toContainEqual(expect.objectContaining({ path: filename }));
  });
  it("returns status with one porcelain-v2 read", async () => {
    setupRepo();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "b.txt"), "new\n");

    const result = await handleGitStatus(context(), "chat-a", {});
    const value = body(result);

    expect(value).toMatchObject({ branch: "main", clean: false, ahead: 0, behind: 0 });
    expect(value.head).toMatch(/^[0-9a-f]{12}$/);
    expect(value.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "a.txt", staged: false, unstaged: true }),
      expect.objectContaining({ path: "b.txt", status: "??", staged: false, unstaged: true }),
    ]));
    expect(result.structuredContent).toMatchObject({ branch: "main" });
  });

  it("combines repository state, history, worktrees, and diff stat", async () => {
    setupRepo();
    writeFileSync(join(root, "a.txt"), "changed\n");

    const value = body(await handleGitInspect(context(), "chat-a", { recent_commits: 3 }));

    expect(value.branch).toBe("main");
    expect(value.recent_commits).toHaveLength(1);
    expect(value.recent_commits[0]).toMatchObject({ author: "Test User", subject: "initial" });
    expect(value.worktrees[0]).toMatchObject({ path: root, branch: "main" });
    expect(value.diff_stat).toContain("a.txt");
  });

  it("preserves newlines in worktree paths", async () => {
    setupRepo();
    const worktree = join(root, "nested\nworktree");
    run("worktree", "add", "--detach", worktree, "HEAD");
    const value = body(await handleGitInspect(context(), "chat-a", { include_diff_stat: false }));
    expect(value.worktrees).toContainEqual(expect.objectContaining({ path: worktree, detached: true }));
  });

  it("returns bounded log and show output without shell composition", async () => {
    setupRepo();
    writeFileSync(join(root, "a.txt"), "two\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "second");

    const log = body(await handleGitLog(context(), "chat-a", { path: "a.txt", limit: 1 }));
    expect(log.commits).toHaveLength(1);
    expect(log.commits[0].subject).toBe("second");

    const shown = body(await handleGitShow(context(), "chat-a", { ref: "HEAD", mode: "stat" }));
    expect(shown.mode).toBe("stat");
    expect(shown.output).toContain("a.txt");
    expect(shown.truncated).toBe(false);
  });

  it("pushes only the current HEAD to its configured upstream and verifies the remote", async () => {
    setupRepo();
    setupUpstream();
    writeFileSync(join(root, "a.txt"), "two\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "second");
    const head = run("rev-parse", "HEAD").trim();
    const ctx = context();

    const pushed = body(await handleGitPush(ctx, "chat-a", { expected_head: head.slice(0, 12) }));
    expect(pushed).toMatchObject({ status: "pushed", branch: "main", upstream: "origin/main", head, remote_head: head, pushed: true, verified: true, ahead_before: 1 });
    expect(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: remoteRoot, encoding: "utf8" }).trim()).toBe(head);
    expect(ctx.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ tool: "git.push", event: "git_push_succeeded", exitCode: 0 }));

    const noop = body(await handleGitPush(ctx, "chat-a", { expected_head: head }));
    expect(noop).toMatchObject({ status: "up_to_date", pushed: false, verified: true, head, remote_head: head });
    expect(ctx.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ tool: "git.push", event: "git_push_noop", exitCode: 0 }));
  });

  it("rejects a stale expected HEAD before pushing", async () => {
    setupRepo();
    setupUpstream();
    const oldHead = run("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "two\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "second");

    const result = body(await handleGitPush(context(), "chat-a", { expected_head: oldHead }));
    expect(result.error).toMatchObject({ code: "GIT_PUSH_HEAD_MISMATCH" });
    expect(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: remoteRoot, encoding: "utf8" }).trim()).toBe(oldHead);
  });

  it("rejects repositories without a configured upstream", async () => {
    setupRepo();
    const head = run("rev-parse", "HEAD").trim();
    const result = body(await handleGitPush(context(), "chat-a", { expected_head: head }));
    expect(result.error).toMatchObject({ code: "GIT_PUSH_NO_UPSTREAM" });
  });
});
