import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createServer } from "node:net";
import type { AppContext } from "../server.js";
import type { ProjectConfig } from "../../types.js";

const MACOS_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MACOS_CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const PORT_MIN = Number(process.env.LOCAL_DEV_MCP_BROWSER_PORT_BASE ?? 18300);
const PORT_MAX = Number(process.env.LOCAL_DEV_MCP_BROWSER_PORT_MAX ?? 18799);
const BROWSER_HOME = join(homedir(), ".local-dev-mcp", "runtime", "browser");
const SESSION_FILE = join(BROWSER_HOME, "sessions.json");

type BrowserObserve = "none" | "after";

type BrowserSession = {
  session_id: string;
  project_id: string;
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

async function ensureBrowserHome() {
  await mkdir(BROWSER_HOME, { recursive: true });
}

async function readSessions(): Promise<BrowserSession[]> {
  await ensureBrowserHome();
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8")) as BrowserSession[];
  } catch {
    return [];
  }
}

async function writeSessions(sessions: BrowserSession[]) {
  await ensureBrowserHome();
  await writeFile(SESSION_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

async function saveSession(session: BrowserSession) {
  const sessions = (await readSessions()).filter((existing) => existing.session_id !== session.session_id);
  sessions.push(session);
  await writeSessions(sessions);
}

async function removeSession(sessionId: string) {
  await writeSessions((await readSessions()).filter((session) => session.session_id !== sessionId));
}

async function findFreePort(): Promise<number> {
  const used = new Set((await readSessions()).map((session) => session.port));
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    if (used.has(port)) continue;
    if (await canListen(port)) return port;
  }
  throw new Error(`No free browser port in range ${PORT_MIN}-${PORT_MAX}`);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
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
  return await fetchJson<ChromeTarget>(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`);
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
  const sessions = await readSessions();
  const candidates = sessions.filter((session) => session.project_id === project.projectId);
  const session = sessionId
    ? candidates.find((candidate) => candidate.session_id === sessionId)
    : candidates.at(-1);
  if (!session) return { error: jsonError("BROWSER_SESSION_NOT_FOUND", "No browser session found. Call browser.start first.", { session_id: sessionId }) };
  try {
    await waitForCdp(session.port, 1200);
    return session;
  } catch (err) {
    return { error: jsonError("BROWSER_SESSION_NOT_READY", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port }) };
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
  return jsonResult({
    ok: true,
    project_id: project.projectId,
    action,
    session_id: session.session_id,
    port: session.port,
    ...extra,
    screenshot: screenshotMetadata,
    image_read: { path: output.relativePath },
  });
}

async function ensureSession(ctx: AppContext, chatContextId: string, url?: string, sessionId?: string): Promise<BrowserSession | { error: ReturnType<typeof jsonError> }> {
  const existing = await getSession(ctx, chatContextId, sessionId);
  if (!("error" in existing)) return existing;
  if (sessionId) return existing;
  const started = await handleBrowserStart(ctx, chatContextId, { url });
  const body = JSON.parse(started.content[0]?.text ?? "{}");
  if (!body.ok || !body.session_id) return { error: jsonError("BROWSER_START_FAILED", "Could not start browser session.", body) };
  const session = await getSession(ctx, chatContextId, body.session_id);
  return session;
}

export async function handleBrowserStatus(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const chrome = resolveChromeExecutable();
  const sessions = (await readSessions()).filter((session) => session.project_id === project.projectId);
  return jsonResult({
    project_id: project.projectId,
    backend: "chrome-devtools-protocol",
    chrome_available: chrome.available,
    chrome_executable: chrome.executable_path,
    port_range: { min: PORT_MIN, max: PORT_MAX },
    sessions: sessions.map(({ session_id, port, pid, created_at, updated_at, url }) => ({ session_id, port, pid, created_at, updated_at, url })),
    artifact_dir: "generated/local-dev-mcp/browser",
  });
}

export async function handleBrowserStart(ctx: AppContext, chatContextId: string, args: { url?: string; session_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const chrome = resolveChromeExecutable();
  if (!chrome.available || !chrome.executable_path) return jsonError("BROWSER_NOT_FOUND", "Chrome/Chromium executable not found.", { candidates: chrome.candidates });
  const url = args.url ? validateHttpUrl(args.url) ?? undefined : undefined;
  if (args.url && !url) return jsonError("INVALID_URL", "browser.start url must be http or https.");
  const sessionId = args.session_id || `browser-${Date.now()}`;
  const port = await findFreePort();
  const profileDir = join(BROWSER_HOME, "profiles", project.projectId, sessionId);
  await mkdir(profileDir, { recursive: true });
  const child = spawn(chrome.executable_path, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    url ?? "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  const version = await waitForCdp(port, 10_000);
  const now = new Date().toISOString();
  const session: BrowserSession = { session_id: sessionId, project_id: project.projectId, port, profile_dir: profileDir, pid: child.pid, created_at: now, updated_at: now, url };
  await saveSession(session);
  return jsonResult({ ok: true, project_id: project.projectId, session_id: sessionId, port, pid: child.pid, profile_dir: profileDir, url, browser: version.Browser });
}

export async function handleBrowserSessions(ctx: AppContext, chatContextId: string) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const sessions = (await readSessions()).filter((session) => session.project_id === project.projectId);
  const enriched = await Promise.all(sessions.map(async (session) => {
    let ready = false;
    try { await waitForCdp(session.port, 800); ready = true; } catch { ready = false; }
    return { ...session, ready };
  }));
  return jsonResult({ project_id: project.projectId, sessions: enriched });
}

export async function handleBrowserStop(ctx: AppContext, chatContextId: string, args: { session_id?: string } = {}) {
  const session = await getSession(ctx, chatContextId, args.session_id);
  if ("error" in session) return session.error;
  try {
    const target = await pickPageTarget(session.port);
    await fetchJson(`http://127.0.0.1:${session.port}/json/close/${target.id}`);
  } catch {
    // ignore close failure; fall back to process kill below
  }
  if (session.pid) {
    try { process.kill(session.pid); } catch { /* ignore */ }
  }
  await removeSession(session.session_id);
  return jsonResult({ ok: true, action: "browser.stop", session_id: session.session_id, port: session.port });
}

export async function handleBrowserScreenshot(ctx: AppContext, chatContextId: string, args: { session_id?: string } = {}) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const session = await ensureSession(ctx, chatContextId, undefined, args.session_id);
  if ("error" in session) return session.error;
  try {
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.screenshot");
  } catch (err) {
    return jsonError("BROWSER_SCREENSHOT_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
  }
}

export async function handleBrowserOpen(
  ctx: AppContext,
  chatContextId: string,
  args: { url?: string; session_id?: string; observe?: BrowserObserve; wait_ms?: number }
) {
  const project = getProject(ctx, chatContextId);
  if ("error" in project) return project.error;
  const url = validateHttpUrl(args?.url ?? "");
  if (!url) return jsonError("INVALID_URL", "browser.open requires an http or https URL.");
  const session = await ensureSession(ctx, chatContextId, url, args.session_id);
  if ("error" in session) return session.error;
  try {
    await withPage(session.port, async (client) => {
      await client.send("Page.enable");
      await client.send("Page.navigate", { url });
      await sleep(Math.min(Math.max(args?.wait_ms ?? 1000, 0), 10_000));
    });
    session.url = url;
    session.updated_at = new Date().toISOString();
    await saveSession(session);
    if (args?.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.open", session_id: session.session_id, port: session.port, url });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.open", { url });
  } catch (err) {
    return jsonError("BROWSER_OPEN_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
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
    return jsonResult({ project_id: project.projectId, session_id: session.session_id, port: session.port, tabs });
  } catch (err) {
    return jsonError("BROWSER_TABS_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
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
    return jsonResult({ project_id: project.projectId, session_id: session.session_id, port: session.port, ...dom });
  } catch (err) {
    return jsonError("BROWSER_DOM_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port, selector });
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
    return jsonResult({ project_id: project.projectId, session_id: session.session_id, port: session.port, ...result });
  } catch (err) {
    return jsonError("BROWSER_SELECTORS_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
  }
}


export async function handleBrowserClick(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
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
    if (!clicked.found) return jsonError("SELECTOR_NOT_FOUND", `No element found for selector: ${selector}`, { selector, session_id: session.session_id, port: session.port });
    await sleep(Math.min(Math.max(args.wait_ms ?? 500, 0), 10_000));
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.click", session_id: session.session_id, port: session.port, ...clicked });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.click", { clicked });
  } catch (err) {
    return jsonError("BROWSER_CLICK_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port, selector });
  }
}

export async function handleBrowserType(ctx: AppContext, chatContextId: string, args: { session_id?: string; selector?: string; text?: string; submit?: boolean; observe?: BrowserObserve; wait_ms?: number } = {}) {
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
    if (!typed.found) return jsonError("SELECTOR_NOT_FOUND", `No element found for selector: ${selector}`, { selector, session_id: session.session_id, port: session.port });
    await sleep(Math.min(Math.max(args.wait_ms ?? 500, 0), 10_000));
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.type", session_id: session.session_id, port: session.port, ...typed });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.type", { typed });
  } catch (err) {
    return jsonError("BROWSER_TYPE_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port, selector });
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
        return jsonResult({ ok: true, project_id: project.projectId, action: "browser.wait", session_id: session.session_id, port: session.port, waited_ms: timeoutMs - Math.max(0, deadline - Date.now()), ...status });
      }
      await sleep(250);
    }
    return jsonError("BROWSER_WAIT_TIMEOUT", "Timed out waiting for browser condition.", { session_id: session.session_id, port: session.port, selector: args.selector, text: args.text, url_contains: args.url_contains, title_contains: args.title_contains, timeout_ms: timeoutMs, last });
  } catch (err) {
    return jsonError("BROWSER_WAIT_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
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
    return jsonResult({ ok: true, project_id: project.projectId, action: "browser.eval", session_id: session.session_id, port: session.port, result: value, ...page });
  } catch (err) {
    return jsonError("BROWSER_EVAL_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
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
      if (!focused.found) return jsonError("SELECTOR_NOT_FOUND", `No element found for selector: ${args.selector}`, { selector: args.selector, session_id: session.session_id, port: session.port });
    }
    const event = keyEventFor(args.key);
    await withPage(session.port, async (client) => {
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    });
    await sleep(Math.min(Math.max(args.wait_ms ?? 500, 0), 10_000));
    const page = await evaluate<{ title: string; url: string }>(session.port, `(() => ({ title: document.title, url: location.href }))()`);
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.press", session_id: session.session_id, port: session.port, key: args.key, selector: args.selector, ...page });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.press", { key: args.key, selector: args.selector, ...page });
  } catch (err) {
    return jsonError("BROWSER_PRESS_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port, key: args.key, selector: args.selector });
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
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action: "browser.reload", session_id: session.session_id, port: session.port, ...page });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, "browser.reload", page);
  } catch (err) {
    return jsonError("BROWSER_RELOAD_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
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
      return jsonError("BROWSER_HISTORY_BOUNDARY", `No ${direction} history entry is available.`, { session_id: session.session_id, port: session.port, current_index: navigation.currentIndex, entries: navigation.entries.length });
    }
    await sleep(Math.min(Math.max(args.wait_ms ?? 1000, 0), 10_000));
    const page = await evaluate<{ title: string; url: string }>(session.port, `(() => ({ title: document.title, url: location.href }))()`);
    const action = direction === "back" ? "browser.back" : "browser.forward";
    const details = { from_index: navigation.currentIndex, to_index: navigation.targetIndex, target_entry: navigation.targetEntry, ...page };
    if (args.observe === "none") return jsonResult({ ok: true, project_id: project.projectId, action, session_id: session.session_id, port: session.port, ...details });
    return await captureCdpScreenshot(ctx, chatContextId, project, session, action, details);
  } catch (err) {
    return jsonError(direction === "back" ? "BROWSER_BACK_FAILED" : "BROWSER_FORWARD_FAILED", err instanceof Error ? err.message : String(err), { session_id: session.session_id, port: session.port });
  }
}

export async function handleBrowserBack(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  return await navigateHistory(ctx, chatContextId, args, "back");
}

export async function handleBrowserForward(ctx: AppContext, chatContextId: string, args: { session_id?: string; observe?: BrowserObserve; wait_ms?: number } = {}) {
  return await navigateHistory(ctx, chatContextId, args, "forward");
}
