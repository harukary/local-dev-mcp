import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { validateToolInput } from "../../src/mcp/input-validation.js";
import { AgentDeviceCommandError, agentIosScreenshot, agentIosSnapshot, agentIosTap, agentIosTapTarget, agentIosWait, listAgentIosPhysicalDevices } from "../../src/mcp/tools/mobile-agent-device.js";
import { compactMobileNode, handleMobileBatch, handleMobileSnapshot, handleMobileTap, runMobileToolOperation, type MobileBatchStep } from "../../src/mcp/tools/mobile.js";

vi.mock("../../src/mcp/tools/mobile-agent-device.js", () => ({
  AgentDeviceCommandError: class extends Error {
    code?: string;
    constructor(payload: { error?: { code?: string; message?: string } }, fallback: string) {
      super(payload.error?.message ?? fallback);
      this.code = payload.error?.code;
    }
  },
  agentAndroidSnapshot: vi.fn(), agentAndroidTapTarget: vi.fn(), agentAndroidWait: vi.fn(),
  agentIosLaunchApp: vi.fn(), agentIosOpenUrl: vi.fn(), agentIosPress: vi.fn(),
  agentIosScreenshot: vi.fn(), agentIosSnapshot: vi.fn(),
  agentIosSwipe: vi.fn(), agentIosTap: vi.fn(), agentIosTapTarget: vi.fn(), agentIosType: vi.fn(),
  agentIosWait: vi.fn(), isAgentDeviceAvailable: vi.fn().mockResolvedValue(true),
  listAgentIosPhysicalDevices: vi.fn(),
}));

const DEVICE = "TEST-PHYSICAL-IOS";
let root = "";

function context() {
  root = mkdtempSync(join(tmpdir(), "local-dev-batch-"));
  const project: ProjectConfig = {
    projectId: "alpha", displayName: "Alpha", hostRoot: root, sandboxRoot: root,
    sandboxType: "host", defaultShell: "/bin/bash", defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300, networkPolicy: "ask", writePolicy: "allow",
    approvalMode: "catastrophic_only", deniedPaths: [".env", "secrets"], redactionProfile: "default",
  };
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);
  return { registry: {
    has: (id: string) => id === project.projectId,
    get: (id: string) => id === project.projectId ? project : undefined,
    getAll: () => [project],
  }, contextStore, auditLogger: { log: vi.fn().mockResolvedValue(undefined) } } as unknown as AppContext;
}

function payload(value: { structuredContent: unknown }) {
  return value.structuredContent as Record<string, any>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listAgentIosPhysicalDevices).mockResolvedValue([{ id: DEVICE, name: "Test iPhone", booted: true }]);
  vi.mocked(agentIosTap).mockResolvedValue(undefined);
  vi.mocked(agentIosTapTarget).mockResolvedValue(undefined);
  vi.mocked(agentIosSnapshot).mockResolvedValue([{ ref: "e1", type: "Button", label: "Continue", enabled: true }]);
  vi.mocked(agentIosWait).mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("compact mobile observations", () => {
  it("omits duplicate/default values while keeping refs, structure and geometry", () => {
    expect(compactMobileNode({
      ref: "e1", type: "Button", label: "Save", identifier: "Save", value: "Save",
      enabled: true, hittable: false, visibleToUser: false, selected: true, parentIndex: 2,
      rect: { x: 10, y: 20, width: 80, height: 40 }, otherMetadata: "unneeded",
    })).toEqual({
      ref: "e1", type: "Button", label: "Save", identifier: "Save",
      hittable: false, visibleToUser: false, selected: true, parentIndex: 2, rect: [10, 20, 80, 40],
    });
  });
});

