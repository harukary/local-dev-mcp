import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleComputerTool, runComputerToolOperation } from "../../src/mcp/tools/computer.js";

const CHAT = "chatgpt-session:test-computer";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==";
let root = "";
const originalDriver = process.env.LOCAL_DEV_MCP_COMPUTER_DRIVER;

function project(writePolicy: ProjectConfig["writePolicy"] = "allow"): ProjectConfig {
  return {
    projectId: "test", displayName: "Test", hostRoot: root, sandboxRoot: root,
    sandboxType: "host", defaultShell: "/bin/bash", defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300, networkPolicy: "ask", writePolicy,
    approvalMode: "catastrophic_only", deniedPaths: [".env", "secrets"], redactionProfile: "default",
  };
}

function ctx(p = project()): AppContext {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject(CHAT, p.projectId);
  return {
    registry: { get: () => p, has: () => true, getAll: () => [p] },
    contextStore,
    auditLogger: { log: async () => undefined },
  } as unknown as AppContext;
}

function makeDriver() {
  root = mkdtempSync(join(tmpdir(), "local-dev-mcp-computer-"));
  const file = join(root, "fake-cua");
  writeFileSync(file, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('cua-driver 0.43.2'); process.exit(0); }",
    "if (args[0] === 'status') { console.log('running'); process.exit(0); }",
    "if (args[0] === 'permissions') { console.log(JSON.stringify({ accessibility:true,screen_recording:true })); process.exit(0); }",
    "if (args[0] !== 'call') process.exit(3);",
    "const cmd = args[1], payload = JSON.parse(args[2] || '{}');",
    "if (cmd === 'list_windows') { console.log(JSON.stringify({windows:[{pid:321,window_id:42,app_name:'Browser',title:'Example',bounds:{x:10,y:20,width:200,height:150},on_current_space:true}]})); process.exit(0); }",
    "if (cmd === 'list_apps') { console.log(JSON.stringify({apps:[{name:'Browser',bundle_id:'com.example.browser',pid:321}]})); process.exit(0); }",
    "if (cmd === 'get_window_state') { const i=args.indexOf('--screenshot-out-file'); if(i<0)process.exit(4); fs.writeFileSync(args[i+1],Buffer.from('" + PNG + "','base64')); console.log(JSON.stringify({snapshot_id:'s0000002a',capture_id:'c-test',tree_markdown:'[0] button Example', screenshot_width:1,screenshot_height:1,degraded:process.env.MOCK_CUA_LOCKED==='1',degraded_reason:process.env.MOCK_CUA_LOCKED==='1'?'screen_locked':null})); process.exit(0); }",
    "if (cmd === 'type_text' && payload.text === 'fail') { console.error('secret '+payload.text); process.exit(3); }",
    "console.log(JSON.stringify({effect:'applied', text:payload.text||null}));",
  ].join("\n"), { mode: 0o755 });
  process.env.LOCAL_DEV_MCP_COMPUTER_DRIVER = file;
}

function data(result: { structuredContent?: unknown }) {
  return result.structuredContent as Record<string, any>;
}

afterEach(() => {
  if (originalDriver === undefined) delete process.env.LOCAL_DEV_MCP_COMPUTER_DRIVER;
  else process.env.LOCAL_DEV_MCP_COMPUTER_DRIVER = originalDriver;
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.MOCK_CUA_LOCKED;
  root = "";
});

