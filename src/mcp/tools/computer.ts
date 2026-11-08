import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { getActiveProject, jsonError, jsonResult } from "./dev/common.js";
import { handleImageRead } from "./image-read.js";

const execFileAsync = promisify(execFile);
const readonly = new Set(["computer.status", "computer.list_apps", "computer.list_windows", "computer.get_window_state", "computer.screenshot"]);
const snapshots = new Map<string, { owner: string; capturedAt: number }>();
let queue: Promise<unknown> = Promise.resolve();

type ToolArgs = Record<string, unknown>;
type JsonMap = Record<string, unknown>;

export async function runComputerToolOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(operation);
  queue = next;
  return await next;
}

async function resolveDriver(): Promise<string | null> {
  const selected = process.env.LOCAL_DEV_MCP_COMPUTER_DRIVER;
  const candidates = selected ? [selected] : [
    join(homedir(), ".local", "bin", "cua-driver"),
    "/opt/homebrew/bin/cua-driver",
    "/usr/local/bin/cua-driver",
    "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Search the next installed driver. */ }
  }
  return null;
}

async function execDriver(driver: string, args: string[], timeout = 20000): Promise<string> {
  const { stdout } = await execFileAsync(driver, args, {
    timeout,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    env: { ...process.env },
  });
  return stdout.trim();
}

async function driverCall(driver: string, name: string, payload: JsonMap = {}, screenshotPath?: string): Promise<unknown> {
  const params = ["call", name, JSON.stringify(payload)];
  if (screenshotPath) params.push("--screenshot-out-file", screenshotPath);
  const stdout = await execDriver(driver, params);
  if (!stdout) return {};
  return JSON.parse(stdout) as unknown;
}

function integer(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100000;
}
function keyFor(pid: number, windowId: number): string {
  return String(pid) + ":" + String(windowId);
}
function record(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}
function bounded(text: unknown, max = 16000): string {
  return typeof text === "string" ? text.slice(0, max) : "";
}
function safeWindow(value: unknown) {
  const source = record(value);
  return Object.fromEntries(["pid", "window_id", "app_name", "title", "bounds", "on_current_space", "is_on_screen", "focused"]
    .filter((key) => source[key] !== undefined)
    .map((key) => [key, typeof source[key] === "string" ? bounded(source[key], 180) : source[key]]));
}
function safeApp(value: unknown) {
  const source = record(value);
  return Object.fromEntries(["name", "app_name", "bundle_id", "bundleId", "pid", "running", "is_running"]
    .filter((key) => source[key] !== undefined)
    .map((key) => [key, typeof source[key] === "string" ? bounded(source[key], 180) : source[key]]));
}

async function verifiedWindow(driver: string, pid: number, windowId: number): Promise<JsonMap | null> {
  const data = record(await driverCall(driver, "list_windows", { pid }));
  const windows = Array.isArray(data.windows) ? data.windows : [];
  return windows.map(record).find((window) => window.pid === pid && window.window_id === windowId) ?? null;
}

async function computerScreenshot(
  ctx: AppContext,
  chatContextId: string,
  project: ProjectConfig,
  driver: string,
  name: string,
  pid: number,
  windowId: number,
  query?: string,
) {
  const dir = join(project.hostRoot, "generated", "local-dev-mcp", "computer");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "window-" + randomUUID() + ".png");
  let imageSaved = false;
  try {
    const args: JsonMap = { pid, window_id: windowId };
    if (name === "computer.screenshot") args.capture_mode = "vision";
    if (query) args.query = query;
    const result = record(await driverCall(driver, "get_window_state", args, path));
    const file = await stat(path);
    if (!file.isFile() || file.size === 0) throw new Error("No screenshot was produced.");
    imageSaved = true;
    await chmod(path, 0o600);
    const relativePath = relative(project.hostRoot, path).replace(/\\/g, "/");
    const inline = await handleImageRead(ctx, chatContextId, { path: relativePath });
    const imageContents = inline.content.filter((item) => item.type === "image");
    const imageMetadata = record(inline.structuredContent);
    if (inline.isError || imageContents.length === 0) throw new Error("Screenshot preview could not be read.");
    if (name === "computer.get_window_state") {
      snapshots.set(keyFor(pid, windowId), { owner: chatContextId, capturedAt: Date.now() });
    } else {
      snapshots.delete(keyFor(pid, windowId));
    }
    const response = jsonResult({
      ok: true,
      project_id: project.projectId,
      action: name,
      pid,
      window_id: windowId,
      ...(name === "computer.get_window_state" ? { tree_markdown: bounded(result.tree_markdown), query: query || null } : {}),
      screenshot: { ...imageMetadata, path: relativePath, size_bytes: file.size },
    });
    return { ...response, content: [...response.content, ...imageContents] };
  } catch {
    if (!imageSaved) await rm(path, { force: true }).catch(() => undefined);
    return jsonError("COMPUTER_CAPTURE_FAILED", "Cua Driver could not capture the selected window. Check its permissions and running state.");
  }
}

