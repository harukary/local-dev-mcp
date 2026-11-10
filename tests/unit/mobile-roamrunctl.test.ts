import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeRoamrunctlSession, isRoamrunctlAvailable, listRoamrunctlDevices,
  roamrunctlScreenshot, roamrunctlTap, roamrunctlSwipe, roamrunctlType,
  roamrunctlElements, roamrunctlWait,
} from "../../src/mcp/tools/mobile-roamrunctl.js";

const DEVICE = "roamrunctl:phone";
let dir = "";
let log = "";
let originalBin: string | undefined;
let originalLog: string | undefined;

beforeEach(() => {
  originalBin = process.env.LOCAL_DEV_MCP_ROAMRUNCTL_BIN;
  originalLog = process.env.LOCAL_DEV_MCP_MOCK_ROAMRUNCTL_LOG;
  dir = mkdtempSync(join(tmpdir(), "local-dev-roamrunctl-"));
  log = join(dir, "calls.jsonl");
  const binary = join(dir, "roamrunctl");
  writeFileSync(binary, String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logFile = ${JSON.stringify(log)};
const cmd = process.argv[2];
if (cmd === "--version") { console.log("roamrunctl 0.12.0"); process.exit(0); }
if (cmd === "devices") { console.log("phone\tas it is"); process.exit(0); }
if (cmd !== "mcp") process.exit(3);
let look = 500, consumed = false;
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
const text = (value) => [{type:"text",text:value}];
readline.createInterface({input:process.stdin}).on("line", line => {
  const input = JSON.parse(line);
  if (input.method === "initialize") return reply(input.id, {protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"roamrunctl",version:"0.12.0"}});
  if (input.method !== "tools/call") return;
  const {name, arguments:args} = input.params;
  fs.appendFileSync(logFile, JSON.stringify({name,args})+"\n");
  if (name === "look") {
    consumed = false; look++;
    return reply(input.id,{content:[{type:"image",mimeType:"image/jpeg",data:Buffer.from([255,216,255,217]).toString("base64")},...text("591 x 1280, look "+look)],isError:false});
  }
  if (name === "elements") {
    consumed = true;
    return reply(input.id,{content:text("Settings\nNotifications"),isError:false});
  }
  if (name === "tap" || name === "swipe" || name === "type" || name === "paste") {
    if (args.look !== look || consumed) return reply(input.id,{content:text("look again: stale or consumed"),isError:true});
    consumed = true;
    return reply(input.id,{content:text("sent"),isError:false});
  }
  return reply(input.id,{content:text("ok"),isError:false});
});
`, { mode: 0o755 });
  process.env.LOCAL_DEV_MCP_ROAMRUNCTL_BIN = binary;
  process.env.LOCAL_DEV_MCP_MOCK_ROAMRUNCTL_LOG = log;
});

afterEach(async () => {
  await closeRoamrunctlSession();
  if (originalBin === undefined) delete process.env.LOCAL_DEV_MCP_ROAMRUNCTL_BIN;
  else process.env.LOCAL_DEV_MCP_ROAMRUNCTL_BIN = originalBin;
  if (originalLog === undefined) delete process.env.LOCAL_DEV_MCP_MOCK_ROAMRUNCTL_LOG;
  else process.env.LOCAL_DEV_MCP_MOCK_ROAMRUNCTL_LOG = originalLog;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function calls() {
  return readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s)) as Array<{ name: string; args: Record<string, unknown> }>;
}

describe("standalone roamrunctl MCP session", () => {
  it("reports the binary and saved alias without opening a control session", async () => {
    expect(await isRoamrunctlAvailable()).toBe(true);
    expect(await listRoamrunctlDevices()).toEqual([{
      id: DEVICE, name: "phone", platform: "ios", type: "device",
      state: "Paired", backend: "ios_roamrunctl",
    }]);
    expect(() => readFileSync(log, "utf8")).toThrow();
  });

  it("keeps a session across look/tap and refuses a reused look", async () => {
    const look = await roamrunctlScreenshot(DEVICE, "chat-a");
    expect(look).toMatchObject({ width: 591, height: 1280, lookId: 501 });
    expect(look.bytes[0]).toBe(255);
    await roamrunctlTap(DEVICE, "chat-a", 40, 90);
    await expect(roamrunctlTap(DEVICE, "chat-a", 40, 90)).rejects.toThrow("current screenshot");
    expect(calls().map((call) => call.name)).toEqual(["look", "tap"]);
    expect(calls()[1].args).toMatchObject({ device: "phone", look: 501, x: 40, y: 90 });
  });

  it("rejects cross-chat tokens and out-of-bounds taps before mutation", async () => {
    await roamrunctlScreenshot(DEVICE, "chat-a");
    await expect(roamrunctlTap(DEVICE, "chat-b", 20, 50)).rejects.toThrow("same device and chat");
    await roamrunctlScreenshot(DEVICE, "chat-a");
    await expect(roamrunctlSwipe(DEVICE, "chat-a", 10, 12, 3000, 50, 350)).rejects.toThrow("image pixels");
    expect(calls().every((call) => call.name === "look")).toBe(true);
  });

  it("uses paste for Japanese text and invalidates the look after reading elements", async () => {
    await roamrunctlScreenshot(DEVICE, "chat-a");
    await roamrunctlType(DEVICE, "chat-a", "日本語");
    await roamrunctlScreenshot(DEVICE, "chat-a");
    expect(await roamrunctlElements(DEVICE)).toEqual(["Settings", "Notifications"]);
    await expect(roamrunctlTap(DEVICE, "chat-a", 20, 50)).rejects.toThrow("current screenshot");
    expect(calls().map((call) => call.name)).toEqual(["look", "paste", "look", "elements"]);
  });

  it("waits for visible caption text and refuses synthetic element refs", async () => {
    await roamrunctlWait(DEVICE, "notifications", 1000);
    await expect(roamrunctlWait(DEVICE, "@e2", 1000)).rejects.toThrow("Element refs");
  });
});
