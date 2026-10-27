import type { Page } from "playwright-core";

/** One-shot HTTP Basic authentication for the requested origin; never caches secrets in MCP state. */
export type BrowserHttpCredentials = { username: string; password: string };

export function validateHttpCredentials(url: string, credentials: BrowserHttpCredentials): string {
  const target = new URL(url);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && isLoopback)) {
    throw new Error("HTTP Basic credentials require HTTPS (or a loopback development URL).");
  }
  if (target.username || target.password) throw new Error("Credentials must not be embedded in the URL.");
  if (typeof credentials.username !== "string" || !credentials.username || credentials.username.includes(":") ||
      /[\r\n]/.test(credentials.username) || typeof credentials.password !== "string" ||
      !credentials.password || /[\r\n]/.test(credentials.password)) {
    throw new Error("A valid HTTP Basic username and password are required.");
  }
  return target.origin;
}

type AuthEvent = {
  requestId: string;
  request: { url: string };
  authChallenge: { source?: string };
};
type PausedEvent = { requestId: string };

/**
 * Uses Chrome's native HTTP-auth challenge. The credentials are only offered
 * for server challenges from the exact navigation origin, including subsequent
 * same-origin requests. Cross-origin redirects cannot receive the credentials.
 */
export async function navigateWithHttpBasicAuth(
  page: Page,
  url: string,
  credentials: BrowserHttpCredentials,
): Promise<void> {
  const origin = validateHttpCredentials(url, credentials);
  const cdp = await page.context().newCDPSession(page);
  const attempted = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const track = (call: Promise<unknown>) => {
    const settled = call.catch(() => undefined).finally(() => pending.delete(settled));
    pending.add(settled);
  };
  const onPaused = (event: PausedEvent) => {
    track(cdp.send("Fetch.continueRequest", { requestId: event.requestId }));
  };
  const onAuth = (event: AuthEvent) => {
    let allowed = false;
    try {
      allowed = new URL(event.request.url).origin === origin
        && event.authChallenge.source === "Server"
        && !attempted.has(event.requestId);
    } catch { /* Malformed or cross-origin challenge: do not release credentials. */ }
    attempted.add(event.requestId);
    track(cdp.send("Fetch.continueWithAuth", {
      requestId: event.requestId,
      authChallengeResponse: allowed
        ? { response: "ProvideCredentials", username: credentials.username, password: credentials.password }
        : { response: "CancelAuth" },
    }));
  };
  cdp.on("Fetch.requestPaused", onPaused);
  cdp.on("Fetch.authRequired", onAuth);
  try {
    await cdp.send("Fetch.enable", {
      handleAuthRequests: true,
      patterns: [{ urlPattern: `${origin}/*`, requestStage: "Request" }],
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } finally {
    await cdp.send("Fetch.disable").catch(() => undefined);
    await Promise.allSettled([...pending]);
    cdp.removeListener("Fetch.requestPaused", onPaused);
    cdp.removeListener("Fetch.authRequired", onAuth);
    await cdp.detach().catch(() => undefined);
  }
}
