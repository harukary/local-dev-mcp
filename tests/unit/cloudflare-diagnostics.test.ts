import { describe, expect, it } from "vitest";
import { summarizeCloudflareMcpRequest } from "../../src/mcp/cloudflare-diagnostics.js";

describe("Cloudflare MCP metadata diagnostics", () => {
  it("shows header names and metadata shapes without leaking values or tool arguments", () => {
    const headers = {
      "cf-access-jwt-assertion": "secret-jwt-value",
      authorization: "Bearer secret-bearer",
      cookie: "session=secret-cookie",
      "mcp-session-id": "session-123",
      "x-request-id": "request-abc",
      "x-anthropic-conversation-id": "conversation-xyz",
      "user-agent": "private-agent",
    };
    const request = {
      jsonrpc: "2.0", id: "client-secret",
      method: "tools/call",
      params: {
        name: "shell.run",
        arguments: { command: "echo highly-private-command" },
        _meta: {
          "claude/session": "private-session-abc",
          counter: 42,
          context: { conversation: "private-message" },
          messages: ["private-message"],
        },
      },
      _meta: { "client/request": "private-top-level-id" },
    };
    const result = summarizeCloudflareMcpRequest(headers, request) as any;
    const serialized = JSON.stringify(result);

    expect(result.source).toBe("cloudflare_access");
    expect(result.method).toBe("tools/call");
    expect(result.headers).toContain("cf-access-jwt-assertion");
    expect(result.headerCount).toBe(7);
    expect(result.headers).toContain("authorization");
    expect(result.headers).toContain("cookie");
    expect(result.identifierHeaders["mcp-session-id"]).toMatchObject({ type: "string", length: 11 });
    expect(result.identifierHeaders["x-anthropic-conversation-id"].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(result.identifierHeaders).not.toHaveProperty("cf-access-jwt-assertion");
    expect(result.identifierHeaders).not.toHaveProperty("authorization");
    expect(result.paramsMeta.fields["claude/session"]).toMatchObject({ type: "string", length: 19 });
    expect(result.paramsMeta.fields.counter).toEqual({ type: "number" });
    expect(result.paramsMeta.fields.context).toEqual({ type: "object", keys: ["conversation"] });
    expect(result.paramsMeta.fields.messages).toEqual({ type: "array", length: 1 });
    expect(result.requestMeta.fields["client/request"].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    for (const secret of [
      "secret-jwt-value", "secret-bearer", "secret-cookie", "session-123",
      "request-abc", "conversation-xyz", "private-agent", "private-session-abc",
      "highly-private-command", "private-message", "client-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("correlates repeated scalar identifiers without persisting a key or raw value", () => {
    const request = { method: "tools/call", params: { _meta: { sessionId: "fixed-session" } } };
    const first = summarizeCloudflareMcpRequest({ "x-session-id": "fixed-session" }, request) as any;
    const second = summarizeCloudflareMcpRequest({ "x-session-id": "fixed-session" }, request) as any;
    const changed = summarizeCloudflareMcpRequest({ "x-session-id": "other-session" }, request) as any;

    expect(first.identifierHeaders["x-session-id"].fingerprint)
      .toBe(second.identifierHeaders["x-session-id"].fingerprint);
    expect(first.identifierHeaders["x-session-id"].fingerprint)
      .not.toBe(changed.identifierHeaders["x-session-id"].fingerprint);
    expect(first.paramsMeta.fields.sessionId.fingerprint)
      .toBe(first.identifierHeaders["x-session-id"].fingerprint);
    const large = summarizeCloudflareMcpRequest({ "mcp-session-id": "x".repeat(1200) }, request) as any;
    expect(large.identifierHeaders["mcp-session-id"]).toEqual({ type: "string", length: 1200 });
  });

  it("reports initialize client info as hashed shapes and tolerates missing or malformed metadata", () => {
    const result = summarizeCloudflareMcpRequest({}, {
      method: "initialize",
      params: {
        clientInfo: { name: "claude.ai", version: "2026.11" },
        protocolVersion: "2025-03-26",
      },
    }) as any;
    expect(result.method).toBe("initialize");
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(result.clientInfo.name).toMatchObject({ type: "string", length: 9 });
    expect(JSON.stringify(result)).not.toContain("claude.ai");
    expect(result.paramsMeta).toEqual({ type: "missing" });

    expect(summarizeCloudflareMcpRequest({}, null)).toMatchObject({
      method: "other", requestMeta: { type: "missing" }, paramsMeta: { type: "missing" },
    });
    const arbitrary = summarizeCloudflareMcpRequest({}, {
      method: "secret-string-should-never-appear",
      params: { _meta: { unusual: "x".repeat(2000) } },
    }) as any;
    expect(arbitrary.method).toBe("other");
    expect(arbitrary.paramsMeta.fields.unusual).toEqual({ type: "string", length: 2000 });
  });
});
