import { describe, expect, it, vi } from "vitest";
import {
  isAllowedHttpHost,
  isAuthorizedOpenAiSubject,
  isMcpDebugEnabled,
  normalizeHttpHost,
  resolveChatContextId,
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
    const workspacePatch = snapshot.tools.find((tool) => tool.name === "workspace.patch");
    const imageRead = snapshot.tools.find((tool) => tool.name === "image.read");
    const artifactLink = snapshot.tools.find((tool) => tool.name === "artifact.link");
    const artifactRead = snapshot.tools.find((tool) => tool.name === "artifact.read");
    const artifactReceive = snapshot.tools.find((tool) => tool.name === "artifact.receive");
    const mobileScreenshot = snapshot.tools.find((tool) => tool.name === "mobile.screenshot");

    expect(snapshot.schema_version).toBe("2026-09-17.1");
    expect(names).toContain("tool.schema");
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
    expect(imageRead?.outputSchema).toMatchObject({
      required: expect.arrayContaining(["project_id", "path", "returned_image_mode"]),
    });
    expect(imageRead?.outputSchema).not.toHaveProperty("properties.display_url");
    expect(imageRead?.description).toContain("does not create a user-visible chat attachment");
    expect(imageRead?.description).toContain("artifact.link");

    expect(artifactLink?.annotations).toMatchObject({ readOnlyHint: true });
    expect(artifactLink?.description).toContain("resource_link");
    expect(artifactLink?.description).toContain("without embedding");
    expect(artifactRead?.annotations).toMatchObject({ readOnlyHint: true });
    expect(artifactRead?.description).toContain("Compatibility fallback");
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
