import { describe, it, expect, beforeEach } from "vitest";
import { loadApiKey, requireAuth } from "../../src/mcp/auth.js";
import http from "node:http";

function mockReq(authHeader?: string): http.IncomingMessage {
  const req = new http.IncomingMessage(http.createServer()._socket);
  req.headers = {};
  if (authHeader) {
    req.headers["authorization"] = authHeader;
  }
  return req;
}

function mockRes(): http.ServerResponse {
  const req = new http.IncomingMessage(http.createServer()._socket);
  return new http.ServerResponse(req);
}

describe("loadApiKey", () => {
  beforeEach(() => {
    delete process.env.LOCAL_DEV_MCP_API_KEY;
  });

  it("returns null when env var is not set", () => {
    expect(loadApiKey()).toBeNull();
  });

  it("returns null when env var is empty", () => {
    process.env.LOCAL_DEV_MCP_API_KEY = "";
    expect(loadApiKey()).toBeNull();
  });

  it("returns the key when env var is set", () => {
    process.env.LOCAL_DEV_MCP_API_KEY = "sk-test-123";
    expect(loadApiKey()).toBe("sk-test-123");
  });
});

describe("requireAuth", () => {
  it("passes when apiKey is null (auth disabled)", () => {
    const req = mockReq();
    const res = mockRes();
    expect(requireAuth(null, req, res)).toBe(true);
  });

  it("passes with correct bearer token", () => {
    const req = mockReq("Bearer sk-test-123");
    const res = mockRes();
    expect(requireAuth("sk-test-123", req, res)).toBe(true);
  });

  it("rejects when no auth header", () => {
    const req = mockReq();
    const res = mockRes();
    expect(requireAuth("sk-test-123", req, res)).toBe(false);
  });

  it("rejects with wrong bearer token", () => {
    const req = mockReq("Bearer wrong-key");
    const res = mockRes();
    expect(requireAuth("sk-test-123", req, res)).toBe(false);
  });

  it("rejects with non-bearer auth header", () => {
    const req = mockReq("Basic dGVzdDp0ZXN0");
    const res = mockRes();
    expect(requireAuth("sk-test-123", req, res)).toBe(false);
  });
});
