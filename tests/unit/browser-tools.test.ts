import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { browserSessionIdForContext, handleBrowserOpen, handleBrowserStart, handleBrowserTabClose, handleBrowserTabUse } from "../../src/mcp/tools/browser.js";

const CHAT_ID = "chatgpt-session:chat-a";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function createProject(hostRoot: string): ProjectConfig {
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths: [".env", ".env.*", "secrets"],
    redactionProfile: "default",
  };
}

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject(CHAT_ID, project.projectId);
  return {
    registry: {
      has: (projectId: string) => projectId === project.projectId,
      get: (projectId: string) => (projectId === project.projectId ? project : undefined),
      getAll: () => [project],
    },
    contextStore,
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("browser tools", () => {
  it("derives one stable profile per conversation independent of project", () => {
    const first = browserSessionIdForContext("chatgpt-session:conv_123", "alpha");

    expect(browserSessionIdForContext("chatgpt-session:conv_123", "alpha")).toBe(first);
    expect(browserSessionIdForContext("chatgpt-session:conv_456", "alpha")).not.toBe(first);
    expect(browserSessionIdForContext("chatgpt-session:conv_123", "beta")).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects the removed explicit session API before browser startup", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-browser-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleBrowserStart(ctx, CHAT_ID, { session_id: "other-profile" });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("BROWSER_EXPLICIT_SESSION_UNSUPPORTED");
  });

  it("rejects non-http browser.open URLs before invoking the browser backend", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-browser-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleBrowserOpen(ctx, CHAT_ID, { url: "file:///etc/passwd" });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("INVALID_URL");
  });

  it("requires an explicit target id for tab selection and close", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-browser-"));
    const ctx = createContext(createProject(tmpRoot));

    expect(payload(await handleBrowserTabUse(ctx, CHAT_ID)).error.code).toBe("MISSING_TARGET_ID");
    expect(payload(await handleBrowserTabClose(ctx, CHAT_ID)).error.code).toBe("MISSING_TARGET_ID");
  });
});
