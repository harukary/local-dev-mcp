import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPENAI_ALLOWED_SUBJECT_ENV,
  OPENAI_ALLOWED_SUBJECT_FILE_ENV,
  OPENAI_SUBJECT_POLICY_ENV,
  OPENAI_TUNNEL_TOKEN_ENV,
  OPENAI_TUNNEL_TOKEN_FILE_ENV,
  resolveOpenAiSubjectAuthConfig,
  resolveOpenAiSubjectPolicy,
  resolveOpenAiTunnelAuthConfig,
  verifyOpenAiSubject,
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

describe("ChatGPT subject allowlist", () => {
  it("defaults to enforced authorization and accepts an explicit tunnel-only policy", () => {
    expect(resolveOpenAiSubjectPolicy({})).toBe("enforce");
    expect(resolveOpenAiSubjectPolicy({ [OPENAI_SUBJECT_POLICY_ENV]: "tunnel_only" })).toBe("tunnel_only");
    expect(() => resolveOpenAiSubjectPolicy({ [OPENAI_SUBJECT_POLICY_ENV]: "unknown" })).toThrow("enforce or tunnel_only");
  });
  it("loads an inline allowed subject", () => {
    expect(resolveOpenAiSubjectAuthConfig({
      [OPENAI_ALLOWED_SUBJECT_ENV]: "subject-owner",
    })).toEqual({ subject: "subject-owner" });
  });

  it("loads an allowed subject from a private file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-subject-auth-"));
    const subjectFile = path.join(dir, "subject");
    writeFileSync(subjectFile, "subject-owner\n", { mode: 0o600 });
    try {
      expect(resolveOpenAiSubjectAuthConfig({
        [OPENAI_ALLOWED_SUBJECT_FILE_ENV]: subjectFile,
      })).toEqual({ subject: "subject-owner" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous subject configuration", () => {
    expect(() => resolveOpenAiSubjectAuthConfig({
      [OPENAI_ALLOWED_SUBJECT_ENV]: "subject-owner",
      [OPENAI_ALLOWED_SUBJECT_FILE_ENV]: "/tmp/subject",
    })).toThrow("mutually exclusive");
  });

  it("matches only the configured subject", () => {
    expect(verifyOpenAiSubject("subject-owner", "subject-owner")).toBe(true);
    expect(verifyOpenAiSubject("subject-other", "subject-owner")).toBe(false);
    expect(verifyOpenAiSubject(undefined, "subject-owner")).toBe(false);
  });
});
