import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserLifecycleService,
  browserIdleTimeoutMsFromEnv,
  type BrowserStopReason,
} from "../../src/browser/browser-lifecycle.js";
import { BrowserProfileManager, type BrowserLease } from "../../src/browser/profile-manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managerAt(now: () => Date): Promise<BrowserProfileManager> {
  const home = await mkdtemp(join(tmpdir(), "browser-lifecycle-"));
  roots.push(home);
  const manager = new BrowserProfileManager({ home, now });
  await manager.initialize();
  return manager;
}

async function runningProfile(
  manager: BrowserProfileManager,
  chatId: string,
  lease: Omit<BrowserLease, "startedAt">,
) {
  const profile = await manager.ensureChatProfile(chatId);
  await manager.reservePort(profile.profileKey, { min: lease.port, max: lease.port }, lease.instanceId, async () => true);
  await manager.markRunning(profile.profileKey, lease);
  return await manager.getOwnedProfile(chatId);
}

describe("BrowserLifecycleService", () => {
  it("routes a profile idle for 30 minutes through the managed stop callback", async () => {
    let now = new Date("2026-08-30T00:00:00.000Z");
    const manager = await managerAt(() => now);
    const profile = await runningProfile(manager, "chatgpt-session:idle", {
      instanceId: "server-a",
      pid: process.pid,
      port: 18300,
    });
    const stopped: Array<{ profileKey: string; lease: BrowserLease; reason: BrowserStopReason }> = [];
    const lifecycle = new BrowserLifecycleService({
      manager,
      idleTimeoutMs: 30 * 60 * 1000,
      now: () => now,
      isPidAlive: () => true,
      isCdpReachable: async () => true,
      stopManagedBrowserProfile: async (profileKey, lease, reason) => { stopped.push({ profileKey, lease, reason }); },
    });

    now = new Date("2026-08-30T00:30:00.000Z");
    const result = await lifecycle.sweep();

    expect(result).toMatchObject({ stoppedProfileKeys: [profile.profileKey], failedProfileKeys: [] });
    expect(stopped).toEqual([{
      profileKey: profile.profileKey,
      lease: expect.objectContaining({ instanceId: "server-a", pid: process.pid, port: 18300 }),
      reason: "idle_timeout",
    }]);
  });

  it("recovers a dead and unreachable lease on startup without invoking stop", async () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const manager = await managerAt(() => now);
    const profile = await runningProfile(manager, "chatgpt-session:stale", {
      instanceId: "dead-server",
      pid: 999_999_999,
      port: 18301,
    });
    const stop = vi.fn();
    const lifecycle = new BrowserLifecycleService({
      manager,
      now: () => now,
      isPidAlive: () => false,
      isCdpReachable: async () => false,
      stopManagedBrowserProfile: stop,
    });

    const result = await lifecycle.start();
    lifecycle.stopTimer();

    expect(result.recoveredProfileKeys).toEqual([profile.profileKey]);
    expect(stop).not.toHaveBeenCalled();
    await expect(manager.getOwnedProfile("chatgpt-session:stale")).resolves.toMatchObject({ state: "idle", pid: undefined, port: undefined });
  });

  it("does not reclaim a fresh pid-zero reservation while Chrome is starting", async () => {
    let now = new Date("2026-08-30T00:00:00.000Z");
    const manager = await managerAt(() => now);
    const profile = await manager.ensureChatProfile("chatgpt-session:starting");
    await manager.reservePort(profile.profileKey, { min: 18304, max: 18304 }, "server-a", async () => true);
    const lifecycle = new BrowserLifecycleService({
      manager,
      now: () => now,
      isCdpReachable: async () => false,
      stopManagedBrowserProfile: vi.fn(),
    });

    expect((await lifecycle.sweep()).recoveredProfileKeys).toEqual([]);
    await expect(manager.getOwnedProfile("chatgpt-session:starting")).resolves.toMatchObject({ state: "running", pid: 0 });

    now = new Date("2026-08-30T00:00:31.000Z");
    expect((await lifecycle.sweep()).recoveredProfileKeys).toEqual([profile.profileKey]);
    await expect(manager.getOwnedProfile("chatgpt-session:starting")).resolves.toMatchObject({ state: "idle", pid: undefined });
  });

  it("routes interrupted checkpoints and shutdown drain through the same callback", async () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const manager = await managerAt(() => now);
    const checkpointing = await runningProfile(manager, "chatgpt-session:checkpoint", {
      instanceId: "server-a",
      pid: process.pid,
      port: 18302,
    });
    await manager.beginCheckpoint(checkpointing.profileKey, {
      instanceId: checkpointing.instanceId!,
      pid: checkpointing.pid!,
      port: checkpointing.port!,
      startedAt: checkpointing.leaseStartedAt!,
    });
    const running = await runningProfile(manager, "chatgpt-session:running", {
      instanceId: "server-a",
      pid: process.pid,
      port: 18303,
    });
    const calls: Array<{ profileKey: string; reason: BrowserStopReason }> = [];
    const lifecycle = new BrowserLifecycleService({
      manager,
      now: () => now,
      isPidAlive: () => true,
      isCdpReachable: async () => true,
      stopManagedBrowserProfile: async (profileKey, _lease, reason) => { calls.push({ profileKey, reason }); },
    });

    await lifecycle.start();
    const drained = await lifecycle.drain();

    expect(calls).toContainEqual({ profileKey: checkpointing.profileKey, reason: "startup_reconcile" });
    expect(calls).toContainEqual({ profileKey: checkpointing.profileKey, reason: "server_shutdown" });
    expect(calls).toContainEqual({ profileKey: running.profileKey, reason: "server_shutdown" });
    expect(drained.failedProfileKeys).toEqual([]);
  });

  it("retries an interrupted checkpoint during a periodic sweep", async () => {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const manager = await managerAt(() => now);
    const profile = await runningProfile(manager, "chatgpt-session:checkpoint-retry", {
      instanceId: "server-a",
      pid: process.pid,
      port: 18305,
    });
    await manager.beginCheckpoint(profile.profileKey, {
      instanceId: profile.instanceId!,
      pid: profile.pid!,
      port: profile.port!,
      startedAt: profile.leaseStartedAt!,
    });
    const stop = vi.fn().mockResolvedValue({ stopped: true });
    const lifecycle = new BrowserLifecycleService({
      manager,
      now: () => now,
      isPidAlive: () => true,
      isCdpReachable: async () => true,
      stopManagedBrowserProfile: stop,
    });

    await expect(lifecycle.sweep()).resolves.toMatchObject({ stoppedProfileKeys: [profile.profileKey] });
    expect(stop).toHaveBeenCalledWith(
      profile.profileKey,
      expect.objectContaining({ startedAt: profile.leaseStartedAt }),
      "idle_timeout",
      profile.lastUsedAt,
    );
  });

  it("reports lifecycle failure details and throttles identical periodic errors", async () => {
    let now = new Date("2026-08-30T00:00:00.000Z");
    const manager = await managerAt(() => now);
    const profile = await runningProfile(manager, "chatgpt-session:failing-stop", {
      instanceId: "server-a",
      pid: process.pid,
      port: 18306,
    });
    let tick: (() => void) | undefined;
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const stop = vi.fn().mockRejectedValue(new Error("checkpoint exploded"));
    const onError = vi.fn();
    const lifecycle = new BrowserLifecycleService({
      manager,
      idleTimeoutMs: 30 * 60 * 1000,
      now: () => now,
      isPidAlive: () => true,
      isCdpReachable: async () => true,
      stopManagedBrowserProfile: stop,
      onError,
      setIntervalFn: (callback) => { tick = callback; return timer; },
      clearIntervalFn: vi.fn(),
    });

    await lifecycle.start();
    expect(onError).not.toHaveBeenCalled();
    now = new Date("2026-08-30T00:30:00.000Z");
    tick!();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      message: expect.stringContaining(`${profile.profileKey} (idle_timeout): Error: checkpoint exploded`),
    }));

    tick!();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalledTimes(1);

    now = new Date("2026-08-30T00:45:00.000Z");
    tick!();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    lifecycle.stopTimer();
  });

  it("uses a strict configurable idle timeout without a disable fallback", () => {
    expect(browserIdleTimeoutMsFromEnv({})).toBe(30 * 60 * 1000);
    expect(browserIdleTimeoutMsFromEnv({ LOCAL_DEV_MCP_BROWSER_IDLE_TIMEOUT_MINUTES: "45" })).toBe(45 * 60 * 1000);
    expect(() => browserIdleTimeoutMsFromEnv({ LOCAL_DEV_MCP_BROWSER_IDLE_TIMEOUT_MINUTES: "0" })).toThrow(/must be greater/);
    expect(() => browserIdleTimeoutMsFromEnv({ LOCAL_DEV_MCP_BROWSER_IDLE_TIMEOUT_MINUTES: "invalid" })).toThrow(/must be greater/);
  });
});
