import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { browserResumeTabsFromTargets, browserSessionIdForContext, browserStartupTabs, browserStopRunsMaintenance, browserToolRefreshesIdleDeadline, browserToolUsesOuterOperationLock, classifyBrowserFailureReason, selectBrowserSnapshot, handleBrowserEval, handleBrowserOpen, handleBrowserStart, handleBrowserTabClose, handleBrowserTabUse, isGoogleAuthInteractionRequiredUrl } from "../../src/mcp/tools/browser.js";
import { buildBrowserToolDefinitions } from "../../src/mcp/browser-tool-definitions.js";

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
  it("exposes one accessible snapshot reader and removes redundant browser discovery tools", () => {
    const definitions = buildBrowserToolDefinitions();
    const names = definitions.map(definition => definition.name);
    expect(names).toHaveLength(20);
    expect(names).toContain("browser.snapshot");
    expect(names).not.toContain("browser.sessions");
    expect(names).not.toContain("browser.selectors");
    const snapshot = definitions.find(definition => definition.name === "browser.snapshot");
    expect(snapshot?.annotations.readOnlyHint).toBe(true);
    expect(snapshot?.inputSchema.properties).toHaveProperty("query");
    expect(snapshot?.inputSchema.properties).toHaveProperty("offset");
    const evaluation = definitions.find(definition => definition.name === "browser.eval");
    expect(evaluation?.inputSchema.required).toContain("unsafe");
  });

  it("finds controls beyond the first snapshot page and supports continuing from next_offset", () => {
    const source = Array.from({ length: 300 }, (_, index) => `- button "Row ${String(index).padStart(3, "0")}"`).join("\n") + "\n- button \"Find Me\"";
    const first = selectBrowserSnapshot(source, { maxBytes: 80 });
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBeGreaterThan(0);
    expect(first.snapshot).not.toContain("Find Me");
    const found = selectBrowserSnapshot(source, { query: "find me", maxBytes: 80 });
    expect(found.snapshot).toContain("Find Me");
    expect(found.total_lines).toBe(1);
    expect(found.next_offset).toBeNull();
    const second = selectBrowserSnapshot(source, { offset: first.next_offset!, maxBytes: 80 });
    expect(second.offset).toBe(first.next_offset);
    expect(second.snapshot.startsWith("- button \"Row")).toBe(true);
    let offset = 0;
    const parts: string[] = [];
    do {
      const page = selectBrowserSnapshot(source, { offset, maxBytes: 80 });
      parts.push(page.snapshot);
      if (page.next_offset === null) break;
      offset = page.next_offset;
    } while (true);
    expect(parts.join("\n")).toBe(source);
  });

  it("requires explicit unsafe acknowledgement before evaluating page JavaScript", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-browser-"));
    const ctx = createContext(createProject(tmpRoot));
    const result = await handleBrowserEval(ctx, CHAT_ID, { expression: "document.title" });
    expect(payload(result).error.code).toBe("UNSAFE_CONFIRMATION_REQUIRED");
  });

  it("does not hold the outer profile operation lock across browser.stop maintenance", () => {
    expect(browserToolUsesOuterOperationLock("browser.stop")).toBe(false);
    expect(browserToolUsesOuterOperationLock("browser.start")).toBe(true);
    expect(browserToolUsesOuterOperationLock("browser.open")).toBe(true);
  });

  it("refreshes the idle deadline for live browser work but not status polling or stop", () => {
    expect(browserToolRefreshesIdleDeadline("browser.open")).toBe(true);
    expect(browserToolRefreshesIdleDeadline("browser.wait")).toBe(true);
    expect(browserToolRefreshesIdleDeadline("browser.status")).toBe(false);
    expect(browserToolRefreshesIdleDeadline("browser.stop")).toBe(false);
  });

  it("captures resumable tabs and restores the selected tab deterministically", () => {
    const captured = browserResumeTabsFromTargets([
      { id: "first", type: "page", url: "https://example.com/first" },
      { id: "internal", type: "page", url: "chrome://settings" },
      { id: "active", type: "page", url: "https://example.com/active" },
      { id: "worker", type: "service_worker", url: "https://example.com/worker.js" },
    ], "active");

    expect(captured).toEqual([
      { url: "https://example.com/first", active: false },
      { url: "https://example.com/active", active: true },
    ]);
    expect(browserStartupTabs(captured)).toEqual(captured);
    expect(browserStartupTabs(captured, "https://example.com/replacement")).toEqual([
      { url: "https://example.com/first", active: false },
      { url: "https://example.com/replacement", active: true },
    ]);
    expect(browserStartupTabs([])).toEqual([{ url: "about:blank", active: true }]);
  });

  it("recognizes the exact Google account interstitial without broad host matching", () => {
    expect(isGoogleAuthInteractionRequiredUrl("https://www.google.com/account/about/?hl=en-US")).toBe(true);
    expect(isGoogleAuthInteractionRequiredUrl("https://google.com/account/about")).toBe(true);
    expect(isGoogleAuthInteractionRequiredUrl("https://myaccount.google.com/")).toBe(false);
    expect(isGoogleAuthInteractionRequiredUrl("https://www.google.com/search?q=account")).toBe(false);
  });

  it("defers expensive profile maintenance only during service shutdown", () => {
    expect(browserStopRunsMaintenance("server_shutdown")).toBe(false);
    expect(browserStopRunsMaintenance("explicit_stop")).toBe(true);
    expect(browserStopRunsMaintenance("idle_timeout")).toBe(true);
    expect(browserStopRunsMaintenance("startup_reconcile")).toBe(true);
  });

  it("classifies common browser action failures for recovery", () => {
    expect(classifyBrowserFailureReason(new Error("locator.click: Timeout 15000ms exceeded."))).toBe("timeout");
    expect(classifyBrowserFailureReason(new Error("strict mode violation: locator resolved to 2 elements"))).toBe("selector_ambiguous");
    expect(classifyBrowserFailureReason(new Error("element intercepts pointer events"))).toBe("pointer_intercepted");
    expect(classifyBrowserFailureReason(new Error("Selected browser target no longer exists"))).toBe("target_closed");
  });

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
