import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
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

let detectedIosDevelopmentTeamPromise: Promise<string | null> | null = null;

function certificateTeamId(certificate: X509Certificate): string | null {
  const line = certificate.subject.split(/\r?\n/).find((entry) => entry.startsWith("OU="));
  const value = line?.slice(3).trim();
  return value || null;
}

async function detectIosDevelopmentTeam(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const [{ stdout: identitiesOutput }, { stdout: certificatesOutput }] = await Promise.all([
      execFileAsync("security", ["find-identity", "-v", "-p", "codesigning"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync("security", ["find-certificate", "-a", "-c", "Apple Development", "-p"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }),
    ]);
    const validFingerprints = new Set(
      identitiesOutput
        .split(/\r?\n/)
        .filter((line) => line.includes("Apple Development:"))
        .flatMap((line) => line.match(/\b[0-9A-F]{40}\b/i) ?? [])
        .map((fingerprint) => fingerprint.toUpperCase()),
    );
    if (validFingerprints.size === 0) return null;

    const teams = new Set<string>();
    for (const match of certificatesOutput.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)) {
      try {
        const certificate = new X509Certificate(match[0]);
        const fingerprint = certificate.fingerprint.replaceAll(":", "").toUpperCase();
        if (!validFingerprints.has(fingerprint)) continue;
        const team = certificateTeamId(certificate);
        if (team) teams.add(team);
      } catch {
        // Ignore malformed or unrelated keychain entries.
      }
    }
    return teams.size === 1 ? [...teams][0] : null;
  } catch {
    return null;
  }
}

async function iosRunOptions(): Promise<RunJsonOptions> {
  const explicitTeam = process.env.AGENT_DEVICE_IOS_TEAM_ID?.trim();
  const team = explicitTeam || await (detectedIosDevelopmentTeamPromise ??= detectIosDevelopmentTeam());
  if (!team) return { stateDir: iosAgentStateDir() };
  const bundleId = process.env.AGENT_DEVICE_IOS_BUNDLE_ID?.trim() || "com.localdevmcp.agentdevice.runner";
  return {
    stateDir: iosAgentStateDir(),
    env: {
      AGENT_DEVICE_IOS_TEAM_ID: team,
      AGENT_DEVICE_IOS_BUNDLE_ID: bundleId,
    },
  };
}

async function closeIosSessionIfPresent(udid: string): Promise<void> {
  const session = iosSessionName(udid);
  try {
    await runJson(["close", "--session", session, "--json"], 30_000, await iosRunOptions());
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
  ], 60_000, await iosRunOptions());
  return session;
}

