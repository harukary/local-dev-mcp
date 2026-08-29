import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createServer } from "node:net";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";
import { BrowserProfileError, BrowserProfileManager, browserProfileKey, type AuthClaimInput } from "../../browser/profile-manager.js";
import { loadLiveAuthProbeConfiguration, runLiveAuthProbes, type LiveAuthProbe } from "../../browser/auth-probes.js";

const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MACOS_CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const PORT_MIN = Number(process.env.LOCAL_DEV_MCP_BROWSER_PORT_BASE ?? 18300);
const PORT_MAX = Number(process.env.LOCAL_DEV_MCP_BROWSER_PORT_MAX ?? 18799);
const BROWSER_HOME = process.env.LOCAL_DEV_MCP_BROWSER_HOME ?? join(homedir(), ".local-dev-mcp", "runtime", "browser");
const SESSION_FILE = join(BROWSER_HOME, "sessions.json");
const DEFAULT_SESSION_ID = "default";
const DEFAULT_PROFILE_DIR = join(BROWSER_HOME, "profiles", DEFAULT_SESSION_ID);
const AUTH_PROBE_CONFIG = process.env.LOCAL_DEV_MCP_BROWSER_AUTH_PROBES ?? join(process.cwd(), "config", "browser-auth-probes.yaml");
const BROWSER_INSTANCE_ID = randomUUID();

type BrowserObserve = "none" | "after";
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

function jsonResult(value: unknown, imageContent: ImageContent[] = []): JsonResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }, ...imageContent],
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
  if (!projectId) {
    return { error: jsonError("PROJECT_NOT_SELECTED", "No project is selected for this chat. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  const project = ctx.registry.get(projectId);
  if (!project) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return { error: jsonError("PROJECT_NOT_SELECTED", "The selected project is no longer available. Call project.select first.", { available_projects: ctx.registry.getAll().map((p) => p.projectId) }) };
  }
  return project;
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
  const response = await fetch(url);
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
  const response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${endpoint}`);
  return await response.json() as ChromeTarget;
}

async function pickPageTarget(port: number): Promise<ChromeTarget> {
  const targets = await listTargets(port);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;
  return await newTarget(port);
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

class CdpClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP websocket connection failed")), { once: true });
      ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
      ws.addEventListener("close", () => {
        for (const pending of this.pending.values()) pending.reject(new Error("CDP websocket closed"));
        this.pending.clear();
      });
    });
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("CDP websocket is not open");
    const id = this.nextId++;
    const payload = { id, method, ...(params ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  close() {
    this.ws?.close();
  }

  private onMessage(raw: string) {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
    else pending.resolve(message.result);
  }
}

async function withPage<T>(port: number, fn: (client: CdpClient, target: ChromeTarget) => Promise<T>): Promise<T> {
  const target = await pickPageTarget(port);
  if (!target.webSocketDebuggerUrl) throw new Error("No CDP websocket URL for page target");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    return await fn(client, target);
  } finally {
    client.close();
  }
}


async function evaluate<T = unknown>(port: number, expression: string): Promise<T> {
  return await withPage<T>(port, async (client) => {
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

async function waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(100);
  if (isPidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    await sleep(100);
  }
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
  return { project, session };
}

async function captureCdpScreenshot(ctx: AppContext, chatContextId: string, project: ProjectConfig, session: BrowserSession, action: string, extra: Record<string, unknown> = {}) {
  const result = await withPage<{ data: string }>(session.port, async (client) => {
    await client.send("Page.enable");
    return await client.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true });
  });
  const output = await artifactPath(project, "browser-cdp-shot");
  await writeFile(output.absolutePath, Buffer.from(result.data, "base64"));
  const imageRead = await import("./image-read.js");
  const imageResult = await imageRead.handleImageRead(ctx, chatContextId, { path: output.relativePath });
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
    url ?? "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  let version;
  try {
    version = await waitForCdp(port, 10_000);
    await manager.markRunning(profile.profileKey, { instanceId: BROWSER_INSTANCE_ID, pid: child.pid ?? 0, port });
  } catch (error) {
    if (child.pid) try { process.kill(child.pid); } catch { /* ignore */ }
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
  const probeConfig = await loadLiveAuthProbeConfiguration(AUTH_PROBE_CONFIG);
  const probes = probeConfig.probes;
  if (!profile.instanceId || !profile.pid) return jsonError("BROWSER_PROFILE_STATE_INVALID", "The running browser lease is incomplete.");
  const lease = { instanceId: profile.instanceId, pid: profile.pid, port: profile.port };
  try {
    await manager.beginCheckpoint(profile.profileKey, lease);
  } catch (error) {
    return profileError(error);
  }
  const claims = await runLiveAuthProbes(probes, (probe) => observeAuthProbe(profile.port!, probe));
  try {
    const targets = await listTargets(profile.port);
    await Promise.all(targets.filter((target) => target.type === "page").map((target) => fetchJson(`http://127.0.0.1:${profile.port}/json/close/${target.id}`).catch(() => undefined)));
  } catch {
    // Fall back to terminating the owned browser process.
  }
  if (profile.pid) {
    try { process.kill(profile.pid, "SIGTERM"); } catch { /* ignore */ }
  }
  await waitForProcessExit(profile.pid, 5000);
  try {
    await manager.finishCheckpoint(profile.profileKey, lease, claims);
  } catch (error) {
    return profileError(error);
  }
  const chrome = resolveChromeExecutable();
  const promotion = chrome.executable_path
    ? await manager.promoteIfDominant(
      profile.profileKey,
      (userDataDir) => validatePromotionSnapshot(chrome.executable_path!, userDataDir, probes, claims),
    )
    : { promoted: false, reason: "snapshot_validation_unavailable" };
  const gc = await manager.collectGarbage();
  return jsonResult({
    ok: true,
    action: "browser.stop",
    profile_retained: true,
    auth_probes_checked: probes.length,
    auth_probe_config_status: probeConfig.status,
    golden_promoted: promotion.promoted,
    promotion_reason: promotion.reason,
    snapshot_verification: promotion.snapshotVerification,
    garbage_collected_profiles: gc.deletedProfileKeys.length,
  });
}

