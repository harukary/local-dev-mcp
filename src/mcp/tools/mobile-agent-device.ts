import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentIosPhysicalDevice = {
  id: string;
  name: string;
  booted: boolean;
};

export type AgentDeviceNode = {
  ref?: string;
  type?: string;
  label?: string;
  identifier?: string;
  value?: string;
  enabled?: boolean;
  hittable?: boolean;
  index?: number;
  depth?: number;
  parentIndex?: number;
  rect?: { x?: number; y?: number; width?: number; height?: number };
  [key: string]: unknown;
};

type AgentDevicePayload = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    hint?: string;
    diagnosticId?: string;
    logPath?: string;
    details?: unknown;
  };
};

type RunJsonOptions = {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
};

export class AgentDeviceCommandError extends Error {
  readonly code?: string;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(payload: AgentDevicePayload, fallback: string) {
    super(payload.error?.message || fallback);
    this.name = "AgentDeviceCommandError";
    this.code = payload.error?.code;
    this.hint = payload.error?.hint;
    this.details = {
      diagnostic_id: payload.error?.diagnosticId,
      log_path: payload.error?.logPath,
      details: payload.error?.details,
    };
  }
}

function parseJson(value: unknown): AgentDevicePayload | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return JSON.parse(value) as AgentDevicePayload;
  } catch {
    return null;
  }
}

function agentDeviceBin(): string {
  const override = process.env.LOCAL_DEV_MCP_AGENT_DEVICE_BIN?.trim();
  if (override) return override;
  return fileURLToPath(new URL("../../../node_modules/.bin/agent-device", import.meta.url));
}

