import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleRepoActionList, handleRepoActionRead, handleRepoActionWrite } from "../../src/mcp/tools/repo-action.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { resolveCredentialEnv } from "../../src/shell/credential-env.js";

vi.mock("../../src/shell/credential-env.js", () => ({
  resolveCredentialEnv: vi.fn(async () => ({ BWS_ACCESS_TOKEN: "test-only-token" })),
}));

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function createProject(hostRoot: string, writePolicy: ProjectConfig["writePolicy"] = "allow"): ProjectConfig {
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "allow",
    writePolicy,
    approvalMode: "catastrophic_only",
    deniedPaths: [".env", "secrets"],
    redactionProfile: "default",
  };
}

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);
  const result = (command: string, purpose?: string) => ({
    projectId: project.projectId,
    cwd: project.hostRoot,
    command,
    purpose,
    riskLevel: "read_only",
    exitCode: 0,
    timedOut: false,
    durationMs: 3,
    stdout: "ok\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    redactions: [],
  });
  const shellRunner = {
    run: vi.fn(async (_project, input) => result(input.command, input.purpose)),
    runArgv: vi.fn(async (_project, input) => result(JSON.stringify([input.executable, ...input.args]), input.purpose)),
  };
  const auditLogger = { log: vi.fn().mockResolvedValue(undefined) };
  return {
    ctx: {
      registry: {
        has: (projectId: string) => projectId === project.projectId,
        get: (projectId: string) => (projectId === project.projectId ? project : undefined),
        getAll: () => [project],
      },
      contextStore,
      shellRunner,
      auditLogger,
    } as unknown as AppContext,
    shellRunner,
    auditLogger,
  };
}

function writeManifest(actions: Record<string, unknown>) {
  mkdirSync(join(tmpRoot, ".local-dev"), { recursive: true });
  writeFileSync(join(tmpRoot, ".local-dev", "actions.json"), JSON.stringify({ version: 1, actions }, null, 2));
}

