import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleMobileListDevices, handleMobileOpenUrl, handleMobileScreenshot, handleMobileStatus, handleMobileTap, handleMobileType } from "../../src/mcp/tools/mobile.js";

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

describe("mobile tools", () => {
  it("reports backend availability and device list shape", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleMobileStatus(ctx, "chat-a");
    const body = payload(result);

    expect(body.project_id).toBe("alpha");
    expect(body.backends).toMatchObject({
      ios_simctl: { available: expect.any(Boolean) },
      android_adb: { available: expect.any(Boolean) },
    });
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.artifact_dir).toBe("generated/local-dev-mcp/mobile");
  });

  it("lists devices without requiring any device to exist", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleMobileListDevices(ctx, "chat-a");
    const body = payload(result);

    expect(body.project_id).toBe("alpha");
    expect(Array.isArray(body.devices)).toBe(true);
  });

  it("returns a structured error when no requested device is found", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleMobileScreenshot(ctx, "chat-a", { device: "definitely-not-a-real-device-id" });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("MOBILE_DEVICE_NOT_FOUND");
  });

  it("validates mobile action inputs before resolving devices", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const invalidUrl = await handleMobileOpenUrl(ctx, "chat-a", { url: "file:///etc/passwd" });
    expect(payload(invalidUrl).error.code).toBe("INVALID_URL");

    const invalidTap = await handleMobileTap(ctx, "chat-a", { x: undefined, y: 12 });
    expect(payload(invalidTap).error.code).toBe("INVALID_COORDINATES");

    const missingText = await handleMobileType(ctx, "chat-a", {});
    expect(payload(missingText).error.code).toBe("MISSING_TEXT");
  });

});