function validatedAction(name: string, args: ToolArgs, chatContextId: string): JsonMap | { error: string } {
  const pid = args.pid;
  const windowId = args.window_id;
  if (!integer(pid) || !integer(windowId)) return { error: "pid and window_id must be positive integers from computer.list_windows." };
  const payload: JsonMap = { pid, window_id: windowId };
  const index = args.element_index;
  if (index !== undefined) {
    if (!integer(index, 0)) return { error: "element_index must be a nonnegative integer." };
    const snapshot = snapshots.get(keyFor(pid, windowId));
    if (!snapshot || snapshot.owner !== chatContextId || Date.now() - snapshot.capturedAt > 300000) {
      return { error: "Accessibility element indices require a fresh computer.get_window_state call in this work context." };
    }
    payload.element_index = index;
  }
  if (name === "computer.click") {
    const byPoint = args.x !== undefined || args.y !== undefined;
    if (byPoint === (index !== undefined)) return { error: "Supply exactly one of element_index or x/y." };
    if (byPoint) {
      if (!number(args.x) || !number(args.y)) return { error: "Both x and y must be nonnegative screenshot coordinates." };
      payload.x = args.x;
      payload.y = args.y;
    }
    if (args.count !== undefined) {
      if (!integer(args.count) || args.count > 3 || index !== undefined) return { error: "count must be 1..3 for coordinate clicks." };
      payload.count = args.count;
    }
    if (args.modifier !== undefined) payload.modifier = args.modifier;
  } else if (name === "computer.drag") {
    for (const key of ["from_x", "from_y", "to_x", "to_y"]) {
      if (!number(args[key])) return { error: key + " must be a nonnegative screenshot coordinate." };
      payload[key] = args[key];
    }
    if (args.duration_ms !== undefined) payload.duration_ms = args.duration_ms;
  } else if (name === "computer.scroll") {
    payload.direction = args.direction;
    if (args.amount !== undefined) payload.amount = args.amount;
    if (args.by !== undefined) payload.by = args.by;
  } else if (name === "computer.type") {
    if (typeof args.text !== "string" || args.text.length > 10000) return { error: "text must be a string with at most 10000 characters." };
    payload.text = args.text;
  } else if (name === "computer.press_key") {
    payload.key = args.key;
  } else if (name === "computer.hotkey") {
    payload.keys = args.keys;
  }
  return payload;
}

