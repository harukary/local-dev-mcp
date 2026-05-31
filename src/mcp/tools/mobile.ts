import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { handleImageRead } from "./image-read.js";

const execFileAsync = promisify(execFile);

type MobileDevice = {
  id: string;
  name: string;
  platform: "ios" | "android";
  type: "simulator" | "emulator" | "device";
  state?: string;
};

function jsonResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function jsonError(code: string, message: string, details?: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
    isError: true,
  };
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
  return project;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function artifactPath(project: ProjectConfig, prefix: string): Promise<{ absolutePath: string; relativePath: string }> {
  const dir = join(project.hostRoot, "generated", "local-dev-mcp", "mobile");
  await mkdir(dir, { recursive: true });
  const absolutePath = join(dir, `${prefix}-${Date.now()}.png`);
  return { absolutePath, relativePath: relative(project.hostRoot, absolutePath).replace(/\\/g, "/") };
}

async function listIosDevices(): Promise<MobileDevice[]> {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "available", "--json"], { maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>> };
    const devices: MobileDevice[] = [];
    for (const runtimeDevices of Object.values(parsed.devices ?? {})) {
      for (const device of runtimeDevices) {
        if (device.isAvailable === false) continue;
        devices.push({ id: device.udid, name: device.name, platform: "ios", type: "simulator", state: device.state });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

async function listAndroidDevices(): Promise<MobileDevice[]> {
  try {
    const { stdout } = await execFileAsync("adb", ["devices", "-l"], { maxBuffer: 2 * 1024 * 1024 });
    const devices: MobileDevice[] = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [id, state, ...rest] = trimmed.split(/\s+/);
      if (!id || !state) continue;
      const isEmulator = id.startsWith("emulator-") || rest.some((part) => part.includes("model:sdk"));
      devices.push({ id, name: rest.find((part) => part.startsWith("model:"))?.slice(6) || id, platform: "android", type: isEmulator ? "emulator" : "device", state });
    }
    return devices;
  } catch {
    return [];
  }
}

async function listDevices(): Promise<MobileDevice[]> {
  const [ios, android] = await Promise.all([listIosDevices(), listAndroidDevices()]);
  return [...ios, ...android];
}

async function resolveDevice(deviceIdOrName?: string): Promise<MobileDevice | null> {
  const devices = await listDevices();
  if (!deviceIdOrName) {
    return devices.find((device) => device.state === "Booted" || device.state === "device") ?? devices[0] ?? null;
  }
  const needle = deviceIdOrName.toLowerCase();
  return devices.find((device) => device.id === deviceIdOrName || device.name === deviceIdOrName)
    ?? devices.find((device) => device.id.toLowerCase().includes(needle) || device.name.toLowerCase().includes(needle))
    ?? null;
}

async function screenshotIos(project: ProjectConfig, device: MobileDevice) {
  const output = await artifactPath(project, "ios-shot");
  await execFileAsync("xcrun", ["simctl", "io", device.id, "screenshot", output.absolutePath], { maxBuffer: 10 * 1024 * 1024 });
  return output;
}

async function screenshotAndroid(project: ProjectConfig, device: MobileDevice) {
  const output = await artifactPath(project, "android-shot");
  const { stdout } = await execFileAsync("adb", ["-s", device.id, "exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: 20 * 1024 * 1024,
  } as Parameters<typeof execFile>[2]);
  await writeFile(output.absolutePath, stdout as Buffer);
  return output;
}

export async function handleMobileStatus(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const [xcrunAvailable, adbAvailable, devices] = await Promise.all([
    commandExists("xcrun"),
    commandExists("adb"),
    listDevices(),
  ]);
  return jsonResult({
    project_id: project.projectId,
    backends: {
      ios_simctl: { available: xcrunAvailable },
      android_adb: { available: adbAvailable },
    },
    devices,
    artifact_dir: "generated/local-dev-mcp/mobile",
  });
}

export async function handleMobileListDevices(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  return jsonResult({ project_id: project.projectId, devices: await listDevices() });
}

export async function handleMobileScreenshot(ctx: AppContext, chatContextId: string, args: { device?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    const screenshot = device.platform === "ios"
      ? await screenshotIos(project, device)
      : await screenshotAndroid(project, device);
    const imageResult = await handleImageRead(ctx, chatContextId, { path: screenshot.relativePath });
    const imageText = imageResult.content[0]?.type === "text" ? imageResult.content[0].text : "{}";
    const screenshotMetadata = JSON.parse(String(imageText || "{}"));
    return jsonResult({
      ok: true,
      project_id: project.projectId,
      action: "mobile.screenshot",
      device,
      screenshot: screenshotMetadata,
      image_read: { path: screenshot.relativePath },
    });
  } catch (err) {
    return jsonError("MOBILE_SCREENSHOT_FAILED", err instanceof Error ? err.message : String(err), { device });
  }
}


type MobileObserve = "none" | "after";

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
  const screenshot = device.platform === "ios"
    ? await screenshotIos(project, device)
    : await screenshotAndroid(project, device);
  const imageResult = await handleImageRead(ctx, chatContextId, { path: screenshot.relativePath });
  const imageText = imageResult.content[0]?.type === "text" ? imageResult.content[0].text : "{}";
  const screenshotMetadata = JSON.parse(String(imageText || "{}"));
  return jsonResult({
    ok: true,
    project_id: project.projectId,
    action,
    device,
    ...extra,
    screenshot: screenshotMetadata,
    image_read: { path: screenshot.relativePath },
  });
}