describe("mobile batch", () => {
  it("validates every step before sending any action to a device", async () => {
    const ctx = context();
    const steps = [{ op: "tap", args: { x: 12, y: 24 } }, { op: "tap", args: { x: 20 } }];
    expect(validateToolInput("mobile.batch", { device: DEVICE, steps })).toBeDefined();
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps: steps as MobileBatchStep[] });
    expect(payload(result).error.code).toBe("INVALID_BATCH");
    expect(agentIosTap).not.toHaveBeenCalled();
  });

  it("returns lightweight status for ordinary taps and leaves images opt-in", async () => {
    const ctx = context();
    const result = await handleMobileTap(ctx, "chat-a", { device: DEVICE, x: 11, y: 22 });
    expect(payload(result)).toMatchObject({ action_applied: true, action_complete: true, verified: false, verification_deferred: true });
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(agentIosTap).toHaveBeenCalledOnce();
  });

  it("executes ordered steps, verifies a UI wait and avoids screenshots", async () => {
    const ctx = context();
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 11, y: 22 } },
      { op: "wait", args: { target: "Ready", timeout_ms: 1000 } },
    ];
    expect(validateToolInput("mobile.batch", { device: DEVICE, steps })).toBeUndefined();
    const result = await runMobileToolOperation(ctx, "chat-a", "mobile.batch", { device: DEVICE, steps }, () => handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps }));
    expect(payload(result)).toMatchObject({ complete: true, completed_steps: 2 });
    expect(payload(result).results[1]).toMatchObject({ op: "wait", verified: true, verification_scope: "ui_target_present" });
    expect(agentIosTap).toHaveBeenCalledOnce();
    expect(agentIosWait).toHaveBeenCalledOnce();
    expect(result.content.some((part) => part.type === "image")).toBe(false);
  });

  it("preserves completed steps and does not replay after a partial failure", async () => {
    const ctx = context();
    vi.mocked(agentIosTap).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("connection uncertain"));
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 10, y: 20 } },
      { op: "tap", args: { x: 30, y: 40 } },
      { op: "tap", args: { x: 50, y: 60 } },
    ];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ complete: false, completed_steps: 1, stopped_at: 1, stop_reason: "step_failed", replay_action: false });
    expect(agentIosTap).toHaveBeenCalledTimes(2);
    expect(payload(result).results).toHaveLength(1);
  });

  it("reports a failed postcondition as an already executed action", async () => {
    const ctx = context();
    vi.mocked(agentIosWait).mockRejectedValueOnce(new Error("not visible"));
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 10, y: 20, wait_for: { target: "Success", timeout_ms: 1000 } } },
      { op: "tap", args: { x: 30, y: 40 } },
    ];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(payload(result)).toMatchObject({ completed_steps: 0, stopped_at: 0, replay_action: false });
    expect(payload(result).failed_step).toMatchObject({ action_applied: true, retry_action: false });
    expect(agentIosTap).toHaveBeenCalledTimes(1);
  });

  it("rejects observations in the middle of a batch before any action", async () => {
    const ctx = context();
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 10, y: 20, observe: "snapshot" } },
      { op: "tap", args: { x: 30, y: 40 } },
    ];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(payload(result).error.code).toBe("INVALID_BATCH");
    expect(agentIosTap).not.toHaveBeenCalled();
  });

  it("preserves a selector failure and attaches a usable screenshot without retrying the tap", async () => {
    const ctx = context();
    vi.mocked(agentIosTapTarget).mockRejectedValueOnce(new AgentDeviceCommandError({
      error: { code: "ELEMENT_NOT_FOUND", message: "Element is absent" },
    }, "Element is absent"));
    vi.mocked(agentIosScreenshot).mockImplementation(async (_device, path) => {
      writeFileSync(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7/+VIAAAAASUVORK5CYII=", "base64"));
    });
    const result = await handleMobileBatch(ctx, "chat-a", {
      device: DEVICE, steps: [{ op: "tap_element", args: { target: "Missing" } }],
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      stopped_at: 0, replay_action: false,
      failed_step: { error: { code: "MOBILE_TAP_ELEMENT_FAILED" }, action_applied: null, retry_action: false },
    });
    expect(payload(result).failed_step.recovery.screenshot).toBeTruthy();
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(agentIosTapTarget).toHaveBeenCalledOnce();
  });

  it("allows a fresh snapshot ref for the first step but invalidates it after mutation", async () => {
    const ctx = context();
    const observed = await handleMobileSnapshot(ctx, "chat-a", { device: DEVICE });
    const id = payload(observed).snapshot_id;
    const first: MobileBatchStep[] = [{ op: "tap_element", args: { target: "@e1", snapshot_id: id } }];
    const firstResult = await runMobileToolOperation(ctx, "chat-a", "mobile.batch", { device: DEVICE, steps: first }, () => handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps: first }));
    expect(payload(firstResult).complete).toBe(true);
    expect(agentIosTapTarget).toHaveBeenCalledOnce();
    const second = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps: first });
    expect(payload(second)).toMatchObject({ complete: false, stopped_at: 0, failed_step: { error: { code: "STALE_SNAPSHOT" } } });
    expect(agentIosTapTarget).toHaveBeenCalledOnce();
  });
});
