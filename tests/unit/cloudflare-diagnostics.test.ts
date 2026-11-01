import { describe, expect, it } from "vitest";
import { summarizeCloudflareMcpRequest } from "../../src/mcp/cloudflare-diagnostics.js";

describe("Cloudflare MCP metadata diagnostics", () => {
  it("records sanitized fingerprints for non-sensitive headers and never stores credentials or request arguments", () => {
    const headers = {
      "cf-access-jwt-assertion": "secret-jwt-value",
      "cf-access-authenticated-user-email": "owner@example.com",
      authorization: "Bearer secret-bearer",
      cookie: "session=secret-cookie",
      "cf-connecting-ip": "192.0.2.19",
      "x-forwarded-for": "192.0.2.19",
      "mcp-session-id": "session-123",
      "x-request-id": "request-abc",
      "x-anthropic-conversation-id": "conversation-xyz",
      "x-anthropic-client": "claude-secret-client-id",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "shell.run",
      "user-agent": "private-agent",
    };
    const request = {
      jsonrpc: "2.0", id: "client-secret",
      method: "tools/call",
      params: {
        name: "shell.run",
        arguments: { command: "echo highly-private-command", project_id: "diary-project" },
        _meta: {
          "claude/session": "private-session-abc",
          counter: 42,
          context: { conversation: "private-conversation-id", token: "hidden-token" },
          messages: ["private-message"],
        },
      },
      _meta: { "client/request": "private-top-level-id" },
    };
    const result = summarizeCloudflareMcpRequest(headers, request) as any;
    const serialized = JSON.stringify(result);

    expect(result.source).toBe("cloudflare_access");
    expect(result.diagnosticSchema).toBe(2);
    expect(result.captureId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.method).toBe("tools/call");
    expect(result.headerCount).toBe(Object.keys(headers).length);
    expect(result.headers).toContain("cf-access-jwt-assertion");
    expect(result.headerDetails["cf-access-jwt-assertion"]).toEqual({ type: "redacted" });
    expect(result.headerDetails["cf-access-authenticated-user-email"]).toEqual({ type: "redacted" });
    expect(result.headerDetails["cf-connecting-ip"]).toEqual({ type: "redacted" });
    expect(result.headerDetails["x-forwarded-for"]).toEqual({ type: "redacted" });
    expect(result.headerDetails.authorization).toEqual({ type: "redacted" });
    expect(result.headerDetails.cookie).toEqual({ type: "redacted" });
    expect(result.headerDetails["x-anthropic-client"]).toMatchObject({ type: "string", length: 23 });
    expect(result.headerDetails["x-anthropic-client"].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.headerDetails["mcp-protocol-version"].protocolVersion).toBe("2026-07-28");
    expect(result.headerDetails["mcp-method"].method).toBe("tools/call");
    expect(result.identifierHeaders["mcp-session-id"]).toMatchObject({ type: "string", length: 11 });
    expect(result.identifierHeaders["x-anthropic-conversation-id"].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.identifierHeaders).not.toHaveProperty("cf-access-jwt-assertion");
    expect(result.identifierHeaders).not.toHaveProperty("authorization");
    expect(result.requestId).toMatchObject({ type: "string", length: 13 });
    expect(result.paramsFields).toEqual(["_meta", "arguments", "name"]);
    expect(result.paramsArguments).toEqual({
      type: "object", keys: ["command", "project_id"], keyCount: 2,
    });
    expect(result.paramsMeta.fields["claude/session"]).toMatchObject({ type: "string", length: 19 });
    expect(result.paramsMeta.fields.counter).toMatchObject({ type: "number", length: 2 });
    expect(result.paramsMeta.fields.context.fields.conversation.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.paramsMeta.fields.context.fields.token).toEqual({ type: "redacted" });
    expect(result.paramsMeta.fields.messages).toEqual({ type: "redacted" });
    expect(result.requestMeta.fields["client/request"].fingerprint).toMatch(/^[0-9a-f]{16}$/);

    for (const secret of [
      "secret-jwt-value", "owner@example.com", "secret-bearer", "secret-cookie", "192.0.2.19",
      "session-123", "request-abc", "conversation-xyz", "claude-secret-client-id", "private-agent",
      "private-session-abc", "highly-private-command", "private-message", "private-conversation-id",
      "hidden-token", "client-secret", "diary-project",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("correlates repeated scalar identifiers across calls and distinguishes changed values", () => {
    const request = {
      method: "tools/call",
      params: { _meta: { sessionId: "fixed-session" }, arguments: { command: "secret" } },
    };
    const first = summarizeCloudflareMcpRequest({
      "x-anthropic-client": "same-client", "x-session-id": "fixed-session",
    }, request) as any;
    const second = summarizeCloudflareMcpRequest({
      "x-anthropic-client": "same-client", "x-session-id": "fixed-session",
    }, request) as any;
    const changed = summarizeCloudflareMcpRequest({
      "x-anthropic-client": "different-client", "x-session-id": "other-session",
    }, request) as any;
    expect(first.captureId).toBe(second.captureId);
    expect(first.headerDetails["x-anthropic-client"].fingerprint)
      .toBe(second.headerDetails["x-anthropic-client"].fingerprint);
    expect(first.headerDetails["x-anthropic-client"].fingerprint)
      .not.toBe(changed.headerDetails["x-anthropic-client"].fingerprint);
    expect(first.identifierHeaders["x-session-id"].fingerprint)
      .toBe(second.identifierHeaders["x-session-id"].fingerprint);
    expect(first.identifierHeaders["x-session-id"].fingerprint)
      .not.toBe(changed.identifierHeaders["x-session-id"].fingerprint);
    expect(first.paramsMeta.fields.sessionId.fingerprint)
      .toBe(first.identifierHeaders["x-session-id"].fingerprint);
    const large = summarizeCloudflareMcpRequest({
      "mcp-session-id": "x".repeat(2500),
    }, request) as any;
    expect(large.identifierHeaders["mcp-session-id"]).toEqual({ type: "string", length: 2500 });
  });

  it("captures modern server/discover client capabilities and nested extension metadata without values", () => {
    const parsed = {
      jsonrpc: "2.0", id: 37, method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "claude.ai", version: "2026.11" },
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: {
              "io.anthropic/feature": {
                enabled: true, clientSessionId: "private-session-value",
                options: [1, { session: "another-private-id" }],
              },
            },
          },
        },
      },
    };
    const result = summarizeCloudflareMcpRequest({
      "mcp-method": "server/discover",
      "mcp-protocol-version": "2026-07-28",
      "x-anthropic-client": "client-fingerprint",
    }, parsed) as any;
    expect(result.method).toBe("server/discover");
    expect(result.headerDetails["mcp-method"].method).toBe("server/discover");
    expect(result.headerDetails["mcp-protocol-version"].protocolVersion).toBe("2026-07-28");
    expect(result.requestId).toMatchObject({ type: "number", length: 2 });
    expect(result.paramsMeta.fields["io.modelcontextprotocol/clientCapabilities"].fields.extensions.fields["io.anthropic/feature"].fields.clientSessionId.fingerprint)
      .toMatch(/^[0-9a-f]{16}$/);
    expect(result.clientInfo.fields.name.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(result)).not.toContain("private-session-value");
    expect(JSON.stringify(result)).not.toContain("another-private-id");
    expect(JSON.stringify(result)).not.toContain("claude.ai");
  });

  it("records legacy initialize and handles missing, oversized and unrecognized fields safely", () => {
    const result = summarizeCloudflareMcpRequest({}, {
      method: "initialize",
      params: {
        clientInfo: { name: "claude.ai", version: "2026.11" },
        protocolVersion: "2025-03-26",
      },
    }) as any;
    expect(result.method).toBe("initialize");
    expect(result.clientInfo.fields.name).toMatchObject({ type: "string", length: 9 });
    expect(result.additionalParams.protocolVersion).toMatchObject({ type: "string", length: 10 });
    expect(JSON.stringify(result)).not.toContain("claude.ai");
    expect(result.paramsMeta).toEqual({ type: "missing" });
    expect(summarizeCloudflareMcpRequest({}, null)).toMatchObject({
      method: "other", requestMeta: { type: "missing" }, paramsMeta: { type: "missing" },
    });
    const arbitrary = summarizeCloudflareMcpRequest({}, {
      method: "secret-string-should-never-appear",
      params: { _meta: { unusual: "x".repeat(2500), command: "secret-command" } },
    }) as any;
    expect(arbitrary.method).toBe("other");
    expect(arbitrary.unknownMethod).toMatchObject({ type: "string" });
    expect(arbitrary.paramsMeta.fields.unusual).toEqual({ type: "string", length: 2500 });
    expect(arbitrary.paramsMeta.fields.command).toEqual({ type: "redacted" });
    expect(JSON.stringify(arbitrary)).not.toContain("secret-string-should-never-appear");
    expect(JSON.stringify(arbitrary)).not.toContain("secret-command");
  });
});
