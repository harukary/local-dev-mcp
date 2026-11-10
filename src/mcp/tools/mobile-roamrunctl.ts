import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { requestSignal } from "../request-context.js";

const execFileAsync = promisify(execFile);
const LOOK_MAX_AGE_MS = 55_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 60_000;

export type RoamrunctlDevice = {
  id: string;
  name: string;
  platform: "ios";
  type: "device";
  state: "Paired";
  backend: "ios_roamrunctl";
};

type Look = { id: number; chat: string; at: number; width: number; height: number };
type Session = { client: Client; transport: StdioClientTransport };

const looks = new Map<string, Look>();
let session: Session | undefined;
let starting: Promise<Session> | undefined;

export function roamrunctlBinary(): string {
  const override = process.env.LOCAL_DEV_MCP_ROAMRUNCTL_BIN?.trim();
  if (override) return override;
  for (const binary of ["/opt/homebrew/bin/roamrunctl", "/usr/local/bin/roamrunctl"]) {
    if (existsSync(binary)) return binary;
  }
  return "roamrunctl";
}

export async function isRoamrunctlAvailable(): Promise<boolean> {
  try {
    await execFileAsync(roamrunctlBinary(), ["--version"], { timeout: 10_000, maxBuffer: 100_000 });
    return true;
  } catch {
    return false;
  }
}

export async function listRoamrunctlDevices(): Promise<RoamrunctlDevice[]> {
  const { stdout } = await execFileAsync(roamrunctlBinary(), ["devices"], {
    timeout: 15_000,
    signal: requestSignal(),
    maxBuffer: 1024 * 1024,
  });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("\t");
    if (separator < 1) return [];
    const name = line.slice(0, separator).trim();
    if (!name) return [];
    return [{ id: "roamrunctl:" + name, name, platform: "ios" as const, type: "device" as const, state: "Paired" as const, backend: "ios_roamrunctl" as const }];
  });
}

export function roamrunctlAlias(id: string): string {
  if (!id.startsWith("roamrunctl:") || id.length <= "roamrunctl:".length) {
    throw new Error("Select a paired roamrunctl device with mobile.list_devices.");
  }
  return id.slice("roamrunctl:".length);
}

async function connection(): Promise<Session> {
  if (session) return session;
  if (starting) return starting;
  starting = (async () => {
    const transport = new StdioClientTransport({
      command: roamrunctlBinary(),
      args: ["mcp"],
      stderr: "ignore",
      maxBufferSize: 20 * 1024 * 1024,
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.ROAMRUNCTL_PASSPHRASE_COMMAND ? { ROAMRUNCTL_PASSPHRASE_COMMAND: process.env.ROAMRUNCTL_PASSPHRASE_COMMAND } : {}),
      },
    });
    const client = new Client({ name: "local-dev-mcp-mobile", version: "1.0.0" });
    client.onclose = () => {
      if (session?.client === client) session = undefined;
      looks.clear();
    };
    try {
      await client.connect(transport);
      session = { client, transport };
      return session;
    } catch (error) {
      await transport.close().catch(() => {});
      throw new Error("roamrunctl MCP connection failed. Check the CLI installation and pairing.");
    }
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

async function tool(name: string, args: Record<string, unknown>) {
  const connected = await connection();
  const result = await connected.client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS, signal: requestSignal() }
  );
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = Array.isArray(result.content)
    ? result.content.filter((entry): entry is { type: string; text?: string; data?: string; mimeType?: string } => !!entry && typeof entry === "object" && "type" in entry)
    : [];
  if (result.isError) {
    const reason = content.find((entry) => entry.type === "text")?.text ?? "Operation refused";
    throw new Error("roamrunctl " + name + " failed: " + reason.replace(/\s+/g, " ").slice(0, 240));
  }
  if (!Array.isArray(result.content)) throw new Error("roamrunctl MCP returned no content.");
  return { content };
}

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((entry) => entry.type === "text").map((entry) => entry.text ?? "").join("\n");
}

