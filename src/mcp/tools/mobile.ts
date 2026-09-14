import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { applyWorkingDirectory } from "../../project/working-directory.js";
import { handleImageRead } from "./image-read.js";
import { observeAfterAction } from "../observation.js";
import { requestSignal } from "../request-context.js";
import {
  AgentDeviceCommandError,
  agentAndroidSnapshot,
  agentAndroidTapTarget,
  agentAndroidWait,
  agentIosLaunchApp,
  agentIosOpenUrl,
  agentIosPress,
  agentIosScreenshot,
  agentIosSnapshot,
  agentIosSwipe,
  agentIosTap,
  agentIosTapTarget,
  agentIosType,
  agentIosWait,
  isAgentDeviceAvailable,
  listAgentIosPhysicalDevices,
  type AgentDeviceNode,
} from "./mobile-agent-device.js";

const execFileBase = promisify(execFile);
const execFileAsync: typeof execFileBase = ((file: string, args: string[], options: Record<string, unknown> = {}) => execFileBase(file, args, { timeout: 30_000, signal: requestSignal(), ...options })) as typeof execFileBase;

type MobileDevice = {
  id: string;
  name: string;
  platform: "ios" | "android";
  type: "simulator" | "emulator" | "device";
  state?: string;
  backend?: "ios_simctl" | "ios_agent_device" | "android_adb";
};

type ImageContent = { type: "image"; data: string; mimeType: string };
type JsonResult = {
  structuredContent: unknown;
  content: [{ type: "text"; text: string }, ...ImageContent[]];
};

type MobileObserve = "none" | "after" | "snapshot";
type MobileWaitFor = { target: string; timeout_ms?: number };

function jsonResult(value: unknown, imageContent: ImageContent[] = []): JsonResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }, ...imageContent],
  };
}

function extractImageContent(result: { content: Array<{ type: string; data?: string; mimeType?: string }> }): ImageContent[] {
  const image = result.content.find(
    (item) => item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string"
  );
  return image ? [{ type: "image", data: image.data!, mimeType: image.mimeType! }] : [];
}

function jsonError(code: string, message: string, details?: unknown) {
  return {
    structuredContent: { error: { code, message, details } },
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, details } }) }],
    isError: true,
  };
}

function mobileError(code: string, err: unknown, details?: unknown) {
  deviceCache = undefined;
  if (err instanceof AgentDeviceCommandError) {
    return jsonError(code, err.message, {
      ...((details && typeof details === "object") ? details : {}),
      backend: "agent-device",
      agent_code: err.code,
      hint: err.hint,
      agent_details: err.details,
    });
  }
  return jsonError(code, err instanceof Error ? err.message : String(err), details);
}

function activeProjectId(ctx: AppContext, chatContextId: string): string | undefined {
  const store = ctx.contextStore as {
    getActiveProject?: (chatContextId: string, isAvailable: (projectId: string) => boolean) => string | undefined;
    getCurrentProject?: (chatContextId: string) => string | undefined;
    clearCurrentProject?: (chatContextId: string) => void;
  };
  const isAvailable = (projectId: string) => ctx.registry.has(projectId);
  return typeof store.getActiveProject === "function"
    ? store.getActiveProject(chatContextId, isAvailable)
    : store.getCurrentProject?.(chatContextId);
}