async function runJson(args: string[], timeoutMs = 120_000, options: RunJsonOptions = {}): Promise<AgentDevicePayload> {
  const cliArgs = options.stateDir ? ["--state-dir", options.stateDir, ...args] : args;
  try {
    const { stdout } = await execFileAsync(agentDeviceBin(), cliArgs, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    const payload = parseJson(stdout);
    if (!payload) throw new Error("agent-device returned non-JSON output");
    if (payload.success === false) throw new AgentDeviceCommandError(payload, "agent-device command failed");
    return payload;
  } catch (err) {
    if (err instanceof AgentDeviceCommandError) throw err;
    const stdout = (err as { stdout?: unknown })?.stdout;
    const parsed = parseJson(stdout);
    if (parsed?.error) throw new AgentDeviceCommandError(parsed, "agent-device command failed");
    throw err;
  }
}

export async function isAgentDeviceAvailable(): Promise<boolean> {
  try {
    await execFileAsync(agentDeviceBin(), ["--version"], { maxBuffer: 1024 * 1024, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function listAgentIosPhysicalDevices(): Promise<AgentIosPhysicalDevice[]> {
  if (!(await isAgentDeviceAvailable())) return [];
  try {
    const payload = await runJson(["devices", "--platform", "ios", "--json"], 30_000);
    const devices = Array.isArray(payload.data?.devices) ? payload.data?.devices : [];
    return devices
      .filter((device): device is Record<string, unknown> => !!device && typeof device === "object")
      .filter((device) => device.kind === "device" && device.platform === "ios")
      .flatMap((device) => {
        const id = typeof device.id === "string" ? device.id : "";
        const name = typeof device.name === "string" ? device.name : id;
        if (!id) return [];
        return [{ id, name, booted: device.booted === true }];
      });
  } catch {
    return [];
  }
}

function iosSessionName(udid: string): string {
  const safe = udid.replace(/[^A-Za-z0-9_-]/g, "-");
  return `local-dev-mcp-ios-${safe}`;
}

function iosAgentStateDir(): string {
  return join(homedir(), ".local-dev-mcp", "runtime", "agent-device-ios");
}

function iosRunOptions(): RunJsonOptions {
  return { stateDir: iosAgentStateDir() };
}

async function closeIosSessionIfPresent(udid: string): Promise<void> {
  const session = iosSessionName(udid);
  try {
    await runJson(["close", "--session", session, "--json"], 30_000, iosRunOptions());
  } catch (err) {
    if (err instanceof AgentDeviceCommandError && err.code === "SESSION_NOT_FOUND") return;
    throw err;
  }
}

async function openIosSession(udid: string, target: string): Promise<string> {
  const session = iosSessionName(udid);
  await runJson([
    "open",
    target,
    "--platform", "ios",
    "--udid", udid,
    "--session", session,
    "--json",
  ], 60_000, iosRunOptions());
  return session;
}

async function runBoundIos(udid: string, commandArgs: string[], timeoutMs = 120_000): Promise<AgentDevicePayload> {
  const session = iosSessionName(udid);
  return await runJson([...commandArgs, "--session", session, "--json"], timeoutMs, iosRunOptions());
}

export async function agentIosScreenshot(udid: string, outputPath: string): Promise<void> {
  await runBoundIos(udid, ["screenshot", outputPath], 120_000);
}

export async function agentIosSnapshot(udid: string): Promise<AgentDeviceNode[]> {
  const payload = await runBoundIos(udid, ["snapshot"], 120_000);
  return payloadNodes(payload);
}

export async function agentIosTap(udid: string, x: number, y: number): Promise<void> {
  await runBoundIos(udid, ["click", String(Math.round(x)), String(Math.round(y))]);
}

export async function agentIosTapTarget(udid: string, target: string): Promise<void> {
  await runBoundIos(udid, agentTapTargetArgs(target));
}

export async function agentIosType(udid: string, text: string): Promise<void> {
  await runBoundIos(udid, ["type", text]);
}

export async function agentIosOpenUrl(udid: string, url: string): Promise<void> {
  await closeIosSessionIfPresent(udid);
  await openIosSession(udid, url);
}

export async function agentIosLaunchApp(udid: string, app: string): Promise<void> {
  await closeIosSessionIfPresent(udid);
  await openIosSession(udid, app);
}

export async function agentIosSwipe(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs = 500,
): Promise<void> {
  await runBoundIos(udid, [
    "swipe",
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
    String(Math.max(0, Math.round(durationMs))),
  ]);
}

export async function agentIosPress(udid: string, key: "home" | "back"): Promise<void> {
  await runBoundIos(udid, [key]);
}

export async function agentIosWait(udid: string, target: string, timeoutMs = 10_000): Promise<void> {
  await runBoundIos(
    udid,
    agentWaitTargetArgs(target, timeoutMs),
    Math.max(15_000, timeoutMs + 5_000),
  );
}

function normalizeAgentRef(target: string): string | null {
  const trimmed = target.trim();
  if (/^@e\d+$/.test(trimmed)) return trimmed;
  if (/^e\d+$/.test(trimmed)) return `@${trimmed}`;
  return null;
}

function looksLikeAgentSelector(target: string): boolean {
  const trimmed = target.trim();
  return /^(?:(?:id|role|text|label|value)\s*=|(?:visible|hidden|editable|selected|enabled|hittable)(?:\s*=|\s*(?:$|\|\|)))/.test(trimmed);
}

function agentTapTargetArgs(target: string): string[] {
  const trimmed = target.trim();
  if (!trimmed) throw new AgentDeviceCommandError({ error: { code: "INVALID_ARGS", message: "Mobile target cannot be empty" } }, "Invalid mobile target");
  const ref = normalizeAgentRef(trimmed);
  if (ref) return ["click", ref];
  if (looksLikeAgentSelector(trimmed)) return ["click", trimmed];
  return ["find", trimmed, "click", "--first"];
}

function agentWaitTargetArgs(target: string, timeoutMs: number): string[] {
  const trimmed = target.trim();
  if (!trimmed) throw new AgentDeviceCommandError({ error: { code: "INVALID_ARGS", message: "Mobile wait target cannot be empty" } }, "Invalid mobile wait target");
  const timeout = String(Math.max(1, Math.round(timeoutMs)));
  const ref = normalizeAgentRef(trimmed);
  if (ref) return ["wait", ref, timeout];
  if (looksLikeAgentSelector(trimmed)) return ["wait", trimmed, timeout];
  return ["wait", "text", trimmed, timeout];
}

function payloadNodes(payload: AgentDevicePayload): AgentDeviceNode[] {
  const nodes = payload.data?.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((node): node is AgentDeviceNode => !!node && typeof node === "object")
    : [];
}

function androidSessionName(serial: string): string {
  const safe = serial.replace(/[^A-Za-z0-9_-]/g, "-");
  return `local-dev-mcp-android-${safe}`;
}

function androidAgentStateDir(): string {
  return join(homedir(), ".local-dev-mcp", "runtime", "agent-device-android");
}

function androidRunOptions(adbPath: string): RunJsonOptions {
  const currentPath = process.env.PATH ?? "";
  return {
    stateDir: androidAgentStateDir(),
    env: {
      PATH: [dirname(adbPath), currentPath].filter(Boolean).join(delimiter),
    },
  };
}

async function openAndroidSession(serial: string, adbPath: string): Promise<string> {
  const session = androidSessionName(serial);
  await runJson([
    "open",
    "--platform", "android",
    "--serial", serial,
    "--session", session,
    "--json",
  ], 60_000, androidRunOptions(adbPath));
  return session;
}

async function runBoundAndroid(
  serial: string,
  adbPath: string,
  commandArgs: string[],
  timeoutMs = 120_000,
): Promise<AgentDevicePayload> {
  const session = androidSessionName(serial);
  const options = androidRunOptions(adbPath);
  try {
    return await runJson([...commandArgs, "--session", session, "--json"], timeoutMs, options);
  } catch (err) {
    if (!(err instanceof AgentDeviceCommandError) || err.code !== "SESSION_NOT_FOUND") throw err;
    await openAndroidSession(serial, adbPath);
    return await runJson([...commandArgs, "--session", session, "--json"], timeoutMs, options);
  }
}

export async function agentAndroidSnapshot(serial: string, adbPath: string): Promise<AgentDeviceNode[]> {
  const payload = await runBoundAndroid(serial, adbPath, ["snapshot"], 120_000);
  return payloadNodes(payload);
}

export async function agentAndroidTapTarget(serial: string, adbPath: string, target: string): Promise<void> {
  await runBoundAndroid(serial, adbPath, agentTapTargetArgs(target));
}

export async function agentAndroidWait(serial: string, adbPath: string, target: string, timeoutMs = 10_000): Promise<void> {
  await runBoundAndroid(
    serial,
    adbPath,
    agentWaitTargetArgs(target, timeoutMs),
    Math.max(15_000, timeoutMs + 5_000),
  );
}