export async function handleBrowserScreenshot(ctx: AppContext, chatContextId: string, args: { session_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const session = await ensureSession(ctx, chatContextId, undefined, args.session_id);
  if ("error" in session) return session.error;
  try {
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.screenshot");
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
  try {
    await withPage(session.port, async (client) => {
      await client.send("Page.enable");
      await client.send("Page.navigate", { url });
      await sleep(Math.min(Math.max(args?.wait_ms ?? (args?.wait_for ? 0 : 1000), 0), 10_000));
    });
    session.url = url;
    session.updated_at = new Date().toISOString();
    await (await profileManager()).touch(session.session_id);
    const waited = args?.wait_for ? await handleBrowserWait(ctx, chatContextId, args.wait_for) : undefined;
    if (waited && "isError" in waited && waited.isError) return waited;
    const wait = waited && "structuredContent" in waited ? waited.structuredContent : undefined;
    if (args?.observe === "none" || (args?.observe === undefined && args?.wait_for)) return jsonResult({ ok: true, project_id: project.projectId, action: "browser.open", port: session.port, url, wait });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.open", { url, wait });
  } catch (err) {
    return jsonError("BROWSER_OPEN_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}


export async function handleBrowserTabs(ctx: AppContext, chatContextId: string, args: { session_id?: string } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  try {
    const tabs = (await listTargets(session.port))
      .filter((target) => target.type === "page")
      .map(({ id, type, title, url }) => ({ id, type, title, url }));
    return jsonResult({ project_id: project.projectId, port: session.port, tabs });
  } catch (err) {
    return jsonError("BROWSER_TABS_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}

export async function handleBrowserDom(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const selector = args.selector || "body";
  try {
    const dom = await evaluate<{
      selector: string;
      found: boolean;
      tagName?: string;
      outerText?: string;
      outerHTML?: string;
      title: string;
      url: string;
    }>(session.port, `(() => {
      const selector = ${jsString(selector)};
      const element = document.querySelector(selector);
      return {
        selector,
        found: Boolean(element),
        tagName: element?.tagName,
        outerText: element?.innerText ?? element?.textContent ?? "",
        outerHTML: element?.outerHTML ?? "",
        title: document.title,
        url: location.href,
      };
    })()`);
    return jsonResult({ project_id: project.projectId, port: session.port, ...dom });
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
    }>(session.port, `(() => {
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


export async function handleBrowserClick(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; observe?: BrowserObserve; wait_ms?: number; wait_for?: BrowserWaitFor } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const selector = args.selector;
  if (!selector) return jsonError("MISSING_SELECTOR", "browser.click requires selector.");
  try {
    const clicked = await evaluate<{
      selector: string;
      found: boolean;
      tagName?: string;
      text?: string;
      title: string;
      url: string;
    }>(session.port, `(() => {
      const selector = ${jsString(selector)};
      const element = document.querySelector(selector);
      if (!element) return { selector, found: false, title: document.title, url: location.href };
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return {
        selector,
        found: true,
        tagName: element.tagName,
        text: (element.innerText || element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 200),
        title: document.title,
        url: location.href,
      };
    })()`);
    if (!clicked.found) return jsonError("SELECTOR_NOT_FOUND", `No element found for selector: ${selector}`, { selector, port: session.port });
    await sleep(Math.min(Math.max(args.wait_ms ?? (args.wait_for ? 0 : 500), 0), 10_000));
    const waited = args.wait_for ? await handleBrowserWait(ctx, chatContextId, args.wait_for) : undefined;
    if (waited && "isError" in waited && waited.isError) return waited;
    const wait = waited && "structuredContent" in waited ? waited.structuredContent : undefined;
    if (args.observe === "none" || (args.observe === undefined && args.wait_for)) return jsonResult({ ok: true, project_id: project.projectId, action: "browser.click", port: session.port, ...clicked, wait });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.click", { clicked, wait });
  } catch (err) {
    return jsonError("BROWSER_CLICK_FAILED", err instanceof Error ? err.message : String(err), { port: session.port, selector });
  }
}

export async function handleBrowserType(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; text?: string; submit?: boolean; observe?: BrowserObserve; wait_ms?: number; wait_for?: BrowserWaitFor } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const selector = args.selector;
  if (!selector) return jsonError("MISSING_SELECTOR", "browser.type requires selector.");
  if (args.text === undefined) return jsonError("MISSING_TEXT", "browser.type requires text.");
  try {
    const typed = await evaluate<{
      selector: string;
      found: boolean;
      tagName?: string;
      value?: string;
      submitted?: boolean;
      title: string;
      url: string;
    }>(session.port, `(() => {
      const selector = ${jsString(selector)};
      const text = ${jsString(args.text)};
      const submit = ${args.submit ? "true" : "false"};
      const element = document.querySelector(selector);
      if (!element) return { selector, found: false, title: document.title, url: location.href };
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();
      if ("value" in element) element.value = text;
      else element.textContent = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      let submitted = false;
      if (submit) {
        const form = element.form || element.closest?.("form");
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
          submitted = true;
        } else {
          element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
          element.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
        }
      }
      return { selector, found: true, tagName: element.tagName, value: "value" in element ? element.value : element.textContent, submitted, title: document.title, url: location.href };
    })()`);
    if (!typed.found) return jsonError("SELECTOR_NOT_FOUND", `No element found for selector: ${selector}`, { selector, port: session.port });
    await sleep(Math.min(Math.max(args.wait_ms ?? (args.wait_for ? 0 : 500), 0), 10_000));
    const waited = args.wait_for ? await handleBrowserWait(ctx, chatContextId, args.wait_for) : undefined;
    if (waited && "isError" in waited && waited.isError) return waited;
    const wait = waited && "structuredContent" in waited ? waited.structuredContent : undefined;
    if (args.observe === "none" || (args.observe === undefined && args.wait_for)) return jsonResult({ ok: true, project_id: project.projectId, action: "browser.type", port: session.port, ...typed, wait });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.type", { typed, wait });
  } catch (err) {
    return jsonError("BROWSER_TYPE_FAILED", err instanceof Error ? err.message : String(err), { port: session.port, selector });
  }
}

export async function handleBrowserWait(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? 5000, 1), 60_000);
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  try {
    while (Date.now() <= deadline) {
      const status = await evaluate<{
        selector?: string;
        selectorFound?: boolean;
        text?: string;
        textFound?: boolean;
        urlContains?: string;
        urlContainsFound?: boolean;
        titleContains?: string;
        titleContainsFound?: boolean;
        title: string;
        url: string;
      }>(session.port, `(() => {
        const selector = ${jsString(args.selector ?? "")};
        const text = ${jsString(args.text ?? "")};
        const urlContains = ${jsString(args.url_contains ?? "")};
        const titleContains = ${jsString(args.title_contains ?? "")};
        const selectorFound = selector ? Boolean(document.querySelector(selector)) : undefined;
        const visibleText = document.body?.innerText || document.documentElement?.innerText || "";
        const textFound = text ? visibleText.includes(text) : undefined;
        const urlContainsFound = urlContains ? location.href.includes(urlContains) : undefined;
        const titleContainsFound = titleContains ? document.title.includes(titleContains) : undefined;
        return { selector: selector || undefined, selectorFound, text: text || undefined, textFound, urlContains: urlContains || undefined, urlContainsFound, titleContains: titleContains || undefined, titleContainsFound, title: document.title, url: location.href };
      })()`);
      last = status;
      const selectorOk = args.selector ? status.selectorFound === true : true;
      const textOk = args.text ? status.textFound === true : true;
      const urlOk = args.url_contains ? status.urlContainsFound === true : true;
      const titleOk = args.title_contains ? status.titleContainsFound === true : true;
      if (selectorOk && textOk && urlOk && titleOk) {
        return jsonResult({ ok: true, project_id: project.projectId, action: "browser.wait", port: session.port, waited_ms: timeoutMs - Math.max(0, deadline - Date.now()), ...status });
      }
      await sleep(250);
    }
    return jsonError("BROWSER_WAIT_TIMEOUT", "Timed out waiting for browser condition.", { port: session.port, selector: args.selector, text: args.text, url_contains: args.url_contains, title_contains: args.title_contains, timeout_ms: timeoutMs, last });
  } catch (err) {
    return jsonError("BROWSER_WAIT_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}


export async function handleBrowserEval(ctx: AppContext, chatContextId: string, args: { session_id?: string; expression?: string } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.expression) return jsonError("MISSING_EXPRESSION", "browser.eval requires expression.");
  try {
    const value = await evaluate<unknown>(session.port, args.expression);
    const page = await evaluate<{ title: string; url: string }>(session.port, `(() => ({ title: document.title, url: location.href }))()`);
    return jsonResult({ ok: true, project_id: project.projectId, action: "browser.eval", port: session.port, result: value, ...page });
  } catch (err) {
    return jsonError("BROWSER_EVAL_FAILED", err instanceof Error ? err.message : String(err), { port: session.port });
  }
}

function keyEventFor(key: string) {
  const normalized = key.length === 1 ? key : key[0].toUpperCase() + key.slice(1);
  const codes: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
    Home: { code: "Home", windowsVirtualKeyCode: 36 },
    End: { code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
  };
  if (codes[normalized]) return { key: normalized, ...codes[normalized] };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: key };
  }
  return { key: normalized, code: normalized, windowsVirtualKeyCode: 0 };
}

export async function handleBrowserPress(ctx: AppContext, chatContextId: string, args: { session_id?: string; key?: string; selector?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  if (!args.key) return jsonError("MISSING_KEY", "browser.press requires key.");
  try {
    if (args.selector) {
      const focused = await evaluate<{ selector: string; found: boolean }>(session.port, `(() => {
        const selector = ${jsString(args.selector)};
        const element = document.querySelector(selector);
        if (!element) return { selector, found: false };
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();
        return { selector, found: true };
      })()`);
      if (!focused.found) return jsonError("SELECTOR_NOT_FOUND", `No element found for selector: ${args.selector}`, { selector: args.selector, port: session.port });
    }
    const event = keyEventFor(args.key);
    await withPage(session.port, async (client) => {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    });
    await sleep(Math.min(Math.max(args.wait_ms ?? 500, 0), 10_000));
    const page = await evaluate<{ title: string; url: string }>(session.port, `(() => ({ title: document.title, url: location.href }))()`);
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.press", port: session.port, key: args.key, selector: args.selector, ...page });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.press", { key: args.key, selector: args.selector, ...page });
  } catch (err) {
    return jsonError("BROWSER_PRESS_FAILED", err instanceof Error ? err.message : String(err), { port: session.port, key: args.key, selector: args.selector });
  }
}

export async function handleBrowserReload(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  const selected = await activeSessionAndProject(ctx, chatContextId, args.session_id);
  if ("error" in selected) return selected.error;
  const { project, session } = selected;
  try {
    await withPage(session.port, async (client) => {
      await client.send("Page.enable");
      await client.send("Page.reload", { ignoreCache: false });
    });
    await sleep(Math.min(Math.max(args.wait_ms ?? 1000, 0), 10_000));
    const page = await evaluate<{ title: string; url: string }>(session.port, `(() => ({ title: document.title, url: location.href }))()`);
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.reload", port: session.port, ...page });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.reload", page);
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
    }>(session.port, async (client) => {
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
    await sleep(Math.min(Math.max(args.wait_ms ?? 1000, 0), 10_000));
    const page = await evaluate<{ title: string; url: string }>(session.port, `(() => ({ title: document.title, url: location.href }))()`);
    const action = direction === "back" ? "browser.back" : "browser.forward";
    const details = { from_index: navigation.currentIndex, to_index: navigation.targetIndex, target_entry: navigation.targetEntry, ...page };
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action, port: session.port, ...details });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, action, details);
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
