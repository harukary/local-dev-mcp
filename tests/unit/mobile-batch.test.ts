import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { validateToolInput } from "../../src/mcp/input-validation.js";
import {
  listRoamrunctlDevices,
  roamrunctlTap,
  roamrunctlWait,
  roamrunctlPress,
  roamrunctlElements,
} from "../../src/mcp/tools/mobile-roamrunctl.js";
import {
  compactMobileNode, handleMobileBatch, handleMobileSnapshot, handleMobileTap,
  handleMobileTapElement, handleMobilePress, runMobileToolOperation, type MobileBatchStep,
} from "../../src/mcp/tools/mobile.js";

vi.mock("../../src/mcp/tools/mobile-roamrunctl.js", () => ({
  isRoamrunctlAvailable: vi.fn().mockResolvedValue(true),
  listRoamrunctlDevices: vi.fn(),
  roamrunctlTap: vi.fn(),
  roamrunctlSwipe: vi.fn(),
  roamrunctlType: vi.fn(),
  roamrunctlLaunch: vi.fn(),
  roamrunctlPress: vi.fn(),
  roamrunctlElements: vi.fn(),
  roamrunctlWait: vi.fn(),
  roamrunctlScreenshot: vi.fn(),
}));

const DEVICE = "roamrunctl:test-phone";
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
  vi.mocked(listRoamrunctlDevices).mockResolvedValue([{
    id: DEVICE, name: "test-phone", platform: "ios", type: "device",
    state: "Paired", backend: "ios_roamrunctl",
  }]);
  vi.mocked(roamrunctlTap).mockResolvedValue(undefined);
  vi.mocked(roamrunctlPress).mockResolvedValue(undefined);
  vi.mocked(roamrunctlWait).mockResolvedValue(undefined);
  vi.mocked(roamrunctlElements).mockResolvedValue(["Continue", "Settings"]);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("compact mobile observations", () => {
  it("omits duplicate/default fields while keeping refs and rectangles on supported backends", () => {
    expect(compactMobileNode({
      ref: "e1", type: "Button", label: "Save", identifier: "Save", value: "Save",
      enabled: true, hittable: false, visibleToUser: false, selected: true, parentIndex: 2,
      rect: { x: 10, y: 20, width: 80, height: 40 },
    })).toEqual({
      ref: "e1", type: "Button", label: "Save", identifier: "Save",
      hittable: false, visibleToUser: false, selected: true, parentIndex: 2,
      rect: [10, 20, 80, 40],
    });
  });
});

describe("mobile batch with a physical iPhone through roamrunctl", () => {
  it("prevalidates every step and sends nothing if the batch is malformed", async () => {
    const ctx = context();
    const steps = [{ op: "tap", args: { x: 12, y: 24 } }, { op: "tap", args: { x: 20 } }];
    expect(validateToolInput("mobile.batch", { device: DEVICE, steps })).toBeDefined();
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps: steps as MobileBatchStep[] });
    expect(payload(result).error.code).toBe("INVALID_BATCH");
    expect(roamrunctlTap).not.toHaveBeenCalled();
  });

  it("returns compact status for a tap without a screenshot by default", async () => {
    const ctx = context();
    const result = await handleMobileTap(ctx, "chat-a", { device: DEVICE, x: 11, y: 22 });
    expect(payload(result)).toMatchObject({
      action_applied: true, action_complete: true, verified: false, verification_deferred: true,
    });
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(roamrunctlTap).toHaveBeenCalledOnce();
    expect(roamrunctlTap).toHaveBeenCalledWith(DEVICE, "chat-a", 11, 22);
  });

  it("executes one known gesture followed by a text wait, without screenshots", async () => {
    const ctx = context();
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 11, y: 22 } },
      { op: "wait", args: { target: "Ready", timeout_ms: 1000 } },
    ];
    const result = await runMobileToolOperation(ctx, "chat-a", "mobile.batch", { device: DEVICE, steps }, () =>
      handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps }));
    expect(payload(result)).toMatchObject({ complete: true, completed_steps: 2 });
    expect(payload(result).results[1]).toMatchObject({ op: "wait", verified: true, verification_scope: "ui_target_present" });
    expect(roamrunctlTap).toHaveBeenCalledOnce();
    expect(roamrunctlWait).toHaveBeenCalledOnce();
  });

  it("rejects two coordinate gestures before starting either", async () => {
    const ctx = context();
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 10, y: 20 } },
      { op: "tap", args: { x: 30, y: 40 } },
    ];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(payload(result).error.code).toBe("INVALID_BATCH");
    expect(roamrunctlTap).not.toHaveBeenCalled();
  });

  it("keeps completed steps and does not replay after an uncertain later mutation", async () => {
    const ctx = context();
    vi.mocked(roamrunctlPress).mockRejectedValueOnce(new Error("uncertain transport"));
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 10, y: 20 } },
      { op: "press", args: { key: "home" } },
    ];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(payload(result)).toMatchObject({
      complete: false, completed_steps: 1, stopped_at: 1, stop_reason: "step_failed", replay_action: false,
    });
    expect(roamrunctlTap).toHaveBeenCalledOnce();
    expect(roamrunctlPress).toHaveBeenCalledOnce();
  });

  it("reports an observation failure as an already applied gesture, not a retryable tap", async () => {
    const ctx = context();
    vi.mocked(roamrunctlWait).mockRejectedValueOnce(new Error("not visible"));
    const steps: MobileBatchStep[] = [
      { op: "tap", args: { x: 10, y: 20, wait_for: { target: "Success", timeout_ms: 1000 } } },
    ];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(payload(result)).toMatchObject({
      complete: false, completed_steps: 0, stopped_at: 0, replay_action: false,
      failed_step: { action_applied: true, retry_action: false },
    });
    expect(roamrunctlTap).toHaveBeenCalledOnce();
  });

  it("rejects selector actions without pretending caption coordinates exist", async () => {
    const ctx = context();
    const steps: MobileBatchStep[] = [{ op: "tap_element", args: { target: "Settings" } }];
    const result = await handleMobileBatch(ctx, "chat-a", { device: DEVICE, steps });
    expect(payload(result).error.code).toBe("INVALID_BATCH");
    const direct = await handleMobileTapElement(ctx, "chat-a", { device: DEVICE, target: "Settings" });
    expect(payload(direct).error.code).toBe("MOBILE_TAP_ELEMENT_UNSUPPORTED");
    expect(roamrunctlTap).not.toHaveBeenCalled();
  });

  it("returns positionless captions and refuses iOS Back without a mutation", async () => {
    const ctx = context();
    const snapshot = await handleMobileSnapshot(ctx, "chat-a", { device: DEVICE });
    expect(payload(snapshot)).toMatchObject({
      positions_available: false, element_refs_available: false,
      nodes: [{ type: "Text", label: "Continue" }, { type: "Text", label: "Settings" }],
    });
    const back = await handleMobilePress(ctx, "chat-a", { device: DEVICE, key: "back" });
    expect(payload(back).error.code).toBe("MOBILE_PRESS_UNSUPPORTED");
    expect(roamrunctlPress).not.toHaveBeenCalled();
  });
});