export async function handleComputerTool(ctx: AppContext, chatContextId: string, name: string, args: ToolArgs = {}) {
  if (!(chatContextId.startsWith("chatgpt-session:") || chatContextId.startsWith("claude-context:") || chatContextId.startsWith("muse-work:"))) {
    return jsonError("COMPUTER_CONTEXT_REQUIRED", "Computer Use requires a verified interactive chat or work context.");
  }
  const project = getActiveProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const driver = await resolveDriver();
  if (name === "computer.status") {
    if (!driver) return jsonResult({ project_id: project.projectId, installed: false, running: false, install_hint: "Install the Cua Driver CLI on the macOS host." });
    const [version, daemon, permissions] = await Promise.all([
      execDriver(driver, ["--version"], 5000).catch(() => null),
      execDriver(driver, ["status"], 5000).then(() => true).catch(() => false),
      execDriver(driver, ["permissions", "status", "--json"], 5000).then((result) => JSON.parse(result) as unknown).catch(() => null),
    ]);
    return jsonResult({ project_id: project.projectId, installed: true, running: daemon, version, permissions, driver: "cua-driver", ...(daemon ? {} : { hint: "Start Cua Driver on the Mac and grant its Accessibility and Screen Recording permissions." }) });
  }
  if (!driver) return jsonError("COMPUTER_DRIVER_MISSING", "Cua Driver is not installed on this Mac.");
  if (!readonly.has(name) && project.writePolicy !== "allow") {
    return jsonError("COMPUTER_WRITE_NOT_ALLOWED", "Desktop mutations require the selected project's write_policy=allow.");
  }
  try {
    if (name === "computer.list_apps") {
      const result = await driverCall(driver, "list_apps");
      const items = Array.isArray(result) ? result : Array.isArray(record(result).apps) ? record(result).apps as unknown[] : [];
      return jsonResult({ project_id: project.projectId, apps: items.slice(0, 100).map(safeApp), total: items.length, truncated: items.length > 100 });
    }
    if (name === "computer.list_windows") {
      if (args.pid !== undefined && !integer(args.pid)) return jsonError("COMPUTER_INVALID_TARGET", "pid must be a positive integer.");
      const data = record(await driverCall(driver, "list_windows", args.pid ? { pid: args.pid } : {}));
      const windows = (Array.isArray(data.windows) ? data.windows : []).map(record).filter((w) =>
        (args.app_name_contains === undefined || String(w.app_name ?? "").toLowerCase().includes(String(args.app_name_contains).toLowerCase())) &&
        (args.title_contains === undefined || String(w.title ?? "").toLowerCase().includes(String(args.title_contains).toLowerCase())) &&
        (args.on_current_space === undefined || Boolean(w.on_current_space) === args.on_current_space));
      return jsonResult({ project_id: project.projectId, windows: windows.slice(0, 100).map(safeWindow), total: windows.length, truncated: windows.length > 100 });
    }
    if (name === "computer.launch_app") {
      if (typeof args.bundle_id !== "string" || !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(args.bundle_id)) {
        return jsonError("COMPUTER_INVALID_APP", "bundle_id must be a valid macOS bundle identifier.");
      }
      await driverCall(driver, "launch_app", { bundle_id: args.bundle_id });
      return jsonResult({ ok: true, action: name, bundle_id: args.bundle_id, action_applied: true, verified: false });
    }
    if (!integer(args.pid) || !integer(args.window_id)) {
      return jsonError("COMPUTER_INVALID_TARGET", "pid and window_id from computer.list_windows are required.");
    }
    const pid = args.pid;
    const windowId = args.window_id;
    const window = await verifiedWindow(driver, pid, windowId);
    if (!window) return jsonError("COMPUTER_TARGET_NOT_FOUND", "The specified pid and window_id no longer identify a window. Refresh computer.list_windows.");
    if (name === "computer.screenshot" || name === "computer.get_window_state") {
      return await computerScreenshot(ctx, chatContextId, project, driver, name, pid, windowId, typeof args.query === "string" ? args.query : undefined);
    }
    if (name === "computer.activate_window") {
      await driverCall(driver, "bring_to_front", { pid, window_id: windowId });
      return jsonResult({ ok: true, action: name, pid, window_id: windowId, action_applied: true, verified: false });
    }
    const validated = validatedAction(name, args, chatContextId);
    if (typeof validated.error === "string") return jsonError("COMPUTER_INVALID_ACTION", validated.error);
    const dispatch: Record<string, string> = {
      "computer.click": "click",
      "computer.drag": "drag",
      "computer.scroll": "scroll",
      "computer.type": "type_text",
      "computer.press_key": "press_key",
      "computer.hotkey": "hotkey",
    };
    const driverName = dispatch[name];
    if (!driverName) return jsonError("UNKNOWN_TOOL", "Unknown computer action.");
    await driverCall(driver, driverName, validated);
    snapshots.delete(keyFor(pid, windowId));
    return jsonResult({ ok: true, action: name, pid, window_id: windowId, action_applied: true, verified: false, verification_deferred: true });
  } catch {
    // Driver errors may include the command payload, including text being typed.
    return { ...jsonResult({
      error: { code: "COMPUTER_DRIVER_FAILED", message: "Cua Driver could not complete the operation. Inspect status/window state before retrying." },
      action_applied: readonly.has(name) ? false : null,
      verified: false,
      retry_action: false,
    }), isError: true };
  }
}