function getProject(ctx: AppContext, chatContextId: string): ProjectConfig | { error: ReturnType<typeof jsonError> } {
  const projectId = activeProjectId(ctx, chatContextId);
  if (!projectId) return { error: jsonError("PROJECT_NOT_SELECTED", "No project is selected for this chat. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  const project = ctx.registry.get(projectId);
  if (!project) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return { error: jsonError("PROJECT_NOT_SELECTED", "The selected project is no longer available. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  return applyWorkingDirectory(project, ctx.contextStore.getWorkingDirectory?.(chatContextId));
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function resolveAdbPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("bash", ["-lc", "command -v adb"], { maxBuffer: 1024 * 1024 });
    const fromPath = stdout.trim();
    if (fromPath) return fromPath;
  } catch {
    // launchd often omits Android platform-tools from PATH.
  }

  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library", "Android", "sdk"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const root of sdkRoots) {
    const candidate = join(root, "platform-tools", "adb");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next SDK root.
    }
  }
  return null;
}

async function artifactPath(project: ProjectConfig, prefix: string): Promise<{ absolutePath: string; relativePath: string }> {
  const dir = join(project.hostRoot, "generated", "local-dev-mcp", "mobile");
  await mkdir(dir, { recursive: true });
  const absolutePath = join(dir, `${prefix}-${Date.now()}.png`);
  return { absolutePath, relativePath: relative(project.hostRoot, absolutePath).replace(/\\/g, "/") };
}

async function listIosSimulators(): Promise<MobileDevice[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "available", "--json"], { maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>> };
    const devices: MobileDevice[] = [];
    for (const runtimeDevices of Object.values(parsed.devices ?? {})) {
      for (const device of runtimeDevices) {
        if (device.isAvailable === false) continue;
        devices.push({ id: device.udid, name: device.name, platform: "ios", type: "simulator", state: device.state, backend: "ios_simctl" });
      }
    }
    return devices;
  } catch (error) { throw new Error(`iOS simulator discovery failed: ${error instanceof Error ? error.message : String(error)}`); }
}

async function listIosPhysicalDevices(): Promise<MobileDevice[]> {
  const devices = await listAgentIosPhysicalDevices();
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    platform: "ios",
    type: "device",
    state: device.booted ? "Connected" : "Unavailable",
    backend: "ios_agent_device",
  }));
}

async function listAndroidDevices(): Promise<MobileDevice[]> {
  try {
    const adb = await resolveAdbPath();
    if (!adb) throw new Error("ADB is not installed or configured.");
    const { stdout } = await execFileAsync(adb, ["devices", "-l"], { maxBuffer: 2 * 1024 * 1024 });
    const devices: MobileDevice[] = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [id, state, ...rest] = trimmed.split(/\s+/);
      if (!id || !state) continue;
      const isEmulator = id.startsWith("emulator-") || rest.some((part) => part.includes("model:sdk"));
      devices.push({
        id,
        name: rest.find((part) => part.startsWith("model:"))?.slice(6) || id,
        platform: "android",
        type: isEmulator ? "emulator" : "device",
        state,
        backend: "android_adb",
      });
    }
    return devices;
  } catch (error) { throw new Error(`Android discovery failed: ${error instanceof Error ? error.message : String(error)}`); }
}

async function listDevices() {
  const sources = ["ios_simctl", "ios_agent_device", "android_adb"];
  const results = await Promise.allSettled([
    listIosSimulators(),
    listIosPhysicalDevices(),
    listAndroidDevices(),
  ]);
  return {
    devices: results.flatMap(result => result.status === "fulfilled" ? result.value : []),
    discovery: results.map((result, index) => ({ backend: sources[index], ok: result.status === "fulfilled", ...(result.status === "rejected" ? { error: result.reason instanceof Error ? result.reason.message : String(result.reason) } : {}) })),
  };
}

let deviceCache: { devices: MobileDevice[]; expires: number } | undefined;
const mobileQueues = new Map<string, Promise<unknown>>();
const mobileSnapshots = new Map<string, { id: string; chat: string; capturedAt: number }>();
const MOBILE_READ_ACTIONS = new Set(["mobile.snapshot", "mobile.screenshot", "mobile.current_app", "mobile.logs", "mobile.wait"]);

async function resolveDevice(deviceIdOrName?: string): Promise<MobileDevice | null> {
  const cached = deviceCache && deviceCache.expires > Date.now() ? deviceCache.devices : undefined;
  const exactCached = deviceIdOrName ? cached?.find(device => device.id === deviceIdOrName) : undefined;
  if (exactCached) return exactCached;
  const devices = cached ?? (await listDevices()).devices;
  deviceCache = { devices, expires: Date.now() + 10_000 };
  if (!deviceIdOrName) {
    const ready = devices.filter(device => device.state === "Booted" || device.state === "device" || device.state === "Connected");
    if (ready.length > 1) throw new Error("Multiple mobile devices are ready. Specify device by exact ID.");
    return ready[0] ?? (devices.length === 1 ? devices[0] : null);
  }
  const exact = devices.filter(device => device.id === deviceIdOrName || device.name === deviceIdOrName);
  if (exact.length === 1) return exact[0];
  const needle = deviceIdOrName.toLowerCase();
  const candidates = exact.length ? exact : devices.filter(device => device.id.toLowerCase().includes(needle) || device.name.toLowerCase().includes(needle));
  if (candidates.length > 1) throw new Error("Mobile device name is ambiguous. Specify an exact device ID.");
  return candidates[0] ?? null;
}

