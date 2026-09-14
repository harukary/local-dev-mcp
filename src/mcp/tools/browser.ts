import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createServer } from "node:net";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { applyWorkingDirectory } from "../../project/working-directory.js";
import { BrowserProfileError, BrowserProfileManager, browserProfileKey, type AuthClaimInput, type BrowserLease } from "../../browser/profile-manager.js";
import { loadLiveAuthProbeConfiguration, runLiveAuthProbes, type LiveAuthProbe } from "../../browser/auth-probes.js";
import { BrowserLifecycleService, browserIdleTimeoutMsFromEnv, type BrowserStopReason } from "../../browser/browser-lifecycle.js";
import { ActiveTabStore } from "../../browser/active-tab-store.js";
import { BrowserOperationCoordinator } from "../../browser/browser-operation-coordinator.js";
import { CdpClient, withCdpClient, closeCdpClients } from "../../browser/cdp-client.js";
import { withBrowserPage, clickElement, fillElement, locatorFor, closeBrowserConnections } from "../../browser/interaction.js";
import { observeAfterAction } from "../observation.js";
import { utf8Prefix } from "../output.js";
import { operationSignal } from "../request-context.js";
import { resolveProjectPath } from "./dev/common.js";

const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MACOS_CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const PORT_MIN = Number(process.env.LOCAL_DEV_MCP_BROWSER_PORT_BASE ?? 18300);
const PORT_MAX = Number(process.env.LOCAL_DEV_MCP_BROWSER_PORT_MAX ?? 18799);
const BROWSER_HOME = process.env.LOCAL_DEV_MCP_BROWSER_HOME ?? join(homedir(), ".local-dev-mcp", "runtime", "browser");
const SESSION_FILE = join(BROWSER_HOME, "sessions.json");
const DEFAULT_SESSION_ID = "default";
const DEFAULT_PROFILE_DIR = join(BROWSER_HOME, "profiles", DEFAULT_SESSION_ID);
const AUTH_PROBE_CONFIG = process.env.LOCAL_DEV_MCP_BROWSER_AUTH_PROBES ?? join(process.cwd(), "config", "browser-auth-probes.yaml");
const ACTIVE_TABS_DIR = join(BROWSER_HOME, "active-tabs");
const BROWSER_INSTANCE_ID = randomUUID();
const browserOperations = new BrowserOperationCoordinator(join(BROWSER_HOME, "operation-locks"));
const activeTabs = new ActiveTabStore(ACTIVE_TABS_DIR, browserOperations);

export async function runBrowserToolOperation<T>(chatContextId: string, operation: () => Promise<T>): Promise<T> {
  return await browserOperations.run(browserProfileKey(chatContextId), operation);
}

export async function beginBrowserOperationDrain(): Promise<void> {
  await browserOperations.beginDrain();
  closeCdpClients();
  await closeBrowserConnections();
}

type BrowserObserve = "none" | "after" | "snapshot";
type BrowserWaitFor = { selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number };

type BrowserSession = {
  session_id: string;
  project_id: string;
  chat_context_id?: string;
  port: number;
  profile_dir: string;
  pid?: number;
  created_at: string;
  updated_at: string;
  url?: string;
  active_target_id?: string;
};

type ChromeTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type ImageContent = { type: "image"; data: string; mimeType: string };
type JsonResult = {
  structuredContent: unknown;
  content: [{ type: "text"; text: string }, ...ImageContent[]];
};

class BrowserTabError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

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

function tabError(error: unknown, fallbackCode: string, details?: unknown) {
  return error instanceof BrowserTabError
    ? jsonError(error.code, error.message, details)
    : jsonError(fallbackCode, error instanceof Error ? error.message : String(error), details);
}

async function readActiveTargetId(profileKey: string): Promise<string | undefined> {
  return await activeTabs.read(profileKey);
}

async function writeActiveTargetId(profileKey: string, targetId: string): Promise<void> {
  await activeTabs.write(profileKey, targetId);
}

