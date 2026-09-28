import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig, ShellRunInput } from "../../src/types.js";

vi.mock("../../src/shell/credential-env.js", () => ({
  resolveCredentialEnv: vi.fn(async () => ({
    BWS_ACCESS_TOKEN: "test-token",
    PATH: process.env.PATH ?? "",
  })),
}));

import { handlePagesDeploy } from "../../src/mcp/tools/dev/deploy.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

beforeEach(() => {
  vi.clearAllMocks();
});

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function setupRepo(options: { deployScript?: boolean } = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "local-dev-mcp-deploy-")));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  git("checkout", "-q", "-b", "main");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: options.deployScript === false ? {} : { "deploy:pages": "bash scripts/deploy-cloudflare-pages.sh" },
    }, null, 2)
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", "package.json", "pnpm-lock.yaml");
  git("commit", "-q", "-m", "initial");
}

function project(): ProjectConfig {
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot: root,
    sandboxRoot: root,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "allow",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths: [".env", "secrets"],
    redactionProfile: "default",
  };
}

function context(runImpl: (input: ShellRunInput) => Promise<Record<string, unknown>>): AppContext {
  const selectedProject = project();
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", selectedProject.projectId);
  return {
    registry: {
      get: (id: string) => id === selectedProject.projectId ? selectedProject : undefined,
      has: (id: string) => id === selectedProject.projectId,
      getAll: () => [selectedProject],
    },
    contextStore,
    shellRunner: {
      run: vi.fn(async (_project: ProjectConfig, input: ShellRunInput) => runImpl(input)),
    },
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function successResult(input: ShellRunInput, stdout: string) {
  return {
    projectId: "alpha",
    cwd: root,
    command: input.command,
    purpose: input.purpose,
    credentialScope: input.credentialScope,
    riskLevel: "network_or_dependency",
    exitCode: 0,
    timedOut: false,
    durationMs: 25,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    redactions: [],
  };
}

describe("typed Cloudflare Pages deploy tools", () => {
  it("runs only the fixed preflight command for the verified HEAD", async () => {
    setupRepo();
    const head = git("rev-parse", "HEAD").trim();
    const ctx = context(async (input) => successResult(input, "Cloudflare Pages deploy preflight passed\n"));

    const value = payload(await handlePagesDeploy(ctx, "chat-a", { expected_head: head }, "preflight"));

    expect(value).toMatchObject({
      status: "ready",
      project_id: "alpha",
      head,
      deploy_script: "deploy:pages",
      verified: true,
    });
    expect(ctx.shellRunner.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: "CI=1 pnpm run deploy:pages -- --preflight-only",
        credentialScope: "bitwarden",
      }),
      "chat-a"
    );
  });

  it("runs only the fixed production command and extracts the Pages deployment URL", async () => {
    setupRepo();
    const head = git("rev-parse", "HEAD").trim();
    const ctx = context(async (input) => successResult(
      input,
      "Deployment complete! Take a peek over at https://abc123.llm-pricing-b77.pages.dev\n"
    ));

    const value = payload(await handlePagesDeploy(ctx, "chat-a", { expected_head: head }, "production"));

    expect(value).toMatchObject({
      status: "deployed",
      head,
      deployment_url: "https://abc123.llm-pricing-b77.pages.dev",
      verified: true,
    });
    expect(ctx.shellRunner.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        command: "CI=1 pnpm run deploy:pages",
        credentialScope: "bitwarden",
      }),
      "chat-a"
    );
  });

  it("rejects a stale expected HEAD before resolving credentials or running deploy", async () => {
    setupRepo();
    const current = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "other.txt"), "next\n");
    git("add", "other.txt");
    git("commit", "-q", "-m", "next");
    const ctx = context(async (input) => successResult(input, ""));

    const result = await handlePagesDeploy(ctx, "chat-a", { expected_head: current }, "preflight");
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("HEAD_MISMATCH");
    expect(ctx.shellRunner.run).not.toHaveBeenCalled();
  });

  it("rejects projects without a deploy:pages script", async () => {
    setupRepo({ deployScript: false });
    const head = git("rev-parse", "HEAD").trim();
    const ctx = context(async (input) => successResult(input, ""));

    const result = await handlePagesDeploy(ctx, "chat-a", { expected_head: head }, "preflight");
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("DEPLOY_SCRIPT_MISSING");
    expect(ctx.shellRunner.run).not.toHaveBeenCalled();
  });
});
