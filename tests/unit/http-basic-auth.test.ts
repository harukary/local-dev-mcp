import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import { navigateWithHttpBasicAuth, validateHttpCredentials } from "../../src/browser/http-basic-auth.js";
import { validateToolInput } from "../../src/mcp/input-validation.js";

function testBrowser(events: (cdp: EventEmitter) => void) {
  const cdp = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
  };
  cdp.send = vi.fn(async () => ({}));
  cdp.detach = vi.fn(async () => {});
  const goto = vi.fn(async () => { events(cdp); await Promise.resolve(); });
  const page = { context: () => ({ newCDPSession: async () => cdp }), goto } as unknown as Page;
  return { page, cdp, goto };
}

describe("HTTP Basic navigation", () => {
  const credentials = { username: "demo-user", password: "private-pass" };

  it("limits credentials to HTTPS or development loopback and rejects embedded secrets", () => {
    expect(validateHttpCredentials("https://example.test/private", credentials)).toBe("https://example.test");
    expect(validateHttpCredentials("http://localhost:8765/private", credentials)).toBe("http://localhost:8765");
    expect(() => validateHttpCredentials("http://example.test/private", credentials)).toThrow("HTTPS");
    expect(() => validateHttpCredentials("https://demo-user:secret@example.test/", credentials)).toThrow("embedded");
    expect(() => validateHttpCredentials("https://example.test/", { username: "invalid:name", password: "secret" })).toThrow("valid");
  });

  it("makes the model-facing credential pair explicit and rejects invalid shapes", () => {
    expect(validateToolInput("browser.open", {
      url: "https://example.test/private", http_credentials: credentials,
    })).toBeUndefined();
    expect(validateToolInput("browser.open", {
      url: "https://example.test/private", http_credentials: { username: "demo-user" },
    })).toBeDefined();
  });

  it("only answers server authentication challenges for the exact requested origin", async () => {
    const { page, cdp, goto } = testBrowser(session => {
      session.emit("Fetch.requestPaused", { requestId: "paused" });
      session.emit("Fetch.authRequired", {
        requestId: "same", request: { url: "https://example.test/private" }, authChallenge: { source: "Server" },
      });
      session.emit("Fetch.authRequired", {
        requestId: "foreign", request: { url: "https://other.test/private" }, authChallenge: { source: "Server" },
      });
      session.emit("Fetch.authRequired", {
        requestId: "proxy", request: { url: "https://example.test/private" }, authChallenge: { source: "Proxy" },
      });
      session.emit("Fetch.authRequired", {
        requestId: "same", request: { url: "https://example.test/private" }, authChallenge: { source: "Server" },
      });
    });
    await navigateWithHttpBasicAuth(page, "https://example.test/private", credentials);
    expect(goto).toHaveBeenCalledWith("https://example.test/private", { waitUntil: "domcontentloaded" });
    expect(cdp.send).toHaveBeenCalledWith("Fetch.enable", {
      handleAuthRequests: true, patterns: [{ urlPattern: "https://example.test/*", requestStage: "Request" }],
    });
    const calls = cdp.send.mock.calls.filter((c: unknown[]) => c[0] === "Fetch.continueWithAuth");
    expect(calls).toHaveLength(4);
    expect(calls[0]?.[1].authChallengeResponse).toEqual({ response: "ProvideCredentials", ...credentials });
    for (const call of calls.slice(1)) expect(call[1].authChallengeResponse).toEqual({ response: "CancelAuth" });
    expect(cdp.send).toHaveBeenCalledWith("Fetch.continueRequest", { requestId: "paused" });
    expect(cdp.send).toHaveBeenCalledWith("Fetch.disable");
    expect(cdp.detach).toHaveBeenCalledOnce();
  });

  it("disables interception and detaches when navigation fails", async () => {
    const { page, cdp } = testBrowser(() => { throw new Error("failed navigation"); });
    await expect(navigateWithHttpBasicAuth(page, "https://example.test/private", credentials)).rejects.toThrow("failed navigation");
    expect(cdp.send).toHaveBeenCalledWith("Fetch.disable");
    expect(cdp.detach).toHaveBeenCalledOnce();
  });
});