export async function runMobileToolOperation<T>(ctx: AppContext, chat: string, name: string, args: Record<string, unknown>, operation: () => Promise<T>): Promise<T | ReturnType<typeof jsonError>> {
  if (name === "mobile.status" || name === "mobile.list_devices") return await operation();
  const previousDevice = ctx.contextStore.get(chat)?.mobileDeviceId;
  const device = await resolveDevice(typeof args.device === "string" ? args.device : previousDevice);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No matching mobile device is available.");
  const previous = mobileQueues.get(device.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    requestSignal()?.throwIfAborted();
    const snapshot = mobileSnapshots.get(device.id);
    if (name === "mobile.tap_element" && typeof args.target === "string" && /^@?e\d+$/.test(args.target.trim())) {
      if (!snapshot || snapshot.chat !== chat || Date.now() - snapshot.capturedAt > 60_000 || (args.snapshot_id !== undefined && args.snapshot_id !== snapshot.id)) {
        return jsonError("STALE_SNAPSHOT", "Capture a new mobile.snapshot before using an element ref. Device actions and other chats invalidate prior refs.");
      }
    }
    if (!MOBILE_READ_ACTIONS.has(name) || name === "mobile.wait") mobileSnapshots.delete(device.id);
    args.device = device.id;
    const context = ctx.contextStore.getOrCreate(chat);
    if (context.mobileDeviceId !== device.id) {
      context.mobileDeviceId = device.id;
      await ctx.contextStore.save();
    }
    return await operation();
  });
  mobileQueues.set(device.id, current);
  try { return await current; }
  finally { if (mobileQueues.get(device.id) === current) mobileQueues.delete(device.id); }
}

function isPhysicalIos(device: MobileDevice): boolean {
  return device.platform === "ios" && device.type === "device";
}

async function screenshotIosSimulator(project: ProjectConfig, device: MobileDevice) {
  const output = await artifactPath(project, "ios-shot");
  await execFileAsync("xcrun", ["simctl", "io", device.id, "screenshot", output.absolutePath], { maxBuffer: 10 * 1024 * 1024 });
  return output;
}

async function screenshotIosPhysical(project: ProjectConfig, device: MobileDevice) {
  const output = await artifactPath(project, "ios-device-shot");
  await agentIosScreenshot(device.id, output.absolutePath);
  return output;
}

