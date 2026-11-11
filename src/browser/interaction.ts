import { chromium, type Browser, type Page, type Locator } from "playwright-core";
import { requestSignal } from "../mcp/request-context.js";

type Connection = { ready: Promise<Browser>; timer?: ReturnType<typeof setTimeout>; users: number };
const connections = new Map<number, Connection>();

export type BrowserLocator = { selector: string; frame?: string };
export function locatorFor(page: Page, input: BrowserLocator): Locator {
  return input.frame ? page.frameLocator(input.frame).locator(input.selector) : page.locator(input.selector);
}

export async function withBrowserPage<T>(port: number, targetId: string, operation: (page: Page) => Promise<T>): Promise<T> {
  const signal = requestSignal();
  signal?.throwIfAborted();
  let entry = connections.get(port);
  if (!entry) {
    if (connections.size >= 16) throw new Error("Browser connection capacity reached");
    entry = { ready: chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000, noDefaults: true }), users: 0 };
    connections.set(port, entry);
  }
  clearTimeout(entry.timer);
  entry.users++;
  const currentEntry = entry;
  const cancel = () => {
    if (connections.get(port) === currentEntry) connections.delete(port);
    void currentEntry.ready.then(browser => browser.close()).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const browser = await entry.ready;
    signal?.throwIfAborted();
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const cdp = await context.newCDPSession(page);
        try {
          const target = await cdp.send("Target.getTargetInfo");
          if (target.targetInfo.targetId === targetId) {
            page.setDefaultTimeout(15_000);
            page.setDefaultNavigationTimeout(20_000);
            return await operation(page);
          }
        } finally { await cdp.detach().catch(() => undefined); }
      }
    }
    throw new Error("Selected browser target no longer exists");
  } finally {
    signal?.removeEventListener("abort", cancel);
    entry.users--;
    if (!entry.users) {
      const current = entry;
      current.timer = setTimeout(() => {
        if (connections.get(port) === current) connections.delete(port);
        void current.ready.then(browser => browser.close()).catch(() => undefined);
      }, 10_000);
      current.timer.unref?.();
    }
  }
}

export async function closeBrowserConnections(): Promise<void> {
  const entries = [...connections.values()];
  connections.clear();
  await Promise.allSettled(entries.map(async entry => { clearTimeout(entry.timer); await (await entry.ready).close(); }));
}

export async function readAccessibilitySnapshot(page: Page, input: BrowserLocator): Promise<string> {
  return await locatorFor(page, input).ariaSnapshot({ timeout: 10_000 });
}

export async function readDomElement(page: Page, input: BrowserLocator & { mode: "text" | "html" | "both"; maxBytes: number }) {
  const element = locatorFor(page, input);
  if (await element.count() === 0) return { found: false as const, truncated: false };
  const value = await element.first().evaluate((node, { mode, maxBytes }) => {
    // Keep this browser-evaluated closure self-contained. The tsx runtime may
    // wrap nested functions with __name, which is undefined inside the page.
    const result = {
      outerText: mode === "html" ? undefined : ((node as HTMLElement).innerText ?? node.textContent ?? ""),
      outerHTML: mode === "text" ? undefined : node.outerHTML,
      truncated: false,
    };
    for (const field of ["outerText", "outerHTML"] as const) {
      const source = result[field];
      if (source === undefined) continue;
      let prefix = source.slice(0, maxBytes);
      const last = prefix.charCodeAt(prefix.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
      const bytes = new TextEncoder().encode(prefix);
      let length = Math.min(bytes.length, maxBytes);
      for (;;) {
        try {
          result[field] = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
          break;
        } catch {
          if (length === 0) { result[field] = ""; break; }
          length--;
        }
      }
      result.truncated ||= prefix.length < source.length || length < bytes.length;
    }
    return { tagName: node.tagName, ...result };
  }, { mode: input.mode, maxBytes: input.maxBytes });
  return { found: true as const, ...value };
}

export async function clickElement(page: Page, input: BrowserLocator): Promise<void> {
  await locatorFor(page, input).click();
}

export async function fillElement(page: Page, input: BrowserLocator & { text: string; submit?: boolean }): Promise<void> {
  const locator = locatorFor(page, input);
  await locator.fill(input.text);
  if (input.submit) await locator.press("Enter");
}
