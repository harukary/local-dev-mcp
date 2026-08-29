import { describe, expect, it, vi } from "vitest";
import {
  isAllowedHttpHost,
  isMcpDebugEnabled,
  normalizeHttpHost,
  resolveChatContextId,
  sanitizeRequestUrlForLog,
  sendStatelessMcpMethodNotAllowed,
} from "../../src/mcp/server.js";
import { buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";

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
    })).toBe("chatgpt-user:user_456");
  });

  it("falls back to default when no app metadata is present", () => {
    expect(resolveChatContextId(undefined)).toBe("default");
    expect(resolveChatContextId({ "openai/session": "" })).toBe("default");
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
    const imageRead = snapshot.tools.find((tool) => tool.name === "image.read");
    const artifactRead = snapshot.tools.find((tool) => tool.name === "artifact.read");
    const artifactReceive = snapshot.tools.find((tool) => tool.name === "artifact.receive");

    expect(snapshot.schema_version).toBe("2026-08-29.5");
    expect(names).toContain("tool.schema");
    expect(names).toContain("image.read");
    expect(names).toContain("artifact.read");
    expect(names).toContain("artifact.receive");
    expect(names).not.toContain("image.show");
    expect(names).not.toContain("download.link");

    expect(imageRead?._meta).toBeUndefined();
    expect(imageRead?.outputSchema).toMatchObject({
      required: expect.arrayContaining(["project_id", "path", "returned_image_mode"]),
    });
    expect(imageRead?.outputSchema).not.toHaveProperty("properties.display_url");

    expect(artifactRead?.annotations).toMatchObject({ readOnlyHint: true });
    expect(artifactReceive?._meta).toEqual({ "openai/fileParams": ["file"] });
    expect(artifactReceive?.annotations).toMatchObject({ readOnlyHint: false });

    expect(shellRun?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    for (const name of ["browser.click", "browser.open", "mobile.screenshot", "mobile.tap"]) {
      expect(snapshot.tools.find((tool) => tool.name === name)?._meta).toBeUndefined();
    }
    for (const tool of snapshot.tools.filter((candidate) => candidate.name.startsWith("browser."))) {
      expect(tool.inputSchema).not.toHaveProperty("properties.session_id");
    }
  });
});