async function screenshotAndroid(project: ProjectConfig, device: MobileDevice) {
  const output = await artifactPath(project, "android-shot");
  const adb = await resolveAdbPath();
  if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
  const { stdout } = await execFileAsync(adb, ["-s", device.id, "exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  } as Parameters<typeof execFile>[2]);
  await writeFile(output.absolutePath, stdout as Buffer);
  return output;
}

async function screenshotDevice(project: ProjectConfig, device: MobileDevice) {
  if (device.platform === "android") return await screenshotAndroid(project, device);
  return isPhysicalIos(device)
    ? await screenshotIosPhysical(project, device)
    : await screenshotIosSimulator(project, device);
}

export async function handleMobileStatus(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const [xcrunAvailable, adbPath, agentDeviceAvailable, discovery] = await Promise.all([
    commandExists("xcrun"),
    resolveAdbPath(),
    isAgentDeviceAvailable(),
    listDevices(),
  ]);
  return jsonResult({
    project_id: project.projectId,
    backends: {
      ios_simctl: { available: xcrunAvailable },
      ios_physical_agent_device: { available: agentDeviceAvailable },
      android_adb: { available: !!adbPath, path: adbPath },
      android_agent_device: { available: agentDeviceAvailable && !!adbPath, adb_path: adbPath },
    },
    ...discovery,
    artifact_dir: "generated/local-dev-mcp/mobile",
  });
}

export async function handleMobileListDevices(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  return jsonResult({ project_id: project.projectId, ...await listDevices() });
}

export async function handleMobileScreenshot(ctx: AppContext, chatContextId: string, args: { device?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    const screenshot = await screenshotDevice(project, device);
    const imageResult = await handleImageRead(ctx, chatContextId, { path: screenshot.relativePath });
    const imageText = imageResult.content[0]?.type === "text" ? imageResult.content[0].text : "{}";
    const screenshotMetadata = JSON.parse(String(imageText || "{}"));
    const imageContent = extractImageContent(imageResult);
    return jsonResult({
      ok: true,
      project_id: project.projectId,
      action: "mobile.screenshot",
      device,
      screenshot: screenshotMetadata,
      image_read: { path: screenshot.relativePath },
    }, imageContent);
  } catch (err) {
    return mobileError("MOBILE_SCREENSHOT_FAILED", err, { device });
  }
}

function validateUrlForMobile(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function screenshotPayload(ctx: AppContext, chatContextId: string, project: ProjectConfig, device: MobileDevice, action: string, extra: Record<string, unknown> = {}) {
  const screenshot = await screenshotDevice(project, device);
  const imageResult = await handleImageRead(ctx, chatContextId, { path: screenshot.relativePath });
  const imageText = imageResult.content[0]?.type === "text" ? imageResult.content[0].text : "{}";
  if (imageResult.isError) throw new Error(`Screenshot saved but image inspection failed: ${imageText}`);
  const screenshotMetadata = JSON.parse(String(imageText || "{}"));
  const imageContent = extractImageContent(imageResult);
  return jsonResult({
    ok: true,
    project_id: project.projectId,
    action,
    device,
    ...extra,
    screenshot: screenshotMetadata,
    image_read: { path: screenshot.relativePath },
  }, imageContent);
}

async function observeOrJson(ctx: AppContext, chatContextId: string, project: ProjectConfig, device: MobileDevice, action: string, observe: MobileObserve | undefined, payload: Record<string, unknown>, waitFor?: MobileWaitFor) {
  return await observeAfterAction(action, async () => {
    const waited = waitFor ? await handleMobileWait(ctx, chatContextId, { device: device.id, target: waitFor.target, timeout_ms: waitFor.timeout_ms }) : undefined;
    if (waited && "isError" in waited && waited.isError) return waited;
    const wait = waited && "structuredContent" in waited ? waited.structuredContent : undefined;
    const details = { ...payload, action_applied: true, ...(wait === undefined ? {} : { wait }) };
    if (observe === "none" || (observe === undefined && waitFor)) return jsonResult({ ok: true, project_id: project.projectId, action, device, ...details });
    if (observe === "snapshot") {
      const snapshot = await handleMobileSnapshot(ctx, chatContextId, { device: device.id, limit: 100 });
      if ("isError" in snapshot && snapshot.isError) return snapshot;
      const data = "structuredContent" in snapshot ? snapshot.structuredContent : {};
      return jsonResult({ ...(data && typeof data === "object" ? data : {}), ...details, action });
    }
    return await screenshotPayload(ctx, chatContextId, project, device, action, details);
  });
}

export async function handleMobileBoot(ctx: AppContext, chatContextId: string, args: { device?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No iOS simulator was found to boot.", { device: args.device });
  if (device.platform !== "ios" || device.type !== "simulator") return jsonError("MOBILE_BOOT_UNSUPPORTED", "mobile.boot supports iOS simulators only; physical devices are already running.", { device });
  try {
    if (device.state !== "Booted") {
      try {
        await execFileAsync("xcrun", ["simctl", "boot", device.id], { maxBuffer: 2 * 1024 * 1024 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("Unable to boot device in current state") && !message.includes("Booted")) throw err;
      }
    }
    try { await execFileAsync("open", ["-a", "Simulator"], { maxBuffer: 1024 * 1024 }); } catch { /* ignore */ }
    const refreshed = await resolveDevice(device.id);
    return jsonResult({ ok: true, project_id: project.projectId, action: "mobile.boot", device: refreshed ?? { ...device, state: "Booted" } });
  } catch (err) {
    return jsonError("MOBILE_BOOT_FAILED", err instanceof Error ? err.message : String(err), { device });
  }
}

export async function handleMobileOpenUrl(ctx: AppContext, chatContextId: string, args: { device?: string; url?: string; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const url = validateUrlForMobile(args.url ?? "");
  if (!url) return jsonError("INVALID_URL", "mobile.open_url requires a non-file URL.", { url: args.url });
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (isPhysicalIos(device)) {
      await agentIosOpenUrl(device.id, url);
    } else if (device.platform === "ios") {
      await execFileAsync("xcrun", ["simctl", "openurl", device.id, url], { maxBuffer: 2 * 1024 * 1024 });
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 800));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.open_url", args.observe, { url }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_OPEN_URL_FAILED", err, { device, url });
  }
}

export async function handleMobileTap(ctx: AppContext, chatContextId: string, args: { device?: string; x?: number; y?: number; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (typeof args.x !== "number" || typeof args.y !== "number") return jsonError("INVALID_COORDINATES", "mobile.tap requires numeric x and y coordinates.", { x: args.x, y: args.y });
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await agentIosTap(device.id, args.x, args.y);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "input", "tap", String(Math.round(args.x)), String(Math.round(args.y))], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.tap", args.observe, { x: Math.round(args.x), y: Math.round(args.y) }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_TAP_FAILED", err, { device, x: args.x, y: args.y });
  }
}

function androidInputText(text: string): string {
  return text.replace(/%/g, "%25").replace(/\s/g, "%s").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

export async function handleMobileType(ctx: AppContext, chatContextId: string, args: { device?: string; text?: string; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (args.text === undefined) return jsonError("MISSING_TEXT", "mobile.type requires text.");
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await agentIosType(device.id, args.text);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "input", "text", androidInputText(args.text)], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.type", args.observe, { text: args.text }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_TYPE_FAILED", err, { device });
  }
}

