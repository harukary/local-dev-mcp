import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleMobileLaunchApp, handleMobileListDevices, handleMobileOpenUrl, handleMobilePress, handleMobileRestartApp, handleMobileScreenshot, handleMobileStatus, handleMobileStopApp, handleMobileSwipe, handleMobileTap, handleMobileTapElement, handleMobileType, handleMobileWait, parseAndroidCurrentApp } from "../../src/mcp/tools/mobile.js";

let tmpRoot = "";
let cliRoot = "";
const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  const keys = ["LOCAL_DEV_MCP_AGENT_DEVICE_BIN", "LOCAL_DEV_MCP_ROAMRUNCTL_BIN", "ANDROID_HOME", "ANDROID_SDK_ROOT", "PATH"];
  for (const key of keys) previousEnv.set(key, process.env[key]);

  // Unit tests must not enumerate the host's real simulators or paired devices.
  cliRoot = mkdtempSync(join(tmpdir(), "local-dev-mobile-clis-"));
  mkdirSync(join(cliRoot, "platform-tools"));
  writeFileSync(join(cliRoot, "xcrun"), "#!/bin/sh\nprintf '{\"devices\":{}}\\n'\n", { mode: 0o755 });
  const adb = "#!/bin/sh\nprintf 'List of devices attached\\n\\n'\n";
  writeFileSync(join(cliRoot, "adb"), adb, { mode: 0o755 });
  writeFileSync(join(cliRoot, "platform-tools", "adb"), adb, { mode: 0o755 });
  writeFileSync(join(cliRoot, "roamrunctl"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo test; fi\n", { mode: 0o755 });
  process.env.PATH = cliRoot + ":" + (previousEnv.get("PATH") ?? "");
  process.env.ANDROID_HOME = cliRoot;
  process.env.ANDROID_SDK_ROOT = cliRoot;
  process.env.LOCAL_DEV_MCP_ROAMRUNCTL_BIN = join(cliRoot, "roamrunctl");
  process.env.LOCAL_DEV_MCP_AGENT_DEVICE_BIN = join(cliRoot, "missing-agent-device");
});

afterEach(() => {
  for (const [key, previous] of previousEnv) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  previousEnv.clear();
  if (tmpRoot) { rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = ""; }
  if (cliRoot) { rmSync(cliRoot, { recursive: true, force: true }); cliRoot = ""; }
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

function payload(result: { structuredContent?: unknown; content: Array<{ text?: string }> }) {
  // Text fallbacks may truncate large device lists; inspect structuredContent.
  return (result.structuredContent ?? JSON.parse(result.content[0].text ?? "{}")) as Record<string, any>;
}

describe("mobile tools", () => {
  it("parses Android foreground activities from dumpsys variants", () => {
    expect(parseAndroidCurrentApp("mCurrentFocus=Window{abc u0 dev.example.app/dev.example.app.MainActivity}")).toEqual({
      package_name: "dev.example.app",
      activity: "dev.example.app.MainActivity",
    });
    expect(parseAndroidCurrentApp("mResumedActivity: ActivityRecord{abc u0 com.example/.HomeActivity t42}")).toEqual({
      package_name: "com.example",
      activity: ".HomeActivity",
    });
    expect(parseAndroidCurrentApp("nothing useful")).toBeNull();
  });

  it("reports backend availability and device list shape", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleMobileStatus(ctx, "chat-a");
    const body = payload(result);

    expect(body.project_id).toBe("alpha");
    expect(result.structuredContent).toEqual(body);
    expect(body.backends).toMatchObject({
      ios_simctl: { available: expect.any(Boolean) },
      ios_physical_roamrunctl: { available: expect.any(Boolean) },
      ios_simulator_agent_device: { available: expect.any(Boolean) },
      android_adb: { available: expect.any(Boolean) },
      android_agent_device: { available: expect.any(Boolean) },
    });
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.artifact_dir).toBe("generated/local-dev-mcp/mobile");
  }, 20_000);

  it("lists devices without requiring any device to exist", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleMobileListDevices(ctx, "chat-a");
    const body = payload(result);

    expect(body.project_id).toBe("alpha");
    expect(result.structuredContent).toEqual(body);
    expect(Array.isArray(body.devices)).toBe(true);
  }, 20_000);

  it("returns a structured error when no requested device is found", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleMobileScreenshot(ctx, "chat-a", { device: "definitely-not-a-real-device-id" });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("MOBILE_DEVICE_NOT_FOUND");
  }, 20_000);

  it("validates mobile action inputs before resolving devices", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-mobile-"));
    const ctx = createContext(createProject(tmpRoot));

    const invalidUrl = await handleMobileOpenUrl(ctx, "chat-a", { url: "file:///etc/passwd" });
    expect(payload(invalidUrl).error.code).toBe("INVALID_URL");

    const invalidTap = await handleMobileTap(ctx, "chat-a", { x: undefined, y: 12 });
    expect(payload(invalidTap).error.code).toBe("INVALID_COORDINATES");

    const missingText = await handleMobileType(ctx, "chat-a", {});
    expect(payload(missingText).error.code).toBe("MISSING_TEXT");

    const missingElement = await handleMobileTapElement(ctx, "chat-a", {});
    expect(payload(missingElement).error.code).toBe("MISSING_TARGET");

    const missingApp = await handleMobileLaunchApp(ctx, "chat-a", {});
    expect(payload(missingApp).error.code).toBe("MISSING_APP");

    const missingStopApp = await handleMobileStopApp(ctx, "chat-a", {});
    expect(payload(missingStopApp).error.code).toBe("MISSING_APP");

    const missingRestartApp = await handleMobileRestartApp(ctx, "chat-a", {});
    expect(payload(missingRestartApp).error.code).toBe("MISSING_APP");

    const invalidSwipe = await handleMobileSwipe(ctx, "chat-a", { x1: 1, y1: 2, x2: undefined, y2: 4 });
    expect(payload(invalidSwipe).error.code).toBe("INVALID_COORDINATES");

    const invalidPress = await handleMobilePress(ctx, "chat-a", { key: undefined });
    expect(payload(invalidPress).error.code).toBe("INVALID_KEY");

    const missingWaitTarget = await handleMobileWait(ctx, "chat-a", {});
    expect(payload(missingWaitTarget).error.code).toBe("MISSING_TARGET");
  });
});
