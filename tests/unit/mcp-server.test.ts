import { describe, expect, it, vi } from "vitest";
import {
  buildMcpRequestTooLargeError,
  closeHttpServerForShutdown,
  limitMcpToolResponse,
  isAllowedHttpHost,
  isAuthorizedOpenAiSubject,
  isObservedScheduledTaskMeta,
  isMcpDebugEnabled,
  resolveOpenAiAuthorization,
  normalizeHttpHost,
  resolveChatContextId,
  resolveRequestContextId,
  sanitizeRequestUrlForLog,
  sendStatelessMcpMethodNotAllowed,
} from "../../src/mcp/server.js";
import { buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";
import { hashOpenAiSubject } from "../../src/mcp/auth.js";

describe("resolveChatContextId", () => {
  it("uses openai/session when present", () => {
    expect(resolveChatContextId({
      "openai/session": "conv_123",
      "openai/subject": "user_456",
    })).toBe("chatgpt-session:conv_123");
  });

  it("falls back to openai/subject when session is missing", () => {
    expect(resolveChatContextId({
      "openai/session": "",
      "openai/subject": "user_456",
    })).toBe(`chatgpt-user:${hashOpenAiSubject("user_456")}`);
  });

  it("falls back to default when no app metadata is present", () => {
    expect(resolveChatContextId(undefined)).toBe("default");
    expect(resolveChatContextId({ "openai/session": "" })).toBe("default");
  });

  it("uses a stateless request context for the observed Scheduled Task metadata", () => {
    expect(resolveRequestContextId({
      "openai/locale": "ja-JP",
      "openai/userAgent": "test-agent",
      "openai/userLocation": { country: "JP" },
      timezone: "Asia/Tokyo",
    })).toBe("chatgpt-scheduled-task:stateless");
  });

  it("reads the debug env gate", () => {
    const previous = process.env.LOCAL_DEV_MCP_DEBUG;
    delete process.env.LOCAL_DEV_MCP_DEBUG;
    expect(isMcpDebugEnabled()).toBe(false);
    process.env.LOCAL_DEV_MCP_DEBUG = "1";
    expect(isMcpDebugEnabled()).toBe(true);
    process.env.LOCAL_DEV_MCP_DEBUG = "0";
    expect(isMcpDebugEnabled()).toBe(false);
    if (previous === undefined) delete process.env.LOCAL_DEV_MCP_DEBUG;
    else process.env.LOCAL_DEV_MCP_DEBUG = previous;
  });

  it("sanitizes sensitive query values before debug logging", () => {
    expect(sanitizeRequestUrlForLog("/mcp?token=value&state=x")).toBe(
      "/mcp?token=%5BREDACTED%5D&state=x"
    );
  });
});

describe("ChatGPT subject authorization", () => {
  it("allows only the configured ChatGPT subject when HTTP auth is enabled", () => {
    expect(isAuthorizedOpenAiSubject({ "openai/subject": "owner" }, "owner")).toBe(true);
    expect(isAuthorizedOpenAiSubject({ "openai/subject": "other" }, "owner")).toBe(false);
    expect(isAuthorizedOpenAiSubject(undefined, "owner")).toBe(false);
  });

  it("does not constrain local stdio contexts without a configured subject", () => {
    expect(isAuthorizedOpenAiSubject(undefined, undefined)).toBe(true);
    expect(isAuthorizedOpenAiSubject({ "openai/subject": "any" }, undefined)).toBe(true);
  });

  it("recognizes only the observed Scheduled Task metadata fingerprint", () => {
    const scheduledMeta = {
      "openai/locale": "ja-JP",
      "openai/userAgent": "test-agent",
      "openai/userLocation": { country: "JP" },
      timezone: "Asia/Tokyo",
    };
    expect(isObservedScheduledTaskMeta(scheduledMeta)).toBe(true);
    expect(isObservedScheduledTaskMeta({ ...scheduledMeta, "openai/organization": "org" })).toBe(false);
    expect(isObservedScheduledTaskMeta({ ...scheduledMeta, "openai/session": "session" })).toBe(false);
    expect(isObservedScheduledTaskMeta({ ...scheduledMeta, "openai/subject": "subject" })).toBe(false);
    expect(isObservedScheduledTaskMeta(undefined)).toBe(false);
  });

  it("allows the owner subject or the exact Scheduled Task fingerprint and rejects other anonymous requests", () => {
    const scheduledMeta = {
      "openai/locale": "ja-JP",
      "openai/userAgent": "test-agent",
      "openai/userLocation": { country: "JP" },
      timezone: "Asia/Tokyo",
    };
    expect(resolveOpenAiAuthorization({ "openai/subject": "owner" }, "owner")).toEqual({ authorized: true, basis: "owner_subject" });
    expect(resolveOpenAiAuthorization(scheduledMeta, "owner")).toEqual({ authorized: true, basis: "scheduled_task_meta" });
    expect(resolveOpenAiAuthorization({ "openai/locale": "ja-JP", timezone: "Asia/Tokyo" }, "owner")).toEqual({ authorized: false, basis: "rejected" });
    expect(resolveOpenAiAuthorization(undefined, "owner")).toEqual({ authorized: false, basis: "rejected" });
    expect(resolveOpenAiAuthorization(undefined, undefined)).toEqual({ authorized: true, basis: "tunnel_only" });
  });
});

describe("MCP transport size guards", () => {
  it("returns a JSON-RPC error for oversized HTTP request bodies", () => {
    expect(buildMcpRequestTooLargeError(10_000_000, 9_000_000)).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "MCP request body exceeds the local 9000000-byte safety limit.",
        data: { code: "MCP_REQUEST_TOO_LARGE", max_bytes: 9_000_000, content_length: 10_000_000 },
      },
      id: null,
    });
  });

  it("replaces an oversized tool result with a bounded structured error", () => {
    const limited = limitMcpToolResponse({ content: [{ type: "text", text: "x".repeat(100) }] }, 64);
    expect(limited.limited).toBe(true);
    expect(limited.attemptedResponseBytes).toBeGreaterThan(64);
    expect(JSON.parse(limited.result.content[0].text).error.code).toBe("MCP_RESPONSE_TOO_LARGE");
  });
});