function nodeMatchesQuery(node: AgentDeviceNode, query: string): boolean {
  const needle = query.toLowerCase();
  return [node.ref, node.type, node.label, node.identifier, node.value]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}

export async function handleMobileSnapshot(ctx: AppContext, chatContextId: string, args: { device?: string; query?: string; limit?: number } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    let nodes: AgentDeviceNode[];
    if (device.platform === "ios") {
      nodes = await agentIosSnapshot(device.id);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      nodes = await agentAndroidSnapshot(device.id, adb);
    }
    const filtered = args.query ? nodes.filter((node) => nodeMatchesQuery(node, args.query!)) : nodes;
    const limit = Math.min(1000, Math.max(1, Math.round(args.limit ?? 250)));
    const snapshotId = randomUUID();
    if (mobileSnapshots.size >= 100) mobileSnapshots.delete(mobileSnapshots.keys().next().value!);
    mobileSnapshots.set(device.id, { id: snapshotId, chat: chatContextId, capturedAt: Date.now() });
    return jsonResult({
      ok: true,
      project_id: project.projectId,
      action: "mobile.snapshot",
      snapshot_id: snapshotId,
      device,
      total_nodes: nodes.length,
      matched_nodes: filtered.length,
      query: args.query ?? null,
      truncated: filtered.length > limit,
      nodes: filtered.slice(0, limit),
    });
  } catch (err) {
    return mobileError("MOBILE_SNAPSHOT_FAILED", err, { device });
  }
}

export async function handleMobileTapElement(ctx: AppContext, chatContextId: string, args: { device?: string; target?: string; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.target?.trim()) return jsonError("MISSING_TARGET", "mobile.tap_element requires a snapshot ref, text, or selector target.");
  const target = args.target.trim();
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await agentIosTapTarget(device.id, target);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await agentAndroidTapTarget(device.id, adb, target);
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.tap_element", args.observe, { target }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_TAP_ELEMENT_FAILED", err, { device, target });
  }
}