async function observeOrJson(ctx: AppContext, chatContextId: string, project: ProjectConfig, device: MobileDevice, action: string, observe: MobileObserve | undefined, payload: Record<string, unknown>) {
  if (observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action, device, ...payload });
  return await screenshotPayload(ctx, chatContextId, project, device, action, payload);
}

export async function handleMobileBoot(ctx: AppContext, chatContextId: string, args: { device?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No iOS simulator was found to boot.", { device: args.device });
  if (device.platform !== "ios") return jsonError("MOBILE_BOOT_UNSUPPORTED", "mobile.boot currently supports iOS simulators only.", { device });
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

export async function handleMobileOpenUrl(ctx: AppContext, chatContextId: string, args: { device?: string; url?: string; observe?: MobileObserve } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const url = validateUrlForMobile(args.url ?? "");
  if (!url) return jsonError("INVALID_URL", "mobile.open_url requires a non-file URL.", { url: args.url });
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", ["simctl", "openurl", device.id, url], { maxBuffer: 2 * 1024 * 1024 });
    } else {
      await execFileAsync("adb", ["-s", device.id, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { maxBuffer: 2 * 1024 * 1024 });
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.open_url", args.observe, { url });
  } catch (err) {
    return jsonError("MOBILE_OPEN_URL_FAILED", err instanceof Error ? err.message : String(err), { device, url });
  }
}

export async function handleMobileTap(ctx: AppContext, chatContextId: string, args: { device?: string; x?: number; y?: number; observe?: MobileObserve } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (typeof args.x !== "number" || typeof args.y !== "number") return jsonError("INVALID_COORDINATES", "mobile.tap requires numeric x and y coordinates.", { x: args.x, y: args.y });
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", ["simctl", "io", device.id, "tap", String(Math.round(args.x)), String(Math.round(args.y))], { maxBuffer: 2 * 1024 * 1024 });
    } else {
      await execFileAsync("adb", ["-s", device.id, "shell", "input", "tap", String(Math.round(args.x)), String(Math.round(args.y))], { maxBuffer: 2 * 1024 * 1024 });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.tap", args.observe, { x: Math.round(args.x), y: Math.round(args.y) });
  } catch (err) {
    return jsonError("MOBILE_TAP_FAILED", err instanceof Error ? err.message : String(err), { device, x: args.x, y: args.y });
  }
}

function androidInputText(text: string): string {
  return text.replace(/%/g, "%25").replace(/\s/g, "%s").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

export async function handleMobileType(ctx: AppContext, chatContextId: string, args: { device?: string; text?: string; observe?: MobileObserve } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (args.text === undefined) return jsonError("MISSING_TEXT", "mobile.type requires text.");
  const device = await resolveDevice(args.device);
  if (!device) return jsonError("MOBILE_DEVICE_NOT_FOUND", "No mobile device or simulator was found.", { device: args.device });
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", ["simctl", "io", device.id, "keyboard", "type", args.text], { maxBuffer: 2 * 1024 * 1024 });
    } else {
      await execFileAsync("adb", ["-s", device.id, "shell", "input", "text", androidInputText(args.text)], { maxBuffer: 2 * 1024 * 1024 });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return await observeOrJson(ctx, chatContextId, project, device, "mobile.type", args.observe, { text: args.text });
  } catch (err) {
    return jsonError("MOBILE_TYPE_FAILED", err instanceof Error ? err.message : String(err), { device });
  }
}