async function clearActiveTargetId(profileKey: string, expectedTargetId?: string): Promise<boolean> {
  return await activeTabs.clear(profileKey, expectedTargetId);
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
  if (!projectId) {
    return { error: jsonError("PROJECT_NOT_SELECTED", "No project is selected for this chat. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  const project = ctx.registry.get(projectId);
  if (!project) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return { error: jsonError("PROJECT_NOT_SELECTED", "The selected project is no longer available. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  return applyWorkingDirectory(project, ctx.contextStore.getWorkingDirectory?.(chatContextId));
}

function validateHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveChromeExecutable(): { available: boolean; executable_path?: string; candidates: string[] } {
  const candidates = [
    process.env.LOCAL_DEV_MCP_BROWSER_EXECUTABLE,
    MACOS_CHROME,
    MACOS_CHROMIUM,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => existsSync(candidate));
  return { available: Boolean(executable), executable_path: executable, candidates };
}

async function inspectLegacyDefaultProfile(): Promise<"absent" | "quiescent"> {
  if (!existsSync(DEFAULT_PROFILE_DIR)) return "absent";
  let sessions: BrowserSession[];
  try {
    const parsed = JSON.parse(await readFile(SESSION_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("sessions ledger is not an array");
    sessions = parsed as BrowserSession[];
  } catch (error) {
    throw new BrowserProfileError(
      "BROWSER_PROFILE_MIGRATION_STATE_UNKNOWN",
      `Cannot verify the legacy browser session ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const legacyDefault = sessions.find((session) => session.session_id === DEFAULT_SESSION_ID);
  if (legacyDefault?.pid && isPidAlive(legacyDefault.pid)) {
    throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_REQUIRES_STOP", "Stop the legacy default browser before migration.");
  }
  if (legacyDefault?.port) {
    try {
      await waitForCdp(legacyDefault.port, 300);
      throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_REQUIRES_STOP", "The legacy default browser DevTools endpoint is still active.");
    } catch (error) {
      if (error instanceof BrowserProfileError) throw error;
    }
  }
  const activePortPath = join(DEFAULT_PROFILE_DIR, "DevToolsActivePort");
  if (existsSync(activePortPath)) {
    const port = Number((await readFile(activePortPath, "utf8")).split(/\r?\n/, 1)[0]);
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_STATE_UNKNOWN", "Legacy DevToolsActivePort is invalid.");
    }
    try {
      await waitForCdp(port, 300);
      throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_REQUIRES_STOP", "The legacy default browser DevTools endpoint is still active.");
    } catch (error) {
      if (error instanceof BrowserProfileError) throw error;
    }
  }
  const singletonLock = join(DEFAULT_PROFILE_DIR, "SingletonLock");
  if (existsSync(singletonLock)) {
    let ownerPid: number;
    try {
      const target = await readlink(singletonLock);
      const match = target.match(/-(\d+)$/);
      if (!match) throw new Error("lock owner pid is missing");
      ownerPid = Number(match[1]);
    } catch (error) {
      throw new BrowserProfileError(
        "BROWSER_PROFILE_MIGRATION_STATE_UNKNOWN",
        `Cannot verify the legacy Chrome lock: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (isPidAlive(ownerPid)) {
      throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_REQUIRES_STOP", "The legacy default Chrome process is still active.");
    }
  }
  return "quiescent";
}

let profileManagerPromise: Promise<BrowserProfileManager> | undefined;

async function profileManager(): Promise<BrowserProfileManager> {
  if (!profileManagerPromise) {
    const creating = (async () => {
      const manager = new BrowserProfileManager({ home: BROWSER_HOME });
      if (existsSync(join(BROWSER_HOME, "state.json"))) {
        await manager.initialize();
        return manager;
      }
      const seedState = await inspectLegacyDefaultProfile();
      const seedProfileRoot = seedState === "quiescent" ? DEFAULT_PROFILE_DIR : undefined;
      await manager.initialize(seedProfileRoot, {
        seedState,
        revalidateSeed: seedProfileRoot
          ? async () => await inspectLegacyDefaultProfile() === "quiescent"
          : undefined,
      });
      return manager;
    })();
    profileManagerPromise = creating.catch((error) => {
      profileManagerPromise = undefined;
      throw error;
    });
  }
  return await profileManagerPromise;
}

function profileError(error: unknown) {
  if (error instanceof BrowserProfileError) return jsonError(error.code, error.message);
  return jsonError("BROWSER_PROFILE_FAILED", error instanceof Error ? error.message : String(error));
}

function explicitSessionError(sessionId: unknown) {
  return sessionId === undefined
    ? undefined
    : jsonError("BROWSER_EXPLICIT_SESSION_UNSUPPORTED", "Browser profiles are owned by the current chat; explicit session_id is not supported.");
}

export function browserSessionIdForContext(_chatContextId: string, _projectId: string): string {
  return browserProfileKey(_chatContextId);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: operationSignal(5000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return await response.json() as T;
}

async function waitForCdp(port: number, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetchJson<{ Browser?: string; webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
    } catch (err) {
      lastError = err;
      await sleep(200);
    }
  }
  throw new Error(`Chrome DevTools did not become ready on port ${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function listTargets(port: number): Promise<ChromeTarget[]> {
  return await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`);
}

async function newTarget(port: number, url = "about:blank"): Promise<ChromeTarget> {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: "PUT", signal: operationSignal(5000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${endpoint}`);
  return await response.json() as ChromeTarget;
}

async function closeTarget(port: number, targetId: string): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`;
  const response = await fetch(endpoint, { signal: operationSignal(5000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: close target`);
}

async function waitForOnlyPageTarget(port: number, targetId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pageTargetIds = (await listTargets(port)).filter((target) => target.type === "page").map((target) => target.id);
    if (pageTargetIds.length === 1 && pageTargetIds[0] === targetId) return;
    await sleep(50);
  }
  throw new Error("Chrome retained redundant initial page targets.");
}

async function findPageTarget(port: number, targetId: string): Promise<ChromeTarget | undefined> {
  return (await listTargets(port)).find((target) => target.id === targetId && target.type === "page" && target.webSocketDebuggerUrl);
}

async function getSession(ctx: AppContext, chatContextId: string, sessionId?: string): Promise<BrowserSession | { error: ReturnType<typeof jsonError> }> {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project;
  const explicitError = explicitSessionError(sessionId);
  if (explicitError) return { error: explicitError };
  let profile;
  try {
    profile = await (await profileManager()).getOwnedProfile(chatContextId);
  } catch (error) {
    return { error: profileError(error) };
  }
  if (profile.state !== "running" || !profile.port) return { error: jsonError("BROWSER_SESSION_NOT_FOUND", "No browser session found. Call browser.start first.") };
  try {
    await waitForCdp(profile.port, 1200);
    await (await profileManager()).touch(profile.profileKey);
    return {
      session_id: profile.profileKey,
      project_id: project.projectId,
      chat_context_id: chatContextId,
      port: profile.port,
      profile_dir: profile.userDataDir,
      pid: profile.pid,
      created_at: profile.lastUsedAt,
      updated_at: new Date().toISOString(),
      active_target_id: await readActiveTargetId(profile.profileKey),
    };
  } catch (err) {
    return { error: jsonError("BROWSER_SESSION_NOT_READY", err instanceof Error ? err.message : String(err), { port: profile.port }) };
  }
}

async function artifactPath(project: ProjectConfig, prefix: string): Promise<{ absolutePath: string; relativePath: string }> {
  const dir = join(project.hostRoot, "generated", "local-dev-mcp", "browser");
  await mkdir(dir, { recursive: true });
  const absolutePath = join(dir, `${prefix}-${Date.now()}.png`);
  return { absolutePath, relativePath: relative(project.hostRoot, absolutePath).replace(/\\/g, "/") };
}


async function validateActiveTarget(session: BrowserSession): Promise<ChromeTarget> {
  return await activeTabs.transaction(session.session_id, async ({ read, clear }) => {
    const targetId = await read();
    if (!targetId) throw new BrowserTabError("BROWSER_ACTIVE_TAB_NOT_SELECTED", "No active browser tab is selected. Call browser.tabs and browser.tab.use, or browser.tab.open.");
    const target = await findPageTarget(session.port, targetId);
    if (!target) {
      await clear();
      throw new BrowserTabError("BROWSER_ACTIVE_TAB_NOT_FOUND", "The selected browser tab no longer exists. Call browser.tabs and select another tab.");
    }
    session.active_target_id = targetId;
    return target;
  });
}

async function withPage<T>(session: BrowserSession, fn: (client: CdpClient, target: ChromeTarget) => Promise<T>): Promise<T> {
  const target = await validateActiveTarget(session);
  if (!target.webSocketDebuggerUrl) throw new BrowserTabError("BROWSER_TAB_NOT_FOUND", "The selected browser tab has no CDP endpoint.");
  return await withCdpClient(target.webSocketDebuggerUrl, client => fn(client, target));
}


async function evaluate<T = unknown>(session: BrowserSession, expression: string): Promise<T> {
  return await withPage<T>(session, async (client) => {
    await client.send("Runtime.enable");
    const result = await client.send<{
      result?: { value?: T; unserializableValue?: string; description?: string };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value as T;
  });
}

async function observeAuthProbe(port: number, probe: LiveAuthProbe): Promise<{ status: "authenticated" | "signed_out" | "unknown"; principal?: string }> {
  const target = await newTarget(port, "about:blank");
  if (!target.webSocketDebuggerUrl) throw new Error("Auth probe target did not expose a CDP websocket");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Page.navigate", { url: probe.url });
    const deadline = Date.now() + probe.timeoutMs;
    while (Date.now() < deadline) {
      const observation = await client.send<{
        result?: { value?: { url?: string; authenticated?: boolean; signedOut?: boolean; principalText?: string } };
      }>("Runtime.evaluate", {
        expression: `(() => {
          const authenticated = document.querySelector(${jsString(probe.authenticatedSelector)});
          const signedOut = ${probe.signedOutSelector ? `document.querySelector(${jsString(probe.signedOutSelector)})` : "null"};
          const principal = document.querySelector(${jsString(probe.principalSelector)});
          const principalText = principal
            ? [principal.getAttribute("aria-label"), principal.getAttribute("title"), principal.textContent].filter(Boolean).join(" ")
            : "";
          return { url: location.href, authenticated: !!authenticated, signedOut: !!signedOut, principalText };
        })()`,
        returnByValue: true,
      });
      const value = observation.result?.value;
      const principal = value?.principalText?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
      const authenticatedHost = value?.url
        ? (() => { try { return new URL(value.url).hostname.toLowerCase(); } catch { return ""; } })()
        : "";
      if (value?.authenticated && principal && authenticatedHost === probe.authenticatedHost) {
        return { status: "authenticated", principal };
      }
      if (value?.signedOut || (value?.url && probe.signedOutUrlPattern && new RegExp(probe.signedOutUrlPattern).test(value.url))) {
        return { status: "signed_out" };
      }
      await sleep(250);
    }
    return { status: "unknown" };
  } finally {
    client.close();
    await fetchJson(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
  }
}

async function waitForProcessExit(pid: number | undefined, timeoutMs: number, force = true): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(100);
  if (force && isPidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    await sleep(100);
  }
}

async function closeBrowserProcess(port: number, pid: number): Promise<void> {
  let browserCloseSent = false;
  try {
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${port}/json/version`);
    if (version.webSocketDebuggerUrl) {
      const client = new CdpClient(version.webSocketDebuggerUrl);
      await client.connect();
      try {
        await client.send("Browser.close");
        browserCloseSent = true;
      } finally { client.close(); }
    }
  } catch {
    if (isPidAlive(pid)) {
      throw new BrowserProfileError(
        "BROWSER_STOP_OWNERSHIP_UNVERIFIED",
        "Chrome DevTools is unreachable, so the recorded PID will not be terminated without an ownership proof.",
      );
    }
    return;
  }
  if (!browserCloseSent) throw new BrowserProfileError("BROWSER_STOP_FAILED", "Chrome did not expose a browser CDP endpoint.");
  await waitForProcessExit(pid, 5000, false);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      await sleep(100);
    } catch {
      return;
    }
  }
  throw new BrowserProfileError("BROWSER_STOP_FAILED", "Chrome DevTools remained reachable after browser shutdown.");
}

async function validatePromotionSnapshot(
  executablePath: string,
  userDataDir: string,
  probes: LiveAuthProbe[],
  expectedClaims: AuthClaimInput[],
): Promise<boolean> {
  const expected = new Map(expectedClaims
    .filter((claim) => claim.status === "authenticated" && claim.principal)
    .map((claim) => [`${claim.probeId}:${claim.probeVersion}`, claim.principal!.trim().toLowerCase()]));
  if (expected.size === 0) return false;
  let port: number | undefined;
  for (let candidate = PORT_MIN; candidate <= PORT_MAX; candidate += 1) {
    if (await canListen(candidate)) { port = candidate; break; }
  }
  if (!port) return false;
  const child = spawn(executablePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ], { stdio: "ignore" });
  try {
    await waitForCdp(port, 10_000);
    const observed = await runLiveAuthProbes(probes, (probe) => observeAuthProbe(port!, probe));
    const actual = new Map(observed
      .filter((claim) => claim.status === "authenticated" && claim.principal)
      .map((claim) => [`${claim.probeId}:${claim.probeVersion}`, claim.principal!.trim().toLowerCase()]));
    return expected.size === actual.size && [...expected].every(([key, principal]) => actual.get(key) === principal);
  } finally {
    if (child.pid) {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* ignore */ }
      await waitForProcessExit(child.pid, 3000);
    }
  }
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

async function activeSessionAndProject(ctx: AppContext, chatContextId: string, sessionId?: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project;
  const session = await ensureSession(ctx, chatContextId, undefined, sessionId);
  if ("error" in session) return session;
  try { await validateActiveTarget(session); } catch (error) { return { error: tabError(error, "BROWSER_ACTIVE_TAB_FAILED") }; }
  return { project, session };
}

type ScreenshotClip = { x: number; y: number; width: number; height: number; scale: number };
async function captureCdpScreenshot(ctx: AppContext, chatContextId: string, project: ProjectConfig, session: BrowserSession, action: string, extra: Record<string, unknown> = {}, clip?: ScreenshotClip) {
  const result = await withPage<{ data: string }>(session, async (client) => {
    await client.send("Page.enable");
    return await client.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, ...(clip ? { clip } : {}) });
  });
  const output = await artifactPath(project, "browser-cdp-shot");
  await writeFile(output.absolutePath, Buffer.from(result.data, "base64"));
  const imageRead = await import("./image-read.js");
  const imageResult = await imageRead.handleImageRead(ctx, chatContextId, { path: output.relativePath });
  if (imageResult.isError) throw new Error(`Screenshot was saved but image inspection failed: ${imageResult.content[0]?.type === "text" ? imageResult.content[0].text : "no diagnostic"}`);
  const imageText = imageResult.content[0]?.type === "text" ? imageResult.content[0].text : "{}";
  const screenshotMetadata = JSON.parse(String(imageText || "{}"));
  const imageContent = extractImageContent(imageResult);
  return jsonResult({
    ok: true,
    project_id: project.projectId,
    action,
    port: session.port,
    ...extra,
    screenshot: screenshotMetadata,
    image_read: { path: output.relativePath },
  }, imageContent);
}

async function ensureSession(ctx: AppContext, chatContextId: string, url?: string, sessionId?: string): Promise<BrowserSession | { error: ReturnType<typeof jsonError> }> {
  const existing = await getSession(ctx, chatContextId, sessionId);
  if (!("error" in existing)) return existing;
  if (sessionId !== undefined) return existing;
  const started = await handleBrowserStart(ctx, chatContextId, { url });
  const body = JSON.parse(started.content[0]?.text ?? "{}");
  if (!body.ok) return { error: jsonError("BROWSER_START_FAILED", "Could not start browser session.", body) };
  const session = await getSession(ctx, chatContextId);
  return session;
}

export async function handleBrowserStatus(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const chrome = resolveChromeExecutable();
  try {
    const manager = new BrowserProfileManager({ home: BROWSER_HOME });
    const profile = await manager.getOptionalOwnedProfile(chatContextId);
    const status = profile ? await manager.statusForChat(chatContextId) : undefined;
    return jsonResult({
      project_id: project.projectId,
      backend: "chrome-devtools-protocol",
      chrome_available: chrome.available,
      port_range: { min: PORT_MIN, max: PORT_MAX },
      profile: {
        state: status?.state ?? "not_created",
        last_used_at: status?.lastUsedAt,
        gc_after: status?.gcAfter,
        authenticated_probe_ids: status?.authenticatedProbeIds ?? [],
        snapshot_size_bytes: status?.snapshotBytes,
        snapshot_copy_mode: status?.copyMode,
        snapshot_verification: status?.snapshotVerification,
        running: profile?.state === "running",
      },
      auth_probe_config: await loadLiveAuthProbeConfiguration(AUTH_PROBE_CONFIG).then((config) => ({ status: config.status, count: config.probes.length })),
      artifact_dir: "generated/local-dev-mcp/browser",
    });
  } catch (error) {
    return profileError(error);
  }
}

export async function handleBrowserStart(ctx: AppContext, chatContextId: string, args: { url?: string; session_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const explicitError = explicitSessionError(args.session_id);
  if (explicitError) return explicitError;
  const chrome = resolveChromeExecutable();
  if (!chrome.available || !chrome.executable_path) return jsonError("BROWSER_NOT_FOUND", "Chrome/Chromium executable not found.", { candidates: chrome.candidates });
  const url = args.url ? validateHttpUrl(args.url) ?? undefined : undefined;
  if (args.url && !url) return jsonError("INVALID_URL", "browser.start url must be http or https.");
  let manager: BrowserProfileManager;
  let profile;
  try {
    manager = await profileManager();
    profile = await manager.ensureChatProfile(chatContextId);
  } catch (error) {
    return profileError(error);
  }
  if (profile.state === "running" && profile.port) {
    try {
      const version = await waitForCdp(profile.port, 1200);
      await manager.touch(profile.profileKey);
      return jsonResult({
        ok: true,
        project_id: project.projectId,
        action: "browser.start",
        status: "already_running",
        port: profile.port,
        browser: version.Browser,
      });
    } catch {
      if (isPidAlive(profile.pid)) return jsonError("BROWSER_SESSION_UNREACHABLE", "The browser process is alive but its DevTools endpoint is unreachable.", { port: profile.port });
      await manager.markIdle(profile.profileKey);
      profile = await manager.getOwnedProfile(chatContextId);
    }
  }
  if (profile.state === "checkpointing") {
    return jsonError("BROWSER_PROFILE_BUSY", "The browser profile is being checkpointed. Retry after browser.stop completes.");
  }
  let port: number;
  try {
    port = await manager.reservePort(profile.profileKey, { min: PORT_MIN, max: PORT_MAX }, BROWSER_INSTANCE_ID, canListen);
  } catch (error) {
    return profileError(error);
  }
  const child = spawn(chrome.executable_path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  let version;
  try {
    version = await waitForCdp(port, 10_000);
    const activeTarget = await newTarget(port, url ?? "about:blank");
    if (activeTarget.type !== "page") throw new Error("Chrome did not create a page target.");
    const redundantTargets = (await listTargets(port)).filter((target) => target.type === "page" && target.id !== activeTarget.id);
    await Promise.all(redundantTargets.map((target) => closeTarget(port, target.id)));
    await waitForOnlyPageTarget(port, activeTarget.id);
    await writeActiveTargetId(profile.profileKey, activeTarget.id);
    await manager.markRunning(profile.profileKey, { instanceId: BROWSER_INSTANCE_ID, pid: child.pid ?? 0, port });
  } catch (error) {
    if (child.pid) try { process.kill(child.pid); } catch { /* ignore */ }
    await clearActiveTargetId(profile.profileKey);
    await manager.markIdle(profile.profileKey);
    return jsonError("BROWSER_START_FAILED", error instanceof Error ? error.message : String(error), { port });
  }
  return jsonResult({
    ok: true,
    project_id: project.projectId,
    action: "browser.start",
    status: "started",
    port,
    url,
    browser: version.Browser,
    snapshot_size_bytes: profile.snapshotBytes,
    snapshot_copy_mode: profile.copyMode,
    snapshot_verification: profile.snapshotVerification,
  });
}

export async function handleBrowserSessions(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  try {
    const manager = new BrowserProfileManager({ home: BROWSER_HOME });
    const profile = await manager.getOptionalOwnedProfile(chatContextId);
    if (!profile) return jsonResult({ project_id: project.projectId, sessions: [{ state: "not_created", ready: false }] });
    const status = await manager.statusForChat(chatContextId);
    let ready = false;
    if (profile.port) try { await waitForCdp(profile.port, 800); ready = true; } catch { ready = false; }
    return jsonResult({ project_id: project.projectId, sessions: [{ state: status.state, ready, port: profile.port, last_used_at: status.lastUsedAt, snapshot_verification: status.snapshotVerification }] });
  } catch (error) {
    return profileError(error);
  }
}

export async function handleBrowserStop(ctx: AppContext, chatContextId: string, args: { session_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const explicitError = explicitSessionError(args.session_id);
  if (explicitError) return explicitError;
  let manager: BrowserProfileManager;
  let profile;
  try {
    manager = await profileManager();
    profile = await manager.getOwnedProfile(chatContextId);
  } catch (error) {
    return profileError(error);
  }
  if (profile.state !== "running" || !profile.port) return jsonError("BROWSER_SESSION_NOT_FOUND", "No browser session found. Call browser.start first.");
  if (!profile.instanceId || !profile.pid) return jsonError("BROWSER_PROFILE_STATE_INVALID", "The running browser lease is incomplete.");
  const lease: BrowserLease = {
    instanceId: profile.instanceId,
    pid: profile.pid,
    port: profile.port,
    startedAt: profile.leaseStartedAt ?? "",
  };
  try {
    const stopped = await stopManagedBrowserProfile(profile.profileKey, lease, "explicit_stop");
    return jsonResult({ ok: true, action: "browser.stop", ...stopped });
  } catch (error) {
    return profileError(error);
  }
}

type ManagedBrowserStopReason = BrowserStopReason | "explicit_stop";

export async function stopManagedBrowserProfile(
  profileKey: string,
  expectedLease: BrowserLease,
  reason: ManagedBrowserStopReason,
  expectedLastUsedAt?: string,
) {
  return await browserOperations.run(profileKey, () => stopManagedBrowserProfileExclusive(
    profileKey,
    expectedLease,
    reason,
    expectedLastUsedAt,
  ), true);
}

async function stopManagedBrowserProfileExclusive(
  profileKey: string,
  expectedLease: BrowserLease,
  reason: ManagedBrowserStopReason,
  expectedLastUsedAt?: string,
) {
  const manager = await profileManager();
  const profile = await manager.getManagedProfile(profileKey);
  if (profile.state === "idle" && !profile.port && !profile.pid) return { stopped: true, reason: "already_stopped" };
  if (!profile.port || !profile.pid || !profile.instanceId) {
    throw new BrowserProfileError("BROWSER_PROFILE_STATE_INVALID", "The running browser lease is incomplete.");
  }
  const lease = expectedLease;
  const probeConfig = await loadLiveAuthProbeConfiguration(AUTH_PROBE_CONFIG);
  const probes = probeConfig.probes;
  if (profile.state === "running") {
    const started = await manager.beginCheckpoint(profileKey, lease, expectedLastUsedAt);
    if (!started) return { stopped: false, reason: "recent_activity" };
  }
  else if (profile.state === "checkpointing") {
    await manager.assertCheckpointLease(profileKey, lease);
  } else {
    throw new BrowserProfileError("BROWSER_PROFILE_BUSY", "Browser profile is not available for checkpointing.");
  }
  const claims = await runLiveAuthProbes(probes, (probe) => observeAuthProbe(lease.port, probe));
  try {
    const targets = await listTargets(lease.port);
    await Promise.all(targets.filter((target) => target.type === "page").map((target) => fetchJson(`http://127.0.0.1:${lease.port}/json/close/${target.id}`).catch(() => undefined)));
  } catch {
    // Fall back to terminating the owned browser process.
  }
  await closeBrowserProcess(lease.port, lease.pid);
  await clearActiveTargetId(profileKey);
  await manager.finishCheckpoint(profileKey, lease, claims);
  const chrome = resolveChromeExecutable();
  const promotion = chrome.executable_path
    ? await manager.promoteIfDominant(
      profileKey,
      (userDataDir) => validatePromotionSnapshot(chrome.executable_path!, userDataDir, probes, claims),
    )
    : { promoted: false, reason: "snapshot_validation_unavailable" };
  const gc = await manager.collectGarbage();
  return {
    stopped: true,
    reason,
    profile_retained: true,
    auth_probes_checked: probes.length,
    auth_probe_config_status: probeConfig.status,
    golden_promoted: promotion.promoted,
    promotion_reason: promotion.reason,
    snapshot_verification: promotion.snapshotVerification,
    garbage_collected_profiles: gc.deletedProfileKeys.length,
  };
}

export async function createBrowserLifecycleService(): Promise<BrowserLifecycleService> {
  return new BrowserLifecycleService({
    manager: await profileManager(),
    stopManagedBrowserProfile,
    idleTimeoutMs: browserIdleTimeoutMsFromEnv(),
  });
}

export async function handleBrowserScreenshot(ctx: AppContext, chatContextId: string, args: { session_id?: string; clip?: ScreenshotClip } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const session = await ensureSession(ctx, chatContextId, undefined, args.session_id);
  if ("error" in session) return session.error;
  try { await validateActiveTarget(session); } catch (error) { return tabError(error, "BROWSER_ACTIVE_TAB_FAILED", { port: session.port }); }
  try {
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.screenshot", args.clip ? { clip: args.clip } : {}, args.clip);
  } catch (err) {
    return jsonError("BROWSER_SCREENSHOT_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}

export async function handleBrowserOpen(
  ctx: AppContext,
  chatContextId: string,
  args: { url?: string; session_id?: string; observe?: BrowserObserve; wait_ms?: number; wait_for?: BrowserWaitFor }
) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const explicitError = explicitSessionError(args.session_id);
  if (explicitError) return explicitError;
  const url = validateHttpUrl(args?.url ?? "");
  if (!url) return jsonError("INVALID_URL", "browser.open requires an http or https URL.");
  const session = await ensureSession(ctx, chatContextId, url, args.session_id);
  if ("error" in session) return session.error;
  try { await validateActiveTarget(session); } catch (error) { return tabError(error, "BROWSER_ACTIVE_TAB_FAILED", { port: session.port }); }
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, async page => { await page.goto(url, { waitUntil: "domcontentloaded" }); });
    session.url = url;
    session.updated_at = new Date().toISOString();
    await (await profileManager()).touch(session.session_id);
    return await observeBrowserAction(ctx, chatContextId, project, session, "browser.open", args, { url });
  } catch (err) {
    return jsonError("BROWSER_OPEN_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}


export async function handleBrowserTabs(ctx: AppContext, chatContextId: string, args: { session_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const session = await ensureSession(ctx, chatContextId, undefined, args.session_id);
  if ("error" in session) return session.error;
  try {
    return await activeTabs.transaction(session.session_id, async ({ read, clear }) => {
      const activeTargetId = await read();
      const tabs = (await listTargets(session.port))
        .filter((target) => target.type === "page")
        .map(({ id, type, title, url }) => ({ id, type, title, url, active: id === activeTargetId }));
      if (activeTargetId && !tabs.some((tab) => tab.active)) await clear();
      return jsonResult({ project_id: project.projectId, port: session.port, active_target_id: tabs.find((tab) => tab.active)?.id, tabs });
    });
  } catch (err) {
    return jsonError("BROWSER_TABS_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}

export async function handleBrowserTabOpen(ctx: AppContext, chatContextId: string, args: { url?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const url = args.url === undefined ? "about:blank" : validateHttpUrl(args.url);
  if (!url) return jsonError("INVALID_URL", "browser.tab.open url must be http or https.");
  const session = await ensureSession(ctx, chatContextId);
  if ("error" in session) return session.error;
  try {
    return await activeTabs.transaction(session.session_id, async ({ write }) => {
      const target = await newTarget(session.port, url);
      if (target.type !== "page") return jsonError("BROWSER_TAB_OPEN_FAILED", "Chrome did not create a page target.");
      await write(target.id);
      await (await profileManager()).touch(session.session_id);
      return jsonResult({ ok: true, project_id: project.projectId, action: "browser.tab.open", port: session.port, active_target_id: target.id, tab: { id: target.id, type: target.type, title: target.title, url: target.url, active: true } });
    });
  } catch (error) {
    return tabError(error, "BROWSER_TAB_OPEN_FAILED", { port: session.port });
  }
}

export async function handleBrowserTabUse(ctx: AppContext, chatContextId: string, args: { target_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.target_id) return jsonError("MISSING_TARGET_ID", "browser.tab.use requires target_id.");
  const session = await ensureSession(ctx, chatContextId);
  if ("error" in session) return session.error;
  try {
    return await activeTabs.transaction(session.session_id, async ({ write }) => {
      const target = await findPageTarget(session.port, args.target_id!);
      if (!target) return jsonError("BROWSER_TAB_NOT_FOUND", "The requested browser tab does not exist.", { target_id: args.target_id });
      const response = await fetch(`http://127.0.0.1:${session.port}/json/activate/${encodeURIComponent(target.id)}`, { signal: operationSignal(5000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: activate target`);
      await write(target.id);
      await (await profileManager()).touch(session.session_id);
      return jsonResult({ ok: true, project_id: project.projectId, action: "browser.tab.use", port: session.port, active_target_id: target.id });
    });
  } catch (error) {
    return tabError(error, "BROWSER_TAB_USE_FAILED", { port: session.port, target_id: args.target_id });
  }
}

export async function handleBrowserTabClose(ctx: AppContext, chatContextId: string, args: { target_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  if (!args.target_id) return jsonError("MISSING_TARGET_ID", "browser.tab.close requires target_id.");
  const session = await ensureSession(ctx, chatContextId);
  if ("error" in session) return session.error;
  try {
    return await activeTabs.transaction(session.session_id, async ({ read, clear }) => {
      const target = await findPageTarget(session.port, args.target_id!);
      if (!target) return jsonError("BROWSER_TAB_NOT_FOUND", "The requested browser tab does not exist.", { target_id: args.target_id });
      await closeTarget(session.port, target.id);
      const activeTargetId = await read();
      if (activeTargetId === target.id) await clear();
      await (await profileManager()).touch(session.session_id);
      return jsonResult({ ok: true, project_id: project.projectId, action: "browser.tab.close", port: session.port, closed_target_id: target.id, active_target_id: activeTargetId === target.id ? undefined : activeTargetId });
    });
  } catch (error) {
    return tabError(error, "BROWSER_TAB_CLOSE_FAILED", { port: session.port, target_id: args.target_id });
  }
}

export async function handleBrowserDom(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; mode?: "text" | "html" | "both"; max_bytes?: number } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const selector = args.selector || "body";
  const mode = args.mode ?? "text";
  const limit = Math.min(128 * 1024, Math.max(1, args.max_bytes ?? 32 * 1024));
  const perField = mode === "both" ? Math.floor(limit / 2) : limit;
  try {
    const dom = await evaluate<{
      selector: string;
      found: boolean;
      tagName?: string;
      outerText?: string;
      outerHTML?: string;
      title: string;
      url: string;
      truncated?: boolean;
    }>(session, `(() => {
      const selector = ${jsString(selector)};
      const element = document.querySelector(selector);
      return {
        selector,
        found: Boolean(element),
        tagName: element?.tagName,
        outerText: ${jsString(mode)} === "html" ? undefined : (element?.innerText ?? element?.textContent ?? "").slice(0, ${perField}),
        outerHTML: ${jsString(mode)} === "text" ? undefined : (element?.outerHTML ?? "").slice(0, ${perField}),
        truncated: (${jsString(mode)} !== "html" && (element?.innerText ?? element?.textContent ?? "").length > ${perField}) || (${jsString(mode)} !== "text" && (element?.outerHTML ?? "").length > ${perField}),
        title: document.title,
        url: location.href,
      };
    })()`);
    const outerText = dom.outerText === undefined ? undefined : utf8Prefix(dom.outerText, perField);
    const outerHTML = dom.outerHTML === undefined ? undefined : utf8Prefix(dom.outerHTML, perField);
    return jsonResult({ project_id: project.projectId, ...dom, mode, outerText, outerHTML, truncated: dom.truncated || outerText !== dom.outerText || outerHTML !== dom.outerHTML });
  } catch (err) {
    return jsonError("BROWSER_DOM_FAILED", err instanceof Error ? err.message : String(err), { port: session.port, selector });
  }
}

export async function handleBrowserSelectors(ctx: AppContext, chatContextId: string, args: { session_id?: string; limit?: number; query?: string } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const limit = Math.min(Math.max(args.limit ?? 80, 1), 500);
  const query = (args.query ?? "").toLowerCase();
  try {
    const result = await evaluate<{
      title: string;
      url: string;
      candidates: Array<{
        selector: string;
        tagName: string;
        text: string;
        role?: string | null;
        ariaLabel?: string | null;
        name?: string | null;
        href?: string | null;
        inputType?: string | null;
        disabled: boolean;
        visible: boolean;
        rect: { x: number; y: number; width: number; height: number };
      }>;
    }>(session, `(() => {
      const limit = ${Number(limit)};
      const query = ${jsString(query)};
      const cssEscape = globalThis.CSS?.escape || ((value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"));
      function selectorFor(el) {
        if (el.id) return "#" + cssEscape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 4) {
          let part = cur.tagName.toLowerCase();
          const parent = cur.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
            if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")";
          }
          parts.unshift(part);
          cur = parent;
        }
        return parts.join(" > ") || el.tagName.toLowerCase();
      }
      function isVisible(el, rect) {
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
      }
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],summary,[onclick],[tabindex]'));
      const candidates = [];
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("value") || "").trim().replace(/\\s+/g, " ").slice(0, 160);
        const item = {
          selector: selectorFor(el),
          tagName: el.tagName.toLowerCase(),
          text,
          role: el.getAttribute("role"),
          ariaLabel: el.getAttribute("aria-label"),
          name: el.getAttribute("name"),
          href: el.getAttribute("href"),
          inputType: el.getAttribute("type"),
          disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
          visible: isVisible(el, rect),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
        const haystack = [item.selector, item.tagName, item.text, item.role, item.ariaLabel, item.name, item.href, item.inputType].filter(Boolean).join(" ").toLowerCase();
        if (!query || haystack.includes(query)) candidates.push(item);
        if (candidates.length >= limit) break;
      }
      return { title: document.title, url: location.href, candidates };
    })()`);
    return jsonResult({ project_id: project.projectId, port: session.port, ...result });
  } catch (err) {
    return jsonError("BROWSER_SELECTORS_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}


async function observeBrowserAction(
  ctx: AppContext, chat: string, project: ProjectConfig, session: BrowserSession,
  action: string, args: { observe?: BrowserObserve; wait_ms?: number; wait_for?: BrowserWaitFor },
  details: Record<string, unknown> = {},
) {
  return await observeAfterAction(action, async () => {
    if (args.wait_ms) await sleep(Math.min(Math.max(args.wait_ms, 0), 10_000));
    const waited = args.wait_for ? await handleBrowserWait(ctx, chat, args.wait_for) : undefined;
    if (waited && "isError" in waited && waited.isError) return waited;
    const metadata = { ok: true, action_applied: true, project_id: project.projectId, action, ...details, ...(waited && "structuredContent" in waited ? { wait: waited.structuredContent } : {}) };
    if (args.observe === "none" || (args.observe === undefined && args.wait_for)) return jsonResult(metadata);
    if (args.observe === "snapshot") {
      const target = await validateActiveTarget(session);
      const snapshot = await withBrowserPage(session.port, target.id, page => page.locator("body").ariaSnapshot({ timeout: 5000 }));
      return jsonResult({ ...metadata, snapshot: utf8Prefix(snapshot, 32 * 1024), truncated: Buffer.byteLength(snapshot) > 32 * 1024 });
    }
    return await captureCdpScreenshot(ctx, chat, project, session, action, metadata);
  });
}

export async function handleBrowserClick(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; frame?: string; observe?: BrowserObserve; wait_ms?: number; wait_for?: BrowserWaitFor } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.selector) return jsonError("MISSING_SELECTOR", "browser.click requires selector.");
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, page => clickElement(page, { selector: args.selector!, frame: args.frame }));
    return await observeBrowserAction(ctx, chatContextId, project, session, "browser.click", args, { selector: args.selector });
  } catch (error) {
    return jsonError("BROWSER_CLICK_FAILED", error instanceof Error ? error.message : String(error), { action_applied: "unknown", retry_action: false });
  }
}

export async function handleBrowserType(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; frame?: string; text?: string; submit?: boolean; observe?: BrowserObserve; wait_ms?: number; wait_for?: BrowserWaitFor } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.selector) return jsonError("MISSING_SELECTOR", "browser.type requires selector.");
  if (typeof args.text !== "string") return jsonError("MISSING_TEXT", "browser.type requires text.");
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, page => fillElement(page, { selector: args.selector!, frame: args.frame, text: args.text!, submit: args.submit }));
    return await observeBrowserAction(ctx, chatContextId, project, session, "browser.type", args, { selector: args.selector, submitted: args.submit === true });
  } catch (error) {
    return jsonError("BROWSER_TYPE_FAILED", error instanceof Error ? error.message : String(error), { action_applied: "unknown", retry_action: false });
  }
}

export async function handleBrowserWait(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number } = {}) {
  if (!args.selector && !args.text && !args.url_contains && !args.title_contains) return jsonError("WAIT_CONDITION_REQUIRED", "Specify at least one browser wait condition.");
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 5000, 1), 60_000);
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, async page => {
      const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
      if (args.selector) await page.locator(args.selector).waitFor({ state: "visible", timeout: remaining() });
      if (args.text || args.url_contains || args.title_contains) {
        await page.waitForFunction(
          conditions => (!conditions.text || (document.body?.innerText ?? "").includes(conditions.text))
            && (!conditions.url_contains || location.href.includes(conditions.url_contains))
            && (!conditions.title_contains || document.title.includes(conditions.title_contains)),
          { text: args.text, url_contains: args.url_contains, title_contains: args.title_contains },
          { timeout: remaining() },
        );
      }
    });
    return jsonResult({ ok: true, project_id: project.projectId, action: "browser.wait", waited_ms: Date.now() - started });
  } catch (error) {
    return jsonError("BROWSER_WAIT_FAILED", error instanceof Error ? error.message : String(error), { timeout_ms: timeoutMs });
  }
}


export async function handleBrowserEval(ctx: AppContext, chatContextId: string, args: { session_id?: string; expression?: string } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.expression) return jsonError("MISSING_EXPRESSION", "browser.eval requires expression.");
  try {
    const value = await evaluate<unknown>(session, args.expression);
    const page = await evaluate<{ title: string; url: string }>(session, `(() => ({ title: document.title, url: location.href }))()`);
    return jsonResult({ ok: true, project_id: project.projectId, action: "browser.eval", port: session.port, result: value, ...page });
  } catch (err) {
    return jsonError("BROWSER_EVAL_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}

export async function handleBrowserInteract(ctx: AppContext, chat: string, args: { action?: string; selector?: string; frame?: string; value?: string; target_selector?: string; files?: string[]; observe?: BrowserObserve; wait_for?: BrowserWaitFor }) {
  const selected = await activeSessionAndProject(ctx, chat);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.selector) return jsonError("MISSING_SELECTOR", "browser.interact requires selector.");
  const files: string[] = [];
  if (args.action === "upload") {
    if (!args.files?.length) return jsonError("MISSING_FILES", "Provide project-relative files to upload.");
    for (const path of args.files) {
      const resolved = resolveProjectPath(project, path);
      if (!resolved.ok) return jsonError(resolved.code, resolved.message);
      files.push(resolved.absolutePath);
    }
  }
  if (args.action === "select" && args.value === undefined) return jsonError("MISSING_VALUE", "select requires value.");
  if (args.action === "drag" && !args.target_selector) return jsonError("MISSING_TARGET", "drag requires target_selector.");
  if (!["hover", "select", "check", "uncheck", "drag", "upload"].includes(args.action ?? "")) return jsonError("INVALID_ACTION", "Unsupported browser interaction.");
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, async page => {
      const locator = locatorFor(page, { selector: args.selector!, frame: args.frame });
      switch (args.action) {
        case "hover": await locator.hover(); break;
        case "select": await locator.selectOption(args.value!); break;
        case "check": await locator.check(); break;
        case "uncheck": await locator.uncheck(); break;
        case "drag": await locator.dragTo(locatorFor(page, { selector: args.target_selector!, frame: args.frame })); break;
        case "upload": await locator.setInputFiles(files); break;
      }
    });
    return await observeBrowserAction(ctx, chat, project, session, "browser.interact", args, { interaction: args.action, selector: args.selector });
  } catch (error) {
    return jsonError("BROWSER_INTERACTION_FAILED", error instanceof Error ? error.message : String(error), { action_applied: "unknown", retry_action: false });
  }
}

export async function handleBrowserPress(ctx: AppContext, chatContextId: string, args: { session_id?: string; key?: string; selector?: string; frame?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.key) return jsonError("MISSING_KEY", "browser.press requires key.");
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, async page => {
      if (args.selector) await locatorFor(page, { selector: args.selector, frame: args.frame }).press(args.key!);
      else await page.keyboard.press(args.key!);
    });
    return await observeBrowserAction(ctx, chatContextId, project, session, "browser.press", args, { key: args.key, selector: args.selector });
  } catch (err) {
    return jsonError("BROWSER_PRESS_FAILED", err instanceof Error ? err.message : String(err), { port: session.port, key: args.key, selector: args.selector });
  }
}

export async function handleBrowserReload(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  try {
    const target = await validateActiveTarget(session);
    await withBrowserPage(session.port, target.id, async page => { await page.reload({ waitUntil: "domcontentloaded" }); });
    return await observeBrowserAction(ctx, chatContextId, project, session, "browser.reload", args);
  } catch (err) {
    return jsonError("BROWSER_RELOAD_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}


async function navigateHistory(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}, direction: "back" | "forward") {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  try {
    const navigation = await withPage<{
      currentIndex: number;
      entries: Array<{ id: number; url: string; title: string }>;
      targetIndex: number;
      targetEntry?: { id: number; url: string; title: string };
    }>(session, async (client) => {
      await client.send("Page.enable");
      const history = await client.send<{ currentIndex: number; entries: Array<{ id: number; url: string; title: string }> }>("Page.getNavigationHistory");
      const targetIndex = direction === "back" ? history.currentIndex - 1 : history.currentIndex + 1;
      const targetEntry = history.entries[targetIndex];
      if (!targetEntry) {
        return { ...history, targetIndex, targetEntry: undefined };
      }
      await client.send("Page.navigateToHistoryEntry", { entryId: targetEntry.id });
      return { ...history, targetIndex, targetEntry };
    });
    if (!navigation.targetEntry) {
      return jsonError("BROWSER_HISTORY_BOUNDARY", `No ${direction} history entry is available.`, { port: session.port, current_index: navigation.currentIndex, entries: navigation.entries.length });
    }
    const action = direction === "back" ? "browser.back" : "browser.forward";
    const details = { from_index: navigation.currentIndex, to_index: navigation.targetIndex, target_entry: navigation.targetEntry };
    return await observeBrowserAction(ctx, chatContextId, project, session, action, args, details);
  } catch (err) {
    return jsonError(direction === "back" ? "BROWSER_BACK_FAILED" : "BROWSER_FORWARD_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}

export async function handleBrowserBack(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  return await navigateHistory(ctx, chatContextId, args, "back");
}

export async function handleBrowserForward(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  return await navigateHistory(ctx, chatContextId, args, "forward");
}
