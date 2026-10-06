import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleRepoActionList, handleRepoActionRead, handleRepoActionWrite } from "../../src/mcp/tools/repo-action.js";
import { ShellRunner } from "../../src/shell/runner.js";

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
