import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import {
  HTTP_AUTH_MODE_ENV,
  OPENAI_TUNNEL_TOKEN_ENV,
  OPENAI_TUNNEL_TOKEN_FILE_ENV,
  loadApiKey,
  requireAuth,
  resolveHttpAuthConfig,
  verifyOpenAiTunnelToken,
} from "../../src/mcp/auth.js";

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

describe("HTTP auth mode", () => {
  it("defaults to OAuth", () => {
    expect(resolveHttpAuthConfig({})).toEqual({ mode: "oauth" });
  });

  it("rejects unknown auth modes", () => {
    expect(() => resolveHttpAuthConfig({ [HTTP_AUTH_MODE_ENV]: "tunnel" })).toThrow(
      `${HTTP_AUTH_MODE_ENV} must be "oauth" or "openai-tunnel"`
    );
  });

  it("requires a strong shared token in OpenAI Tunnel mode", () => {
    expect(() => resolveHttpAuthConfig({ [HTTP_AUTH_MODE_ENV]: "openai-tunnel" })).toThrow(
      `requires ${OPENAI_TUNNEL_TOKEN_ENV} or ${OPENAI_TUNNEL_TOKEN_FILE_ENV}`
    );
    expect(() => resolveHttpAuthConfig({
      [HTTP_AUTH_MODE_ENV]: "openai-tunnel",
      [OPENAI_TUNNEL_TOKEN_ENV]: "too-short",
    })).toThrow("at least 32 characters");
  });

  it("loads an inline OpenAI Tunnel token", () => {
    const token = "a".repeat(48);
    expect(resolveHttpAuthConfig({
      [HTTP_AUTH_MODE_ENV]: "openai-tunnel",
      [OPENAI_TUNNEL_TOKEN_ENV]: token,
    })).toEqual({ mode: "openai-tunnel", token });
  });

  it("loads an OpenAI Tunnel token from a file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-tunnel-auth-"));
    const tokenFile = path.join(dir, "token");
    const token = "b".repeat(48);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    try {
      expect(resolveHttpAuthConfig({
        [HTTP_AUTH_MODE_ENV]: "openai-tunnel",
        [OPENAI_TUNNEL_TOKEN_FILE_ENV]: tokenFile,
      })).toEqual({ mode: "openai-tunnel", token });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous inline and file token configuration", () => {
    expect(() => resolveHttpAuthConfig({
      [HTTP_AUTH_MODE_ENV]: "openai-tunnel",
      [OPENAI_TUNNEL_TOKEN_ENV]: "a".repeat(48),
      [OPENAI_TUNNEL_TOKEN_FILE_ENV]: "/tmp/token",
    })).toThrow("mutually exclusive");
  });

  it("compares the OpenAI Tunnel token without accepting duplicates", () => {
    const token = "c".repeat(48);
    expect(verifyOpenAiTunnelToken(token, token)).toBe(true);
    expect(verifyOpenAiTunnelToken("d".repeat(48), token)).toBe(false);
    expect(verifyOpenAiTunnelToken([token, token], token)).toBe(false);
    expect(verifyOpenAiTunnelToken(undefined, token)).toBe(false);
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
