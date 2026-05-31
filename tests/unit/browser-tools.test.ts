import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleBrowserOpen, handleBrowserStatus } from "../../src/mcp/tools/browser.js";

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
  contextStore.setCurrentProject("chat-a", project.projectId);
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
  it("reports isolated CDP browser backend status", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-browser-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleBrowserStatus(ctx, "chat-a");
    const body = payload(result);

    expect(body.project_id).toBe("alpha");
    expect(body.backend).toBe("chrome-devtools-protocol");
    expect(typeof body.chrome_available).toBe("boolean");
    expect(body.port_range).toMatchObject({ min: expect.any(Number), max: expect.any(Number) });
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.artifact_dir).toBe("generated/local-dev-mcp/browser");
  });

  it("rejects non-http browser.open URLs before invoking the browser backend", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-browser-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleBrowserOpen(ctx, "chat-a", { url: "file:///etc/passwd" });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("INVALID_URL");
  });
});