describe("stateless MCP transport", () => {
  it("rejects standalone GET streams with 405 and advertises POST", () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const set = vi.fn();

    sendStatelessMcpMethodNotAllowed({ set, status } as never);

    expect(set).toHaveBeenCalledWith("Allow", "POST");
    expect(status).toHaveBeenCalledWith(405);
    expect(json).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. This stateless MCP endpoint accepts POST requests only.",
      },
      id: null,
    });
  });
});

describe("HTTP shutdown", () => {
  it("closes gracefully when active requests finish within the grace period", async () => {
    const closeIdleConnections = vi.fn();
    const closeAllConnections = vi.fn();
    const server = {
      close: vi.fn((callback: () => void) => callback()),
      closeIdleConnections,
      closeAllConnections,
    };

    await expect(closeHttpServerForShutdown(server, 5)).resolves.toBe("closed");
    expect(closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(closeAllConnections).not.toHaveBeenCalled();
  });

  it("forces active connections closed after the shutdown grace period", async () => {
    let closeCallback: (() => void) | undefined;
    const closeAllConnections = vi.fn(() => closeCallback?.());
    const server = {
      close: vi.fn((callback: () => void) => { closeCallback = callback; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections,
    };

    await expect(closeHttpServerForShutdown(server, 5)).resolves.toBe("forced");
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
  });
});

describe("Secure Tunnel HTTP host boundary", () => {
  it("normalizes loopback host headers", () => {
    expect(normalizeHttpHost("LOCALHOST:3456")).toBe("localhost");
    expect(normalizeHttpHost("http://127.0.0.1:3456/mcp")).toBe("127.0.0.1");
    expect(normalizeHttpHost("")).toBeNull();
  });

  it("accepts loopback hosts and rejects external hosts", () => {
    expect(isAllowedHttpHost("localhost:3456")).toBe(true);
    expect(isAllowedHttpHost("127.0.0.1:3456")).toBe(true);
    expect(isAllowedHttpHost("example.com")).toBe(false);
    expect(isAllowedHttpHost(undefined)).toBe(false);
  });
});

describe("tool schema snapshot", () => {
  it("publishes the Secure Tunnel-era tool surface", () => {
    const snapshot = buildToolSchemaSnapshot();
    const names = snapshot.tools.map((tool) => tool.name);
    const shellRun = snapshot.tools.find((tool) => tool.name === "shell.run");
    const workspacePatch = snapshot.tools.find((tool) => tool.name === "workspace.patch");
    const workspaceRead = snapshot.tools.find((tool) => tool.name === "workspace.read");
    const imageRead = snapshot.tools.find((tool) => tool.name === "image.read");
    const artifactLink = snapshot.tools.find((tool) => tool.name === "artifact.link");
    const artifactRead = snapshot.tools.find((tool) => tool.name === "artifact.read");
    const artifactReceive = snapshot.tools.find((tool) => tool.name === "artifact.receive");
    const mobileScreenshot = snapshot.tools.find((tool) => tool.name === "mobile.screenshot");
    const gitCommit = snapshot.tools.find((tool) => tool.name === "git.commit");
    const gitPush = snapshot.tools.find((tool) => tool.name === "git.push");

    expect(snapshot.schema_version).toBe("2026-09-26.1");
    expect(names).toContain("tool.schema");
    expect(names).toContain("git.commit");
    expect(gitCommit?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(names).toContain("git.push");
    expect(gitPush?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(names).toContain("image.read");
    expect(names).toContain("artifact.link");
    expect(names).toContain("artifact.read");
    expect(names).toContain("artifact.receive");
    expect(names).toEqual(expect.arrayContaining(["browser.tab.open", "browser.tab.use", "browser.tab.close"]));
    expect(names).not.toContain("image.show");
    expect(names).not.toContain("download.link");
    expect(names.some((name) => name.startsWith("notes."))).toBe(false);
    expect(names.some((name) => name.startsWith("private_notes."))).toBe(false);

    expect(imageRead?._meta).toBeUndefined();
    // Keep image.read on the raw MCP CallToolResult path so ChatGPT preserves
    // inline ImageContent instead of collapsing the result to structured output.
    expect(imageRead?.outputSchema).toBeUndefined();
    expect(imageRead?.description).toContain("does not create a user-visible chat attachment");
    expect(imageRead?.description).toContain("Preferred first path for model-only inspection");
    expect(imageRead?.description).toContain("Do not materialize preemptively");
    expect(imageRead?.description).toContain("IMAGE_TOO_LARGE");
    expect(imageRead?.description).toContain("preview generation is unavailable");
    expect(imageRead?.description).toContain("tunnel-safe materialization limit");
    expect(imageRead?.description).toContain("artifact.link");

    expect(artifactLink?.annotations).toMatchObject({ readOnlyHint: true });
    expect(artifactLink?.description).toContain("resource_link");
    expect(artifactLink?.description).toContain("without embedding");
    expect(artifactLink?.description).toContain("call image.read first instead of materializing preemptively");
    expect(artifactLink?.description).toContain("6 MiB");
    expect(artifactLink?.description).toContain("preview_unavailable");
    expect(artifactLink?.description).toContain("fallback");
    expect(artifactRead?.annotations).toMatchObject({ readOnlyHint: true });
    expect(artifactRead?.description).toContain("Compatibility fallback");
    expect(artifactRead?.description).toContain("Do not use this for model-only image inspection");
    expect(artifactRead?.description).toContain("call image.read directly");
    expect(artifactRead?.description).toContain("prefer artifact.link");
    expect(artifactReceive?._meta).toEqual({ "openai/fileParams": ["file"] });
    expect(artifactReceive?.annotations).toMatchObject({ readOnlyHint: false });
    expect(mobileScreenshot?.description).toContain("does not create a user-visible chat attachment");
    expect(mobileScreenshot?.description).toContain("artifact.link");

    expect(shellRun?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(shellRun?.description).toContain("Do not create repeated sleep + ps polling commands");
    expect(workspaceRead?.inputSchema).toMatchObject({
      properties: {
        project_id: { type: "string" },
        working_dir: { type: "string" },
      },
    });
    expect(workspacePatch?.inputSchema).toMatchObject({
      properties: {
        patches: {
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: expect.arrayContaining([
              expect.objectContaining({ required: ["path", "replacement"], additionalProperties: false }),
              expect.objectContaining({ required: ["path", "old_text", "new_text"], additionalProperties: false }),
              expect.objectContaining({ required: ["unified_diff"], additionalProperties: false }),
            ]),
          },
        },
      },
    });
    for (const name of ["browser.click", "browser.open", "mobile.screenshot", "mobile.tap"]) {
      expect(snapshot.tools.find((tool) => tool.name === name)?._meta).toBeUndefined();
    }
    for (const tool of snapshot.tools.filter((candidate) => candidate.name.startsWith("browser."))) {
      expect(tool.inputSchema).not.toHaveProperty("properties.session_id");
    }
    expect(snapshot.tools.find((tool) => tool.name === "browser.tab.use")?.inputSchema).toMatchObject({ required: ["target_id"] });
    expect(snapshot.tools.find((tool) => tool.name === "browser.tab.close")?.annotations).toMatchObject({ destructiveHint: true });
  });
});