function body(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: tmpRoot, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

function createPushedGitRepo(): string {
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Repository Action Test");
  git("config", "user.email", "repo-actions@example.invalid");
  git("init", "--bare", "-q", "--initial-branch=main", join(tmpRoot, "remote.git"));
  writeFileSync(join(tmpRoot, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "Initial test commit");
  git("remote", "add", "origin", join(tmpRoot, "remote.git"));
  git("push", "-u", "origin", "main");
  return git("rev-parse", "HEAD");
}

function credentialedReadAction() {
  return {
    mode: "read",
    operation: "credentialed_read",
    credential_scope: "bitwarden",
    network: true,
    executable: "node",
    argv: ["scripts/production-probe.mjs", "--signal-id", { param: "signal_id" }],
    input_schema: {
      type: "object",
      properties: { signal_id: { type: "integer", minimum: 1 } },
      required: ["signal_id"],
      additionalProperties: false,
    },
    timeout_seconds: 120,
  };
}

function pinnedReadProject(hostRoot: string, action = credentialedReadAction()): ProjectConfig {
  return {
    ...createProject(hostRoot),
    credentialedReadActions: {
      "signal.inspect": createHash("sha256").update(JSON.stringify(action)).digest("hex"),
    },
  };
}

function deploymentAction() {
  return {
    mode: "write",
    operation: "deployment",
    credential_scope: "bitwarden",
    network: true,
    executable: "pnpm",
    argv: ["run", "deploy:pages", "--", "--preflight-only", "--expected-head", { param: "expected_head" }],
    input_schema: {
      type: "object",
      properties: { expected_head: { type: "string", pattern: "^[0-9a-fA-F]{40}$" } },
      required: ["expected_head"],
      additionalProperties: false,
    },
    timeout_seconds: 180,
  };
}

describe("repo.action", () => {
  it("lists no actions when a repository has no manifest", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleRepoActionList(ctx, "chat-a");
    expect(body(result)).toMatchObject({
      project_id: "alpha",
      manifest_path: ".local-dev/actions.json",
      catalog_version: null,
      actions: [],
    });
  });

  it("lists manifest-backed actions without executing shell", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({
      "status.read": {
        mode: "read",
        description: "Read status.",
        executable: "printf",
        argv: ["%s", { param: "value" }],
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });
    const { ctx, shellRunner } = createContext(createProject(tmpRoot));

    const result = await handleRepoActionList(ctx, "chat-a");
    expect(body(result).actions).toEqual([
      expect.objectContaining({ id: "status.read", mode: "read", description: "Read status.", network: false }),
    ]);
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("executes a declared read action as fixed argv without shell parsing", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({
      "status.read": {
        mode: "read",
        executable: "printf",
        argv: ["%s", { param: "value" }],
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });
    const { ctx, shellRunner } = createContext(createProject(tmpRoot));

    const result = await handleRepoActionRead(ctx, "chat-a", {
      action: "status.read",
      args: { value: "a'; touch /tmp/should-not-run; echo '" },
    });

    expect(result.isError).not.toBe(true);
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).toHaveBeenCalledTimes(1);
    const input = shellRunner.runArgv.mock.calls[0][1] as { executable: string; args: string[]; riskCommand: string };
    expect(input.executable).toBe("printf");
    expect(input.args).toEqual(["%s", "a'; touch /tmp/should-not-run; echo '"]);
    expect(input.riskCommand).toBe("printf %s __repo_action_param__");
  });

  it("keeps injection-looking model input as one argv token in the real runner", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    const marker = join(tmpRoot, "should-not-exist");
    writeManifest({
      "status.read": {
        mode: "read",
        executable: "printf",
        argv: ["%s", { param: "value" }],
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    });
    const project = createProject(tmpRoot);
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", project.projectId);
    const ctx = {
      registry: {
        has: (projectId: string) => projectId === project.projectId,
        get: (projectId: string) => (projectId === project.projectId ? project : undefined),
        getAll: () => [project],
      },
      contextStore,
      shellRunner: new ShellRunner(),
      auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AppContext;

    const value = `literal; touch ${marker}`;
    const result = await handleRepoActionRead(ctx, "chat-a", { action: "status.read", args: { value } });
    expect(result.isError).not.toBe(true);
    expect(body(result).stdout).toBe(value);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects mode mismatch and networked actions", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({
      "ledger.record": {
        mode: "write",
        executable: "node",
        argv: ["script.mjs"],
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
      "remote.inspect": {
        mode: "read",
        network: true,
        executable: "node",
        argv: ["remote.mjs"],
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    });
    const { ctx, shellRunner } = createContext(createProject(tmpRoot));

    const mismatch = await handleRepoActionRead(ctx, "chat-a", { action: "ledger.record" });
    expect(body(mismatch).error.code).toBe("ACTION_MODE_MISMATCH");

    const external = await handleRepoActionRead(ctx, "chat-a", { action: "remote.inspect" });
    expect(body(external).error.code).toBe("ACTION_EXTERNAL_UNSUPPORTED");
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("rejects shell, eval, and dynamic dispatcher manifests", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({
      "shell.bad": {
        mode: "write",
        executable: "bash",
        argv: ["-c", { param: "command" }],
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      },
    });
    let setup = createContext(createProject(tmpRoot));
    let result = await handleRepoActionList(setup.ctx, "chat-a");
    expect(body(result).error.code).toBe("ACTION_MANIFEST_INVALID");
    expect(setup.shellRunner.runArgv).not.toHaveBeenCalled();

    writeManifest({
      "eval.bad": {
        mode: "write",
        executable: "node",
        argv: ["-e", { param: "code" }],
        input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
      },
    });
    setup = createContext(createProject(tmpRoot));
    result = await handleRepoActionList(setup.ctx, "chat-a");
    expect(body(result).error.code).toBe("ACTION_MANIFEST_INVALID");

    writeManifest({
      "dispatch.bad": {
        mode: "write",
        executable: "pnpm",
        argv: ["exec", { param: "tool" }],
        input_schema: { type: "object", properties: { tool: { type: "string" } }, required: ["tool"], additionalProperties: false },
      },
    });
    setup = createContext(createProject(tmpRoot));
    result = await handleRepoActionList(setup.ctx, "chat-a");
    expect(body(result).error.code).toBe("ACTION_MANIFEST_INVALID");
  });

  it("requires write_policy=allow for write actions", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({
      "ledger.record": {
        mode: "write",
        executable: "node",
        argv: ["script.mjs"],
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    });
    const { ctx, shellRunner } = createContext(createProject(tmpRoot, "confirm"));

    const result = await handleRepoActionWrite(ctx, "chat-a", { action: "ledger.record" });
    expect(body(result).error.code).toBe("ACTION_WRITE_NOT_ALLOWED");
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("denies credentialed reads until the host pins the exact action", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({ "signal.inspect": credentialedReadAction() });
    const { ctx, shellRunner } = createContext(createProject(tmpRoot));

    const denied = await handleRepoActionRead(ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(body(denied).error.code).toBe("ACTION_CREDENTIALED_READ_NOT_APPROVED");
    expect(shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("runs only a host-pinned credentialed read with a validated scalar argument", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    const action = credentialedReadAction();
    writeManifest({ "signal.inspect": action });
    const { ctx, shellRunner, auditLogger } = createContext(pinnedReadProject(tmpRoot, action));

    const invalid = await handleRepoActionRead(ctx, "chat-a", { action: "signal.inspect", args: { signal_id: "290; rm -rf /" } });
    expect(body(invalid).error.code).toBe("ACTION_ARGUMENT_INVALID");
    const extra = await handleRepoActionRead(ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290, command: "apply" } });
    expect(body(extra).error.code).toBe("ACTION_ARGUMENT_INVALID");
    const wrongMode = await handleRepoActionWrite(ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(body(wrongMode).error.code).toBe("ACTION_MODE_MISMATCH");
    expect(shellRunner.runArgv).not.toHaveBeenCalled();

    const result = await handleRepoActionRead(ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(result.isError).not.toBe(true);
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).toHaveBeenCalledTimes(1);
    expect(shellRunner.runArgv.mock.calls[0][1]).toMatchObject({
      executable: "node", args: ["scripts/production-probe.mjs", "--signal-id", "290"],
      credentialScope: "bitwarden", env: { BWS_ACCESS_TOKEN: "test-only-token" },
    });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: "repo_action_executed", command: "signal.inspect",
      riskLevel: "network_or_dependency", credentialScope: "bitwarden",
    }));
  });

  it("denies a modified manifest, missing network permission and missing credential", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    const action = credentialedReadAction();
    writeManifest({ "signal.inspect": action });
    const project = pinnedReadProject(tmpRoot, action);
    let setup = createContext({ ...project, networkPolicy: "deny" });
    let result = await handleRepoActionRead(setup.ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(body(result).error.code).toBe("ACTION_READ_NETWORK_NOT_ALLOWED");

    writeManifest({ "signal.inspect": { ...action, argv: ["scripts/other.mjs", "--signal-id", { param: "signal_id" }] } });
    setup = createContext(project);
    result = await handleRepoActionRead(setup.ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(body(result).error.code).toBe("ACTION_CREDENTIALED_READ_NOT_APPROVED");
    expect(setup.shellRunner.runArgv).not.toHaveBeenCalled();

    writeManifest({ "signal.inspect": action });
    vi.mocked(resolveCredentialEnv).mockRejectedValueOnce(new Error("Keychain denied"));
    result = await handleRepoActionRead(setup.ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(body(result).error.code).toBe("ACTION_READ_CREDENTIAL_UNAVAILABLE");
    expect(setup.shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("rejects unsafe credentialed-read definitions before any credential injection", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    const base = credentialedReadAction();
    for (const invalidAction of [
      { ...base, mode: "write" },
      { ...base, network: false },
      { ...base, credential_scope: undefined },
      { ...base, input_schema: { ...base.input_schema, additionalProperties: true } },
      { ...base, executable: "bash", argv: ["-c", "echo secret"] },
      { ...base, executable: "node", argv: ["-e", "process.exit(0)"] },
    ]) {
      writeManifest({ "signal.inspect": invalidAction });
      const { ctx, shellRunner } = createContext(createProject(tmpRoot));
      const result = await handleRepoActionList(ctx, "chat-a");
      expect(body(result).error.code).toBe("ACTION_MANIFEST_INVALID");
      expect(shellRunner.runArgv).not.toHaveBeenCalled();
    }
  });

  it("redacts credentials from the output of a real host-pinned read subprocess", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    mkdirSync(join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(join(tmpRoot, "scripts", "production-probe.mjs"), "process.stdout.write(process.env.BWS_ACCESS_TOKEN || 'missing')\n");
    const action = credentialedReadAction();
    writeManifest({ "signal.inspect": action });
    const project = pinnedReadProject(tmpRoot, action);
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", project.projectId);
    const ctx = {
      registry: {
        has: (id: string) => id === project.projectId,
        get: (id: string) => id === project.projectId ? project : undefined,
      },
      contextStore,
      shellRunner: new ShellRunner(),
      auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AppContext;
    const result = await handleRepoActionRead(ctx, "chat-a", { action: "signal.inspect", args: { signal_id: 290 } });
    expect(result.isError).not.toBe(true);
    expect(body(result).stdout).not.toContain("test-only-token");
    expect(body(result).redactions.length).toBeGreaterThan(0);
  });

  it("restricts the credentialed deployment contract to fixed argv and write/network policy", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({ "pages.preflight": { ...deploymentAction(), argv: ["run", "deploy:pages", { param: "command" }] } });
    let setup = createContext(createProject(tmpRoot));
    let result = await handleRepoActionList(setup.ctx, "chat-a");
    expect(body(result).error.code).toBe("ACTION_MANIFEST_INVALID");

    writeManifest({ "pages.preflight": deploymentAction() });
    const restricted = { ...createProject(tmpRoot), networkPolicy: "deny" as const };
    setup = createContext(restricted);
    result = await handleRepoActionWrite(setup.ctx, "chat-a", { action: "pages.preflight", args: { expected_head: "a".repeat(40) } });
    expect(body(result).error.code).toBe("ACTION_DEPLOY_NETWORK_NOT_ALLOWED");
    expect(setup.shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("verifies a clean pushed commit before injecting credentials into a deployment action", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    const head = createPushedGitRepo();
    writeManifest({ "pages.preflight": deploymentAction() });
    const { ctx, shellRunner, auditLogger } = createContext(createProject(tmpRoot));

    const mismatch = await handleRepoActionWrite(ctx, "chat-a", {
      action: "pages.preflight", args: { expected_head: "f".repeat(40) },
    });
    expect(body(mismatch).error.code).toBe("ACTION_DEPLOY_HEAD_MISMATCH");
    expect(shellRunner.runArgv).not.toHaveBeenCalled();

    writeFileSync(join(tmpRoot, "tracked.txt"), "dirty\n");
    const dirty = await handleRepoActionWrite(ctx, "chat-a", {
      action: "pages.preflight", args: { expected_head: head },
    });
    expect(body(dirty).error.code).toBe("ACTION_DEPLOY_DIRTY");
    git("restore", "tracked.txt");

    const valid = await handleRepoActionWrite(ctx, "chat-a", {
      action: "pages.preflight", args: { expected_head: head },
    });
    expect(valid.isError).not.toBe(true);
    expect(shellRunner.runArgv).toHaveBeenCalledTimes(1);
    const input = shellRunner.runArgv.mock.calls[0][1];
    expect(input.args).toEqual(["run", "deploy:pages", "--", "--preflight-only", "--expected-head", head]);
    expect(input.credentialScope).toBe("bitwarden");
    expect(input.env).toEqual({ BWS_ACCESS_TOKEN: "test-only-token" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ riskLevel: "network_or_dependency", credentialScope: "bitwarden" }));
  });

  it("rejects a deployment commit that has not been pushed to its upstream", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    createPushedGitRepo();
    writeManifest({ "pages.preflight": deploymentAction() });
    writeFileSync(join(tmpRoot, "tracked.txt"), "second\n");
    git("add", "tracked.txt");
    git("commit", "-qm", "Second unpushed commit");
    const { ctx, shellRunner } = createContext(createProject(tmpRoot));
    const blocked = await handleRepoActionWrite(ctx, "chat-a", {
      action: "pages.preflight", args: { expected_head: git("rev-parse", "HEAD") },
    });
    expect(body(blocked).error.code).toBe("ACTION_DEPLOY_NOT_PUSHED");
    expect(shellRunner.runArgv).not.toHaveBeenCalled();
  });

  it("validates structured args before command construction", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-actions-"));
    writeManifest({
      "ledger.record": {
        mode: "write",
        executable: "printf",
        argv: ["%s", { param: "payload", encoding: "json" }],
        input_schema: {
          type: "object",
          properties: { payload: { type: "object" } },
          required: ["payload"],
          additionalProperties: false,
        },
      },
    });
    const { ctx, shellRunner } = createContext(createProject(tmpRoot));

    const invalid = await handleRepoActionWrite(ctx, "chat-a", { action: "ledger.record", args: {} });
    expect(body(invalid).error.code).toBe("ACTION_ARGUMENT_INVALID");
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).not.toHaveBeenCalled();

    const valid = await handleRepoActionWrite(ctx, "chat-a", {
      action: "ledger.record",
      args: { payload: { ok: true } },
    });
    expect(valid.isError).not.toBe(true);
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(shellRunner.runArgv).toHaveBeenCalledTimes(1);
    expect(shellRunner.runArgv.mock.calls[0][1].args).toEqual(["%s", '{"ok":true}']);
  });
});