describe("computer tools", () => {
  it("reports driver status and bounded desktop inventory", async () => {
    makeDriver();
    const context = ctx();
    const status = data(await handleComputerTool(context, CHAT, "computer.status"));
    expect(status).toMatchObject({ installed: true, running: true, permissions: { accessibility: true } });
    expect(data(await handleComputerTool(context, CHAT, "computer.list_apps")).apps).toHaveLength(1);
    expect(data(await handleComputerTool(context, CHAT, "computer.list_windows", { app_name_contains: "browser" })).windows)
      .toMatchObject([{ pid: 321, window_id: 42 }]);
    expect(data(await handleComputerTool(context, CHAT, "computer.list_windows", { title_contains: "other" })).total).toBe(0);
  });

  it("rejects unverified contexts, forbidden writes, and incorrect window IDs", async () => {
    makeDriver();
    const context = ctx();
    expect(data(await handleComputerTool(context, "chatgpt-user:anonymous", "computer.list_windows")).error.code)
      .toBe("COMPUTER_CONTEXT_REQUIRED");
    expect(data(await handleComputerTool(ctx(project("deny")), CHAT, "computer.click", { pid: 321, window_id: 42, x: 1, y: 1 })).error.code)
      .toBe("COMPUTER_WRITE_NOT_ALLOWED");
    expect(data(await handleComputerTool(context, CHAT, "computer.click", { pid: 321, window_id: 99, x: 1, y: 1 })).error.code)
      .toBe("COMPUTER_TARGET_NOT_FOUND");
  });

  it("requires a recent same-context snapshot for element tokens and coordinates", async () => {
    makeDriver();
    const context = ctx();
    const input = { pid: 321, window_id: 42, element_token: "s0000002a:0" };
    expect(data(await handleComputerTool(context, CHAT, "computer.click", input)).error.code)
      .toBe("COMPUTER_INVALID_ACTION");
    const observed = await handleComputerTool(context, CHAT, "computer.get_window_state", { pid: 321, window_id: 42 });
    expect(data(observed).snapshot_id).toBe("s0000002a");
    expect(data(observed).tree_markdown).toContain("[0]");
    expect(observed.content.some((part) => part.type === "image")).toBe(true);
    expect(data(await handleComputerTool(context, CHAT, "computer.click", input)).action_applied).toBe(true);
    expect(data(await handleComputerTool(context, CHAT, "computer.click", input)).error.code)
      .toBe("COMPUTER_INVALID_ACTION");
  });

  it("rejects every input when the window is degraded or screen-locked", async () => {
    makeDriver();
    process.env.MOCK_CUA_LOCKED = "1";
    const context = ctx();
    const screenshot = data(await handleComputerTool(context, CHAT, "computer.get_window_state", { pid: 321, window_id: 42 }));
    expect(screenshot).toMatchObject({ degraded: true, snapshot_id: "s0000002a" });
    const refused = data(await handleComputerTool(context, CHAT, "computer.click", { pid: 321, window_id: 42, x: 1, y: 1 }));
    expect(refused.error.code).toBe("COMPUTER_INVALID_ACTION");
    expect(refused.error.message).toContain("Wake and unlock");
  });

  it("never echoes typed text and avoids unsafe retry hints on unknown mutation results", async () => {
    makeDriver();
    const context = ctx();
    await handleComputerTool(context, CHAT, "computer.screenshot", { pid: 321, window_id: 42 });
    const ok = data(await handleComputerTool(context, CHAT, "computer.type", { pid: 321, window_id: 42, text: "private-example" }));
    expect(ok.action_applied).toBe(true);
    expect(JSON.stringify(ok)).not.toContain("private-example");
    await handleComputerTool(context, CHAT, "computer.screenshot", { pid: 321, window_id: 42 });
    const failed = data(await handleComputerTool(context, CHAT, "computer.type", { pid: 321, window_id: 42, text: "fail" }));
    expect(failed).toMatchObject({ error: { code: "COMPUTER_DRIVER_FAILED" }, action_applied: null, retry_action: false });
    expect(JSON.stringify(failed)).not.toContain("fail'"); // no raw stderr or typed payload
  });

  it("captures a verified window screenshot and serializes host actions", async () => {
    makeDriver();
    const context = ctx();
    const screenshot = await handleComputerTool(context, CHAT, "computer.screenshot", { pid: 321, window_id: 42 });
    expect(data(screenshot).screenshot.path).toContain("generated/local-dev-mcp/computer/window-");
    expect(screenshot.content.some((part) => part.type === "image")).toBe(true);
    const order: string[] = [];
    await Promise.all([
      runComputerToolOperation(async () => { order.push("a"); await Promise.resolve(); order.push("b"); }),
      runComputerToolOperation(async () => { order.push("c"); }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
