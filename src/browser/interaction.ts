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

export async function clickElement(page: Page, input: BrowserLocator): Promise<void> {
  await locatorFor(page, input).click();
}

export async function fillElement(page: Page, input: BrowserLocator & { text: string; submit?: boolean }): Promise<void> {
  const locator = locatorFor(page, input);
  await locator.fill(input.text);
  if (input.submit) await locator.press("Enter");
}
