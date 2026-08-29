import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENAI_TUNNEL_TOKEN_ENV,
  OPENAI_TUNNEL_TOKEN_FILE_ENV,
  resolveOpenAiTunnelAuthConfig,
  verifyOpenAiTunnelToken,
} from "../../src/mcp/auth.js";

describe("OpenAI Secure MCP Tunnel auth", () => {
  it("requires a strong shared token for HTTP MCP", () => {
    expect(() => resolveOpenAiTunnelAuthConfig({})).toThrow(
      `${OPENAI_TUNNEL_TOKEN_ENV} or ${OPENAI_TUNNEL_TOKEN_FILE_ENV}`
    );
    expect(() => resolveOpenAiTunnelAuthConfig({
      [OPENAI_TUNNEL_TOKEN_ENV]: "too-short",
    })).toThrow("at least 32 characters");
  });

  it("loads an inline tunnel token", () => {
    const token = "a".repeat(48);
    expect(resolveOpenAiTunnelAuthConfig({
      [OPENAI_TUNNEL_TOKEN_ENV]: token,
    })).toEqual({ token });
  });

  it("loads a tunnel token from a file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-tunnel-auth-"));
    const tokenFile = path.join(dir, "token");
    const token = "b".repeat(48);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    try {
      expect(resolveOpenAiTunnelAuthConfig({
        [OPENAI_TUNNEL_TOKEN_FILE_ENV]: tokenFile,
      })).toEqual({ token });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous inline and file token configuration", () => {
    expect(() => resolveOpenAiTunnelAuthConfig({
      [OPENAI_TUNNEL_TOKEN_ENV]: "a".repeat(48),
      [OPENAI_TUNNEL_TOKEN_FILE_ENV]: "/tmp/token",
    })).toThrow("mutually exclusive");
  });

  it("compares the tunnel token without accepting duplicate headers", () => {
    const token = "c".repeat(48);
    expect(verifyOpenAiTunnelToken(token, token)).toBe(true);
    expect(verifyOpenAiTunnelToken("d".repeat(48), token)).toBe(false);
    expect(verifyOpenAiTunnelToken([token, token], token)).toBe(false);
    expect(verifyOpenAiTunnelToken(undefined, token)).toBe(false);
  });
});