function requireLook(device: string, chat: string): Look {
  const look = looks.get(device);
  if (!look || look.chat !== chat || Date.now() - look.at >= LOOK_MAX_AGE_MS) {
    looks.delete(device);
    throw new Error("A current screenshot is required before this iPhone action. Call mobile.screenshot on the same device and chat, then act within 55 seconds.");
  }
  // Consume before sending. A transport error does not prove the action failed.
  looks.delete(device);
  return look;
}

export async function roamrunctlScreenshot(device: string, chat: string): Promise<{ bytes: Buffer; width: number; height: number; lookId: number }> {
  looks.delete(device);
  const result = await tool("look", { device: roamrunctlAlias(device) });
  const details = textFrom(result);
  const size = details.match(/(\d+)\s*x\s*(\d+)[\s\S]{0,90}?\blook\s+(\d+)\b/);
  const image = result.content.find((entry) => entry.type === "image");
  if (!size || !image || image.type !== "image" || image.mimeType !== "image/jpeg" || typeof image.data !== "string") {
    throw new Error("roamrunctl look did not return a JPEG, dimensions, and a look ID.");
  }
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("roamrunctl returned an invalid or oversized JPEG screenshot.");
  }
  const width = Number(size[1]), height = Number(size[2]), lookId = Number(size[3]);
  if (!Number.isSafeInteger(lookId) || width < 1 || height < 1) throw new Error("Invalid roamrunctl screenshot metadata.");
  looks.set(device, { id: lookId, chat, at: Date.now(), width, height });
  return { bytes, width, height, lookId };
}

function coordinates(look: Look, x: number, y: number) {
  if (![x, y].every((n) => Number.isFinite(n)) || x < 0 || y < 0 || x >= look.width || y >= look.height) {
    throw new Error("iPhone coordinates must be inside the most recently captured image (image pixels).");
  }
  return { x: Math.round(x), y: Math.round(y) };
}

export async function roamrunctlTap(device: string, chat: string, x: number, y: number): Promise<void> {
  const look = requireLook(device, chat);
  const point = coordinates(look, x, y);
  await tool("tap", { device: roamrunctlAlias(device), look: look.id, ...point });
}

export async function roamrunctlSwipe(device: string, chat: string, x1: number, y1: number, x2: number, y2: number, duration: number): Promise<void> {
  const look = requireLook(device, chat);
  const start = coordinates(look, x1, y1), end = coordinates(look, x2, y2);
  const milliseconds = Math.min(5000, Math.max(50, Math.round(duration)));
  await tool("swipe", { device: roamrunctlAlias(device), look: look.id, x1: start.x, y1: start.y, x2: end.x, y2: end.y, milliseconds });
}

export async function roamrunctlType(device: string, chat: string, text: string): Promise<void> {
  const look = requireLook(device, chat);
  const name = /[^\x00-\x7f]/.test(text) ? "paste" : "type";
  await tool(name, { device: roamrunctlAlias(device), look: look.id, text });
}

export async function roamrunctlPress(device: string): Promise<void> {
  looks.delete(device);
  await tool("press", { device: roamrunctlAlias(device), button: "home" });
}

export async function roamrunctlLaunch(device: string, bundle: string): Promise<void> {
  looks.delete(device);
  await tool("launch", { device: roamrunctlAlias(device), bundle });
}

export async function roamrunctlElements(device: string): Promise<string[]> {
  looks.delete(device);
  const result = await tool("elements", { device: roamrunctlAlias(device), limit: 250 });
  return textFrom(result).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export async function roamrunctlWait(device: string, target: string, timeoutMs: number): Promise<void> {
  if (/^@?e\d+$/.test(target)) throw new Error("Element refs are unavailable on roamrunctl; wait for visible text instead.");
  const deadline = Date.now() + timeoutMs;
  do {
    const labels = await roamrunctlElements(device);
    if (labels.some((label) => label.toLocaleLowerCase().includes(target.toLocaleLowerCase()))) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))));
    requestSignal()?.throwIfAborted();
  } while (Date.now() < deadline);
  throw new Error("roamrunctl wait timed out; target text was not observed.");
}

// Test teardown only. Production sessions are closed when the MCP server exits.
export async function closeRoamrunctlSession(): Promise<void> {
  const connected = session;
  session = undefined;
  looks.clear();
  if (connected) await connected.client.close();
}
