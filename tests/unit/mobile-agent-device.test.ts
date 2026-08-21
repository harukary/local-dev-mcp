import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentIosLaunchApp,
  agentIosSnapshot,
  agentIosTap,
  agentIosTapTarget,
  agentIosWait,
} from "../../src/mcp/tools/mobile-agent-device.js";

let tmpRoot = "";
let previousPath: string | undefined;
let previousFakeState: string | undefined;
let previousFakeLog: string | undefined;

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousFakeState === undefined) delete process.env.FAKE_AGENT_STATE;
  else process.env.FAKE_AGENT_STATE = previousFakeState;
  if (previousFakeLog === undefined) delete process.env.FAKE_AGENT_LOG;
  else process.env.FAKE_AGENT_LOG = previousFakeLog;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

function installFakeAgentDevice() {
  tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-agent-device-test-"));
  const binDir = join(tmpRoot, "bin");
  const statePath = join(tmpRoot, "state.json");
  const logPath = join(tmpRoot, "calls.ndjson");
  require("node:fs").mkdirSync(binDir, { recursive: true });
  const cliPath = join(binDir, "agent-device");
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require("node:fs");
let args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--state-dir") args = args.slice(2);
const statePath = process.env.FAKE_AGENT_STATE;
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
const writeState = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
const out = (data) => process.stdout.write(JSON.stringify({ success: true, data }));
const command = args[0];
if (command === "session" && args[1] === "list") {
  const state = readState();
  out({ sessions: state.active ? [state.active] : [] });
} else if (command === "open") {
  const session = args[args.indexOf("--session") + 1];
  const platform = args[args.indexOf("--platform") + 1];
  const id = args[args.indexOf("--udid") + 1];
  writeState({ active: { name: session, platform, id } });
  out({ session });
} else if (command === "close") {
  writeState({});
  out({ session: args[args.indexOf("--session") + 1] });
} else if (command === "snapshot") {
  out({ nodes: [{ ref: "e1", label: "tomoca" }] });
} else if (command === "click" || command === "find" || command === "wait") {
  out({ message: command });
} else {
  out({});
}
`);
  chmodSync(cliPath, 0o755);

  previousPath = process.env.PATH;
  previousFakeState = process.env.FAKE_AGENT_STATE;
  previousFakeLog = process.env.FAKE_AGENT_LOG;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
  process.env.FAKE_AGENT_STATE = statePath;
  process.env.FAKE_AGENT_LOG = logPath;
  return { logPath };
}

function calls(logPath: string): string[][] {
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

describe("mobile agent-device iOS session lifecycle", () => {
  it("isolates state, reuses a bound session, and resets it only when launching an app", async () => {
    const { logPath } = installFakeAgentDevice();
    const udid = "SIM-123";

    expect(await agentIosSnapshot(udid)).toEqual([{ ref: "e1", label: "tomoca" }]);
    await agentIosTap(udid, 120, 240);

    const beforeLaunch = calls(logPath);
    expect(beforeLaunch.every((args) => args[0] === "--state-dir")).toBe(true);
    expect(beforeLaunch.filter((args) => args.includes("open"))).toHaveLength(1);
    expect(beforeLaunch.filter((args) => args.includes("session") && args.includes("list"))).toHaveLength(2);
    expect(beforeLaunch.some((args) => args.includes("click") && args.includes("120") && args.includes("240"))).toBe(true);

    await agentIosLaunchApp(udid, "com.example.tomoca");
    await agentIosSnapshot(udid);

    const afterLaunch = calls(logPath);
    expect(afterLaunch.filter((args) => args.includes("close"))).toHaveLength(1);
    const opens = afterLaunch.filter((args) => args.includes("open"));
    expect(opens).toHaveLength(2);
    expect(opens.at(-1)).toContain("com.example.tomoca");
    expect(afterLaunch.filter((args) => args.includes("open"))).toHaveLength(2);
  }, 15_000);

  it("maps refs, selectors, visible text, and wait targets to agent-device syntax", async () => {
    const { logPath } = installFakeAgentDevice();
    const udid = "SIM-456";

    await agentIosTapTarget(udid, "e19");
    await agentIosTapTarget(udid, 'label="tomoca Plus"');
    await agentIosTapTarget(udid, "プラン、無料、Plusを見る");
    await agentIosWait(udid, "tomoca Plus", 4321);
    await agentIosWait(udid, "@e20", 9876);
    await agentIosWait(udid, 'id="settings-destination"', 1234);

    const logged = calls(logPath);
    expect(logged.some((args) => args.includes("click") && args.includes("@e19"))).toBe(true);
    expect(logged.some((args) => args.includes("click") && args.includes('label="tomoca Plus"'))).toBe(true);
    expect(logged.some((args) => args.includes("find") && args.includes("プラン、無料、Plusを見る") && args.includes("click") && args.includes("--first"))).toBe(true);
    expect(logged.some((args) => args.includes("wait") && args.includes("text") && args.includes("tomoca Plus") && args.includes("4321"))).toBe(true);
    expect(logged.some((args) => args.includes("wait") && args.includes("@e20") && args.includes("9876"))).toBe(true);
    expect(logged.some((args) => args.includes("wait") && args.includes('id="settings-destination"') && args.includes("1234"))).toBe(true);
  }, 15_000);
});