async function runBoundIos(udid: string, commandArgs: string[], timeoutMs = 120_000): Promise<AgentDevicePayload> {
  const session = iosSessionName(udid);
  return await runJson([...commandArgs, "--session", session, "--json"], timeoutMs, await iosRunOptions());
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

const androidSnapshotCache = new Map<string, AgentDeviceNode[]>();

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

async function runOnAndroid(
  serial: string,
  adbPath: string,
  commandArgs: string[],
  timeoutMs = 120_000,
): Promise<AgentDevicePayload> {
  return await runJson(
    [...commandArgs, "--platform", "android", "--serial", serial, "--json"],
    timeoutMs,
    androidRunOptions(adbPath),
  );
}

export async function agentAndroidSnapshot(serial: string, adbPath: string): Promise<AgentDeviceNode[]> {
  const payload = await runOnAndroid(serial, adbPath, ["snapshot"], 120_000);
  const nodes = payloadNodes(payload);
  androidSnapshotCache.set(serial, nodes);
  return nodes;
}

type AndroidSelectorCondition = Readonly<{ key: string; value: string }>;

function parseAndroidSelectorGroup(value: string): AndroidSelectorCondition[] | null {
  const conditions: AndroidSelectorCondition[] = [];
  const token = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(value)) !== null) {
    const raw = match[2];
    const unquoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1).replace(/\\([\\"'])/g, "$1")
      : raw;
    conditions.push({ key: match[1].toLowerCase(), value: unquoted });
  }
  if (conditions.length === 0) return null;
  const remainder = value
    .replace(token, "")
    .replace(/&&/g, "")
    .trim();
  return remainder.length === 0 ? conditions : null;
}

function androidNodeRole(node: AgentDeviceNode): string {
  const type = (node.type ?? "").split(".").at(-1)?.toLowerCase() ?? "";
  if (type === "radiobutton") return "radio";
  if (type === "checkbox") return "checkbox";
  if (type === "edittext") return "textbox";
  if (type === "textview") return "text";
  if (type === "imageview") return "image";
  if (type === "switch") return "switch";
  if (type.endsWith("button")) return "button";
  return type;
}

function booleanNodeValue(node: AgentDeviceNode, key: string): boolean | undefined {
  const value = node[key];
  return typeof value === "boolean" ? value : undefined;
}

function matchesAndroidCondition(node: AgentDeviceNode, condition: AndroidSelectorCondition): boolean {
  switch (condition.key) {
    case "id": return node.identifier === condition.value;
    case "label": return node.label === condition.value;
    case "text": return node.label === condition.value || node.value === condition.value;
    case "value": return node.value === condition.value;
    case "role": return androidNodeRole(node) === condition.value.toLowerCase();
    case "enabled":
    case "hittable":
    case "visible": {
      const key = condition.key === "visible" ? "visibleToUser" : condition.key;
      const expected = condition.value.toLowerCase() === "true";
      return booleanNodeValue(node, key) === expected;
    }
    default: return false;
  }
}

function resolveAndroidTarget(nodes: AgentDeviceNode[], target: string): AgentDeviceNode | null {
  const trimmed = target.trim();
  const ref = normalizeAgentRef(trimmed);
  if (ref) {
    const value = ref.slice(1);
    return nodes.find((node) => node.ref === value || node.ref === ref) ?? null;
  }

  if (looksLikeAgentSelector(trimmed)) {
    const groups = trimmed.split(/\s*\|\|\s*/).map(parseAndroidSelectorGroup);
    if (groups.some((group) => group === null)) return null;
    return nodes.find((node) => groups.some((group) => group!.every((condition) => matchesAndroidCondition(node, condition)))) ?? null;
  }

  const exact = nodes.find((node) => node.label === trimmed || node.value === trimmed);
  if (exact) return exact;
  const partial = nodes.filter((node) => node.label?.includes(trimmed) || node.value?.includes(trimmed));
  return partial.length === 1 ? partial[0] : null;
}

function tappableCenter(node: AgentDeviceNode): { x: number; y: number } | null {
  const rect = node.rect;
  if (!rect) return null;
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if ((width ?? 0) <= 0 || (height ?? 0) <= 0) return null;
  return { x: Math.round(x! + width! / 2), y: Math.round(y! + height! / 2) };
}

export async function agentAndroidTapTarget(serial: string, adbPath: string, target: string): Promise<void> {
  const ref = normalizeAgentRef(target);
  const nodes = ref && androidSnapshotCache.has(serial)
    ? androidSnapshotCache.get(serial)!
    : await agentAndroidSnapshot(serial, adbPath);
  const node = resolveAndroidTarget(nodes, target);
  if (!node) {
    throw new AgentDeviceCommandError(
      { error: { code: "TARGET_NOT_FOUND", message: `Android target was not found: ${target}` } },
      "Android target was not found",
    );
  }
  const center = tappableCenter(node);
  if (!center) {
    throw new AgentDeviceCommandError(
      { error: { code: "TARGET_NOT_TAPPABLE", message: `Android target has no tappable bounds: ${target}` } },
      "Android target has no tappable bounds",
    );
  }
  await execFileAsync(adbPath, [
    "-s", serial, "shell", "input", "tap", String(center.x), String(center.y),
  ], { maxBuffer: 2 * 1024 * 1024, timeout: 20_000 });
}

export async function agentAndroidWait(serial: string, adbPath: string, target: string, timeoutMs = 10_000): Promise<void> {
  const timeout = Math.max(1, Math.round(timeoutMs));
  const deadline = Date.now() + timeout;
  while (true) {
    const nodes = await agentAndroidSnapshot(serial, adbPath);
    if (resolveAndroidTarget(nodes, target)) return;
    if (Date.now() >= deadline) {
      throw new AgentDeviceCommandError(
        { error: { code: "WAIT_TIMEOUT", message: `Timed out waiting for Android target: ${target}` } },
        "Timed out waiting for Android target",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
}