export async function handleMobileLaunchApp(ctx: AppContext, chatContextId: string, args: { device?: string; app?: string; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.app?.trim()) return jsonError("MISSING_APP", "mobile.launch_app requires an app name, bundle ID, or Android package.");
  const app = args.app.trim();
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await agentIosLaunchApp(device.id, app);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 800));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.launch_app", args.observe, { app }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_LAUNCH_APP_FAILED", err, { device, app });
  }
}

export async function handleMobileSwipe(ctx: AppContext, chatContextId: string, args: { device?: string; x1?: number; y1?: number; x2?: number; y2?: number; duration_ms?: number; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const coords = [args.x1, args.y1, args.x2, args.y2];
  if (coords.some((value) => typeof value !== "number")) return jsonError("INVALID_COORDINATES", "mobile.swipe requires numeric x1, y1, x2, and y2.", { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 });
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  const duration = Math.max(0, Math.round(args.duration_ms ?? 500));
  try {
    if (device.platform === "ios") {
      await agentIosSwipe(device.id, args.x1!, args.y1!, args.x2!, args.y2!, duration);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "input", "swipe", String(Math.round(args.x1!)), String(Math.round(args.y1!)), String(Math.round(args.x2!)), String(Math.round(args.y2!)), String(duration)], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.swipe", args.observe, { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, duration_ms: duration }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_SWIPE_FAILED", err, { device });
  }
}

export async function handleMobilePress(ctx: AppContext, chatContextId: string, args: { device?: string; key?: "home" | "back"; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (args.key !== "home" && args.key !== "back") return jsonError("INVALID_KEY", "mobile.press supports key=home or key=back.", { key: args.key });
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await agentIosPress(device.id, args.key);
    } else {
      const keyCode = args.key === "home" ? "KEYCODE_HOME" : "KEYCODE_BACK";
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "input", "keyevent", keyCode], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.press", args.observe, { key: args.key }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_PRESS_FAILED", err, { device, key: args.key });
  }
}

export function parseAndroidCurrentApp(output: string): { package_name: string; activity: string } | null {
  const patterns = [
    /mCurrentFocus=.*?\s(?:u\d+\s+)?([A-Za-z0-9._]+)\/([A-Za-z0-9._$]+)/,
    /mResumedActivity:.*?\s(?:u\d+\s+)?([A-Za-z0-9._]+)\/([A-Za-z0-9._$]+)/,
    /mFocusedApp=.*?\s(?:u\d+\s+)?([A-Za-z0-9._]+)\/([A-Za-z0-9._$]+)/,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1] && match[2]) return { package_name: match[1], activity: match[2] };
  }
  return null;
}

