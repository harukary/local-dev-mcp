import { describe, expect, it, vi } from "vitest";
import { buildHttpAuthMiddleware, requireLoopbackHost } from "../../src/mcp/server.js";
import type { MuseAuthConfig } from "../../src/mcp/auth-muse.js";

const muse: MuseAuthConfig = {
  host: "mac.example-tailnet.ts.net:10000",
  token: "a".repeat(64),
  ownerHash: "b".repeat(64),
};
function fakeResponse() {
  const res = {
    locals: {} as Record<string, unknown>,
    setHeader: vi.fn(),
    json: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}
describe("Muse MCP HTTP boundary", () => {
  it("limits the Muse Host to the exact configured endpoint and the /mcp path", () => {
    const allowed = [
      { host: muse.host, path: "/mcp" },
      { host: "127.0.0.1:3456", path: "/healthz" },
    ];
    for (const item of allowed) {
      const next = vi.fn();
      requireLoopbackHost({ headers: { host: item.host }, path: item.path } as never, fakeResponse() as never, next, muse);
      expect(next).toHaveBeenCalledOnce();
    }
    for (const item of [
      { host: muse.host, path: "/healthz" },
      { host: muse.host, path: "/mcp/other" },
      { host: "other.ts.net:10000", path: "/mcp" },
      { host: "mac.example-tailnet.ts.net.attacker.test:10000", path: "/mcp" },
    ]) {
      const response = fakeResponse();
      const next = vi.fn();
      requireLoopbackHost({ headers: { host: item.host }, path: item.path } as never, response as never, next, muse);
      expect(response.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("requires Muse Bearer only on the dedicated Host without weakening ChatGPT auth", () => {
    const middleware = buildHttpAuthMiddleware({ token: "o".repeat(64) }, undefined, muse);
    const run = (host: string, headers: Record<string, string>) => {
      const next = vi.fn();
      const response = fakeResponse();
      middleware({ headers: { host, ...headers } } as never, response as never, next);
      return { next, response };
    };
    for (const headers of [
      {}, { authorization: "Bearer invalid" },
      { authorization: "Bearer " + muse.token, "x-local-dev-mcp-tunnel-token": "o".repeat(64) },
      { authorization: "Bearer " + muse.token, "cf-access-jwt-assertion": "test" },
    ]) {
      const { next, response } = run(muse.host, headers);
      expect(next).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(401);
    }
    const correct = run(muse.host, { authorization: "Bearer " + muse.token });
    expect(correct.next).toHaveBeenCalledOnce();
    expect(correct.response.locals.museAuthorized).toBe(true);
    const chatgpt = run("127.0.0.1:3456", { "x-local-dev-mcp-tunnel-token": "o".repeat(64) });
    expect(chatgpt.next).toHaveBeenCalledOnce();
    expect(chatgpt.response.locals.museAuthorized).toBeUndefined();
    const invalidHostToken = run("127.0.0.1:3456", { authorization: "Bearer " + muse.token });
    expect(invalidHostToken.response.status).toHaveBeenCalledWith(401);
  });
});
