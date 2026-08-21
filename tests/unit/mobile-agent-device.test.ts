import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentAndroidSnapshot,
  agentAndroidTapTarget,
  agentAndroidWait,
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
let previousAgentDeviceBin: string | undefined;
let previousFakeAdbLog: string | undefined;
let previousIosTeamId: string | undefined;
let previousIosBundleId: string | undefined;

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousFakeState === undefined) delete process.env.FAKE_AGENT_STATE;
  else process.env.FAKE_AGENT_STATE = previousFakeState;
  if (previousFakeLog === undefined) delete process.env.FAKE_AGENT_LOG;
  else process.env.FAKE_AGENT_LOG = previousFakeLog;
  if (previousAgentDeviceBin === undefined) delete process.env.LOCAL_DEV_MCP_AGENT_DEVICE_BIN;
  else process.env.LOCAL_DEV_MCP_AGENT_DEVICE_BIN = previousAgentDeviceBin;
  if (previousFakeAdbLog === undefined) delete process.env.FAKE_ADB_LOG;
  else process.env.FAKE_ADB_LOG = previousFakeAdbLog;
  if (previousIosTeamId === undefined) delete process.env.AGENT_DEVICE_IOS_TEAM_ID;
  else process.env.AGENT_DEVICE_IOS_TEAM_ID = previousIosTeamId;
  if (previousIosBundleId === undefined) delete process.env.AGENT_DEVICE_IOS_BUNDLE_ID;
  else process.env.AGENT_DEVICE_IOS_BUNDLE_ID = previousIosBundleId;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