export async function handleMobileCurrentApp(ctx: AppContext, chatContextId: string, args: { device?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  if (device.platform !== "android") {
    return jsonError("MOBILE_CURRENT_APP_UNSUPPORTED", "mobile.current_app currently supports Android devices and emulators.", { device });
  }
  try {
    const adb = await resolveAdbPath();
    if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
    const { stdout } = await execFileAsync(adb, ["-s", device.id, "shell", "dumpsys", "window"], { maxBuffer: 8 * 1024 * 1024 });
    const current = parseAndroidCurrentApp(String(stdout));
    return jsonResult({ ok: true, project_id: project.projectId, action: "mobile.current_app", device, current });
  } catch (err) {
    return mobileError("MOBILE_CURRENT_APP_FAILED", err, { device });
  }
}

export async function handleMobileLogs(
  ctx: AppContext,
  chatContextId: string,
  args: { device?: string; package?: string; query?: string; lines?: number } = {}
) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  if (device.platform !== "android") {
    return jsonError("MOBILE_LOGS_UNSUPPORTED", "mobile.logs currently supports Android devices and emulators.", { device });
  }
  const maxLines = Math.min(1000, Math.max(1, Math.round(args.lines ?? 200)));
  try {
    const adb = await resolveAdbPath();
    if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
    const logArgs = ["-s", device.id, "logcat", "-d", "-v", "brief", "-t", String(Math.min(5000, Math.max(maxLines * 5, 500)))];
    let pid: string | undefined;
    if (args.package?.trim()) {
      const packageName = args.package.trim();
      const pidResult = await execFileAsync(adb, ["-s", device.id, "shell", "pidof", packageName], { maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" }));
      pid = String(pidResult.stdout).trim().split(/\s+/)[0] || undefined;
      if (pid) logArgs.push("--pid", pid);
    }
    const { stdout } = await execFileAsync(adb, logArgs, { maxBuffer: 8 * 1024 * 1024 });
    const query = args.query?.toLowerCase();
    const all = String(stdout).split(/\r?\n/).filter(Boolean);
    const filtered = query ? all.filter((line) => line.toLowerCase().includes(query)) : all;
    const selected = filtered.slice(-maxLines);
    return jsonResult({
      ok: true,
      project_id: project.projectId,
      action: "mobile.logs",
      device,
      package: args.package?.trim() || null,
      pid: pid ?? null,
      query: args.query ?? null,
      lines: selected,
      matched_lines: filtered.length,
      truncated: filtered.length > selected.length,
    });
  } catch (err) {
    return mobileError("MOBILE_LOGS_FAILED", err, { device, package: args.package, query: args.query });
  }
}

async function stopAppOnDevice(device: MobileDevice, app: string): Promise<void> {
  if (device.platform === "android") {
    const adb = await resolveAdbPath();
    if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
    await execFileAsync(adb, ["-s", device.id, "shell", "am", "force-stop", app], { maxBuffer: 2 * 1024 * 1024 });
    return;
  }
  if (device.type === "simulator") {
    await execFileAsync("xcrun", ["simctl", "terminate", device.id, app], { maxBuffer: 2 * 1024 * 1024 }).catch(() => undefined);
    return;
  }
  throw new Error("Stopping apps on physical iOS devices is not supported by the current backend.");
}

export async function handleMobileStopApp(ctx: AppContext, chatContextId: string, args: { device?: string; app?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.app?.trim()) return jsonError("MISSING_APP", "mobile.stop_app requires a bundle ID or Android package name.");
  const app = args.app.trim();
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    await stopAppOnDevice(device, app);
    return jsonResult({ ok: true, project_id: project.projectId, action: "mobile.stop_app", device, app });
  } catch (err) {
    return mobileError("MOBILE_STOP_APP_FAILED", err, { device, app });
  }
}

export async function handleMobileRestartApp(ctx: AppContext, chatContextId: string, args: { device?: string; app?: string; observe?: MobileObserve; wait_for?: MobileWaitFor } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.app?.trim()) return jsonError("MISSING_APP", "mobile.restart_app requires a bundle ID or Android package name.");
  const app = args.app.trim();
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  if (isPhysicalIos(device)) return jsonError("MOBILE_RESTART_APP_UNSUPPORTED", "mobile.restart_app does not currently support physical iOS devices.", { device, app });
  try {
    await stopAppOnDevice(device, app);
    if (device.platform === "android") {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await execFileAsync(adb, ["-s", device.id, "shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"], { maxBuffer: 2 * 1024 * 1024 });
    } else {
      await execFileAsync("xcrun", ["simctl", "launch", device.id, app], { maxBuffer: 2 * 1024 * 1024 });
    }
    if (!args.wait_for) await new Promise((resolve) => setTimeout(resolve, 800));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.restart_app", args.observe, { app }, args.wait_for);
  } catch (err) {
    return mobileError("MOBILE_RESTART_APP_FAILED", err, { device, app });
  }
}

export async function handleMobileWait(ctx: AppContext, chatContextId: string, args: { device?: string; target?: string; timeout_ms?: number } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.target?.trim()) return jsonError("MISSING_TARGET", "mobile.wait requires text, a snapshot ref, or selector target.");
  const target = args.target.trim();
  const timeoutMs = Math.min(60_000, Math.max(1, Math.round(args.timeout_ms ?? 10_000)));
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await agentIosWait(device.id, target, timeoutMs);
    } else {
      const adb = await resolveAdbPath();
      if (!adb) throw new Error("ADB is not available. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT.");
      await agentAndroidWait(device.id, adb, target, timeoutMs);
    }
    return jsonResult({ ok: true, project_id: project.projectId, action: "mobile.wait", device, target, timeout_ms: timeoutMs });
  } catch (err) {
    return mobileError("MOBILE_WAIT_FAILED", err, { device, target, timeout_ms: timeoutMs });
  }
}