function installFakeAgentDevice() {
  tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-agent-device-test-"));
  const binDir = join(tmpRoot, "bin");
  const statePath = join(tmpRoot, "state.json");
  const logPath = join(tmpRoot, "calls.ndjson");
  const adbLogPath = join(tmpRoot, "adb-calls.ndjson");
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
const fail = (code, message) => { process.stdout.write(JSON.stringify({ success: false, error: { code, message } })); process.exitCode = 1; };
const command = args[0];
const requestedSession = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;
const state = readState();
const hasRequestedSession = requestedSession !== null && state.active?.name === requestedSession;
const isExplicitAndroid = args.includes("--platform") && args[args.indexOf("--platform") + 1] === "android" && args.includes("--serial");
if (command === "session" && args[1] === "list") {
  out({ sessions: [] });
} else if (command === "open") {
  const session = requestedSession;
  const platform = args[args.indexOf("--platform") + 1];
  const deviceFlag = args.includes("--udid") ? "--udid" : "--serial";
  const id = args[args.indexOf(deviceFlag) + 1];
  writeState({ active: { name: session, platform, id } });
  out({ session });
} else if (command === "close") {
  if (!hasRequestedSession) fail("SESSION_NOT_FOUND", "No active session");
  else { writeState({}); out({ session: requestedSession }); }
} else if (command === "snapshot") {
  if (isExplicitAndroid) {
    out({ nodes: [
      { ref: "e1", type: "android.widget.TextView", label: "tomoca", value: "tomoca", rect: { x: 10, y: 20, width: 100, height: 40 } },
      { ref: "e2", type: "android.widget.Button", label: "設定を開く", rect: { x: 200, y: 300, width: 80, height: 60 }, enabled: true, hittable: true, visibleToUser: true },
    ] });
  } else if (!hasRequestedSession) fail("SESSION_NOT_FOUND", "Run open first");
  else out({ nodes: [{ ref: "e1", label: "tomoca" }] });
} else if (command === "click" || command === "find" || command === "wait") {
  if (!hasRequestedSession) fail("SESSION_NOT_FOUND", "Run open first");
  else out({ message: command });
} else {
  out({});
}
`);
  chmodSync(cliPath, 0o755);

  const adbPath = join(binDir, "adb");
  writeFileSync(adbPath, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
  chmodSync(adbPath, 0o755);

  previousPath = process.env.PATH;
  previousFakeState = process.env.FAKE_AGENT_STATE;
  previousFakeLog = process.env.FAKE_AGENT_LOG;
  previousAgentDeviceBin = process.env.LOCAL_DEV_MCP_AGENT_DEVICE_BIN;
  previousFakeAdbLog = process.env.FAKE_ADB_LOG;
  previousIosTeamId = process.env.AGENT_DEVICE_IOS_TEAM_ID;
  previousIosBundleId = process.env.AGENT_DEVICE_IOS_BUNDLE_ID;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
  process.env.LOCAL_DEV_MCP_AGENT_DEVICE_BIN = cliPath;
  process.env.FAKE_AGENT_STATE = statePath;
  process.env.FAKE_AGENT_LOG = logPath;
  process.env.FAKE_ADB_LOG = adbLogPath;
  process.env.AGENT_DEVICE_IOS_TEAM_ID = "TESTTEAM123";
  process.env.AGENT_DEVICE_IOS_BUNDLE_ID = "com.example.localdevmcp.runner";
  return { logPath, adbPath, adbLogPath };
}

function calls(logPath: string): string[][] {
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

describe("mobile agent-device iOS session lifecycle", () => {
  it("isolates state, uses the bound app session directly, and resets it only when launching an app", async () => {
    const { logPath } = installFakeAgentDevice();
    const udid = "SIM-123";

    await expect(agentIosSnapshot(udid)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await agentIosLaunchApp(udid, "com.example.tomoca");
    expect(await agentIosSnapshot(udid)).toEqual([{ ref: "e1", label: "tomoca" }]);
    await agentIosTap(udid, 120, 240);

    const beforeRelaunch = calls(logPath);
    expect(beforeRelaunch.every((args) => args[0] === "--state-dir")).toBe(true);
    expect(beforeRelaunch.filter((args) => args.includes("session") && args.includes("list"))).toHaveLength(0);
    expect(beforeRelaunch.filter((args) => args.includes("open"))).toHaveLength(1);
    expect(beforeRelaunch.some((args) => args.includes("click") && args.includes("120") && args.includes("240"))).toBe(true);

    await agentIosLaunchApp(udid, "com.example.tomoca.next");
    await agentIosSnapshot(udid);

    const afterRelaunch = calls(logPath);
    expect(afterRelaunch.filter((args) => args.includes("close"))).toHaveLength(2);
    const opens = afterRelaunch.filter((args) => args.includes("open"));
    expect(opens).toHaveLength(2);
    expect(opens.at(-1)).toContain("com.example.tomoca.next");
  }, 15_000);

  it("uses stateless Android snapshots and ADB taps without named agent-device sessions", async () => {
    const { logPath, adbPath, adbLogPath } = installFakeAgentDevice();
    const serial = "ANDROID-123";

    const first = await agentAndroidSnapshot(serial, adbPath);
    expect(first).toHaveLength(2);
    await agentAndroidTapTarget(serial, adbPath, "e1");
    const afterRef = calls(logPath);
    expect(afterRef.filter((args) => args.includes("snapshot"))).toHaveLength(1);

    await agentAndroidTapTarget(serial, adbPath, 'role=button label="設定を開く"');
    await agentAndroidWait(serial, adbPath, "tomoca", 1000);

    const logged = calls(logPath);
    const androidCalls = logged.filter((args) => args.includes("--platform") && args.includes("android"));
    expect(androidCalls.length).toBeGreaterThanOrEqual(3);
    expect(androidCalls.every((args) => args.includes("--serial") && args.includes(serial))).toBe(true);
    expect(androidCalls.every((args) => !args.includes("--session"))).toBe(true);
    expect(logged.some((args) => args.includes("open"))).toBe(false);

    const adbCalls = calls(adbLogPath);
    expect(adbCalls).toContainEqual(["-s", serial, "shell", "input", "tap", "60", "40"]);
    expect(adbCalls).toContainEqual(["-s", serial, "shell", "input", "tap", "240", "330"]);
  }, 15_000);

  it("maps refs, selectors, visible text, and wait targets to agent-device syntax", async () => {
    const { logPath } = installFakeAgentDevice();
    const udid = "SIM-456";

    await agentIosLaunchApp(udid, "com.example.tomoca");
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
