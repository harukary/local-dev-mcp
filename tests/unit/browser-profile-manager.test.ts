import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserProfileManager,
  browserProfileKey,
  type AuthClaimInput,
} from "../../src/browser/profile-manager.js";
import { copyChromeProfileSnapshot } from "../../src/browser/snapshot-copier.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function seedChromeProfile(root: string): Promise<void> {
  await mkdir(join(root, "Default", "Network"), { recursive: true });
  await mkdir(join(root, "Default", "IndexedDB"), { recursive: true });
  await mkdir(join(root, "Default", "Cache"), { recursive: true });
  await mkdir(join(root, "component_crx_cache"), { recursive: true });
  await writeFile(join(root, "Local State"), "local-state");
  await writeFile(join(root, "Default", "Network", "Cookies"), "cookies");
  await writeFile(join(root, "Default", "IndexedDB", "state"), "indexed-db");
  await writeFile(join(root, "Default", "Cache", "large-cache"), Buffer.alloc(4096));
  await writeFile(join(root, "component_crx_cache", "component"), Buffer.alloc(4096));
}

describe("Chrome profile snapshot copier", () => {
  it("preserves login state while excluding caches and root components", async () => {
    const source = await tempRoot("browser-snapshot-source-");
    const destination = await tempRoot("browser-snapshot-destination-");
    await seedChromeProfile(source);

    const result = await copyChromeProfileSnapshot(source, destination, {
      copyFileImpl: async (from, to) => {
        await import("node:fs/promises").then(({ copyFile }) => copyFile(from, to));
        return "copy";
      },
    });

    expect(await readFile(join(destination, "Local State"), "utf8")).toBe("local-state");
    expect(await readFile(join(destination, "Default", "Network", "Cookies"), "utf8")).toBe("cookies");
    expect(await readFile(join(destination, "Default", "IndexedDB", "state"), "utf8")).toBe("indexed-db");
    await expect(stat(join(destination, "Default", "Cache"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(destination, "component_crx_cache"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toMatchObject({ copyMode: "copy", fileCount: 3, copiedBytes: 28 });
    expect(result.excludedBytes).toBe(8192);
  });

  it("reports reflink mode and falls back only for unsupported clone errors", async () => {
    const source = await tempRoot("browser-reflink-source-");
    const destination = await tempRoot("browser-reflink-destination-");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(join(source, "Local State"), "state");
    await writeFile(join(source, "Default", "Cookies"), "cookie");
    const copyFile = vi.fn(async (from: string, to: string, mode?: number) => {
      if (mode === constants.COPYFILE_FICLONE_FORCE && from.endsWith("Cookies")) {
        throw Object.assign(new Error("clone unsupported"), { code: "ENOTSUP" });
      }
      await import("node:fs/promises").then((fs) => fs.copyFile(from, to));
    });

    const result = await copyChromeProfileSnapshot(source, destination, { rawCopyFile: copyFile });

    expect(result.copyMode).toBe("copy");
    expect(copyFile).toHaveBeenCalledWith(expect.stringMatching(/Local State$/), expect.any(String), constants.COPYFILE_FICLONE_FORCE);
    expect(copyFile).toHaveBeenCalledWith(expect.stringMatching(/Cookies$/), expect.any(String), undefined);
  });

  it("does not silently fall back for a permission error", async () => {
    const source = await tempRoot("browser-reflink-error-source-");
    const destination = await tempRoot("browser-reflink-error-destination-");
    await mkdir(join(source, "Default"), { recursive: true });
    await writeFile(join(source, "Local State"), "state");
    const copyFile = vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });

    await expect(copyChromeProfileSnapshot(source, destination, { rawCopyFile: copyFile })).rejects.toMatchObject({ code: "EPERM" });
    expect(copyFile).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserProfileManager", () => {
  const claims = (ids: string[]): AuthClaimInput[] => ids.map((probeId) => ({
    probeId,
    probeVersion: 1,
    status: "authenticated",
    principal: `${probeId}-account`,
    verifiedAt: "2026-08-29T00:00:00.000Z",
    validUntil: "2026-08-31T00:00:00.000Z",
  }));

  it("creates distinct chat-owned profiles from an immutable golden generation", async () => {
    const home = await tempRoot("browser-manager-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    const manager = new BrowserProfileManager({ home, now: () => new Date("2026-08-29T00:00:00.000Z") });
    await manager.initialize(seed, { seedState: "quiescent" });

    const first = await manager.ensureChatProfile("chatgpt-session:first");
    const second = await manager.ensureChatProfile("chatgpt-session:second");

    expect(first.profileKey).toBe(browserProfileKey("chatgpt-session:first"));
    expect(second.profileKey).not.toBe(first.profileKey);
    expect(first.baseGeneration).toBe(second.baseGeneration);
    expect(first.snapshotVerification).toBe("structural_only");
    expect(first.userDataDir).not.toBe(second.userDataDir);
    await expect(manager.getOwnedProfile("chatgpt-session:second", first.profileKey)).rejects.toMatchObject({ code: "BROWSER_PROFILE_NOT_OWNED" });
  });

  it("does not create profile storage for an optional read", async () => {
    const root = await tempRoot("browser-optional-");
    const home = join(root, "not-created");
    const manager = new BrowserProfileManager({ home });

    await expect(manager.getOptionalOwnedProfile("chatgpt-session:missing")).resolves.toBeUndefined();
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.getOptionalOwnedProfile("chatgpt-user:subject")).rejects.toMatchObject({ code: "BROWSER_CHAT_ID_UNAVAILABLE" });
  });

  it("requires an explicitly verified quiescent legacy seed", async () => {
    const home = await tempRoot("browser-migration-guard-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    const manager = new BrowserProfileManager({ home });

    await expect(manager.initialize(seed)).rejects.toMatchObject({ code: "BROWSER_PROFILE_MIGRATION_STATE_UNKNOWN" });
    await expect(manager.initialize(seed, { seedState: "quiescent", revalidateSeed: async () => false }))
      .rejects.toMatchObject({ code: "BROWSER_PROFILE_MIGRATION_REQUIRES_STOP" });
  });

  it("does not reclaim an old lock while its owner pid is alive", async () => {
    const home = await tempRoot("browser-lock-");
    const manager = new BrowserProfileManager({ home, lockTimeoutMs: 50, lockStaleMs: 1 });
    await manager.initialize();
    const key = browserProfileKey("chatgpt-session:locked");
    const lock = join(home, "locks", `profile-${key}.lock`);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);

    await expect(manager.ensureChatProfile("chatgpt-session:locked")).rejects.toMatchObject({ code: "BROWSER_PROFILE_BUSY" });
    expect((await stat(lock)).isDirectory()).toBe(true);
  });

  it("promotes only a dominating verified auth claim set", async () => {
    const home = await tempRoot("browser-promotion-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    const manager = new BrowserProfileManager({ home, now: () => new Date("2026-08-29T01:00:00.000Z") });
    await manager.initialize(seed, { seedState: "quiescent" });
    const profile = await manager.ensureChatProfile("chatgpt-session:first");

    await manager.recordAuthClaims(profile.profileKey, claims(["github", "google"]));
    const promoted = await manager.promoteIfDominant(profile.profileKey, async () => true);
    const state = await manager.statusForChat("chatgpt-session:first");

    expect(promoted.promoted).toBe(true);
    expect(promoted.generationId).not.toBe(profile.baseGeneration);
    expect(state.authenticatedProbeIds).toEqual(["github", "google"]);

    const weaker = await manager.ensureChatProfile("chatgpt-session:weaker");
    await manager.recordAuthClaims(weaker.profileKey, claims(["github"]));
    await expect(manager.promoteIfDominant(weaker.profileKey, async () => true)).resolves.toMatchObject({ promoted: false, reason: "candidate_does_not_dominate" });
  });

  it("rejects a stale promotion candidate if the browser restarts during validation", async () => {
    const home = await tempRoot("browser-promotion-race-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    const manager = new BrowserProfileManager({ home, now: () => new Date("2026-08-29T01:00:00.000Z") });
    await manager.initialize(seed, { seedState: "quiescent" });
    const profile = await manager.ensureChatProfile("chatgpt-session:promotion-race");
    await manager.recordAuthClaims(profile.profileKey, claims(["github", "google"]));

    const promotion = manager.promoteIfDominant(profile.profileKey, async () => {
      await manager.reservePort(
        profile.profileKey,
        { min: 18350, max: 18350 },
        "replacement-server",
        async () => true,
      );
      return true;
    });

    await expect(promotion).resolves.toMatchObject({
      promoted: false,
      reason: "candidate_changed_during_checkpoint",
    });
    expect((await manager.getOwnedProfile("chatgpt-session:promotion-race")).state).toBe("running");
  });

  it("blocks a new lease while the current browser is checkpointing", async () => {
    const home = await tempRoot("browser-checkpoint-");
    const manager = new BrowserProfileManager({ home });
    await manager.initialize();
    const profile = await manager.ensureChatProfile("chatgpt-session:checkpoint");
    const lease = { instanceId: "test", pid: process.pid, port: 18300 };
    await manager.reservePort(profile.profileKey, { min: 18300, max: 18300 }, lease.instanceId, async () => true);
    await manager.markRunning(profile.profileKey, lease);
    const running = await manager.getOwnedProfile("chatgpt-session:checkpoint");
    const fullLease = { ...lease, startedAt: running.leaseStartedAt! };
    await manager.beginCheckpoint(profile.profileKey, fullLease);

    await expect(manager.reservePort(profile.profileKey, { min: 18301, max: 18301 }, "second", async () => true))
      .rejects.toMatchObject({ code: "BROWSER_PROFILE_BUSY" });
    await manager.finishCheckpoint(profile.profileKey, fullLease, [], [
      { url: "https://example.com/first", active: false },
      { url: "https://example.com/active", active: true },
    ]);
    await expect(manager.getOwnedProfile("chatgpt-session:checkpoint")).resolves.toMatchObject({ state: "idle", port: undefined });
    await expect(manager.getResumeState(profile.profileKey)).resolves.toMatchObject({
      tabs: [
        { url: "https://example.com/first", active: false },
        { url: "https://example.com/active", active: true },
      ],
    });
  });

  it("does not checkpoint an idle candidate after a newer browser operation", async () => {
    const home = await tempRoot("browser-checkpoint-activity-");
    let now = new Date("2026-08-30T00:00:00.000Z");
    const manager = new BrowserProfileManager({ home, now: () => now });
    await manager.initialize();
    const profile = await manager.ensureChatProfile("chatgpt-session:active-again");
    const lease = { instanceId: "test", pid: process.pid, port: 18300 };
    await manager.reservePort(profile.profileKey, { min: 18300, max: 18300 }, lease.instanceId, async () => true);
    await manager.markRunning(profile.profileKey, lease);
    const idleCandidate = await manager.getOwnedProfile("chatgpt-session:active-again");
    const fullLease = { ...lease, startedAt: idleCandidate.leaseStartedAt! };
    now = new Date("2026-08-30T00:31:00.000Z");
    await manager.touch(profile.profileKey);

    await expect(manager.beginCheckpoint(profile.profileKey, fullLease, idleCandidate.lastUsedAt)).resolves.toBe(false);
    await expect(manager.getOwnedProfile("chatgpt-session:active-again")).resolves.toMatchObject({ state: "running" });
  });

  it("rejects a stale lease even when its instance, PID, and port were reused", async () => {
    const home = await tempRoot("browser-checkpoint-lease-aba-");
    const manager = new BrowserProfileManager({ home });
    await manager.initialize();
    const profile = await manager.ensureChatProfile("chatgpt-session:lease-aba");
    const lease = { instanceId: "test", pid: process.pid, port: 18300 };
    await manager.reservePort(profile.profileKey, { min: 18300, max: 18300 }, lease.instanceId, async () => true);
    await manager.markRunning(profile.profileKey, lease);

    await expect(manager.beginCheckpoint(profile.profileKey, {
      ...lease,
      startedAt: "2026-08-29T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "BROWSER_PROFILE_BUSY" });
    await expect(manager.getOwnedProfile("chatgpt-session:lease-aba")).resolves.toMatchObject({ state: "running" });
  });

  it("requires snapshot validation when supplied and refreshes claims after six hours", async () => {
    const home = await tempRoot("browser-refresh-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    let now = new Date("2026-08-29T00:00:00.000Z");
    const manager = new BrowserProfileManager({ home, now: () => now });
    await manager.initialize(seed, { seedState: "quiescent" });
    const first = await manager.ensureChatProfile("chatgpt-session:first");
    await manager.recordAuthClaims(first.profileKey, claims(["google"]));

    await expect(manager.promoteIfDominant(first.profileKey, async () => false)).resolves.toEqual({
      promoted: false,
      reason: "snapshot_validation_failed",
    });
    await expect(manager.promoteIfDominant(first.profileKey, async () => true)).resolves.toMatchObject({
      promoted: true,
      snapshotVerification: "live_auth_reprobe",
    });

    now = new Date("2026-08-29T07:00:00.000Z");
    const refresh = await manager.ensureChatProfile("chatgpt-session:refresh");
    expect(refresh.snapshotVerification).toBe("live_auth_reprobe");
    const refreshedClaims = claims(["google"]).map((claim) => ({
      ...claim,
      verifiedAt: now.toISOString(),
      validUntil: "2026-08-31T07:00:00.000Z",
    }));
    await manager.recordAuthClaims(refresh.profileKey, refreshedClaims);
    await expect(manager.promoteIfDominant(refresh.profileKey, async () => true)).resolves.toMatchObject({ promoted: true });

    const generations = await readdir(join(home, "golden", "generations"));
    expect(generations).toHaveLength(2);
  });

  it("garbage-collects only unlocked idle profiles after 72 hours", async () => {
    const home = await tempRoot("browser-gc-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    let now = new Date("2026-08-29T00:00:00.000Z");
    const manager = new BrowserProfileManager({ home, now: () => now });
    await manager.initialize(seed, { seedState: "quiescent" });
    const stale = await manager.ensureChatProfile("chatgpt-session:stale");
    const running = await manager.ensureChatProfile("chatgpt-session:running");
    await manager.reservePort(running.profileKey, { min: 18300, max: 18300 }, "test", async () => true);
    await manager.markRunning(running.profileKey, { instanceId: "test", pid: process.pid, port: 18300 });
    now = new Date("2026-08-30T00:00:01.000Z");

    await expect(manager.collectGarbage()).resolves.toMatchObject({ deletedProfileKeys: [] });
    now = new Date("2026-09-01T00:00:01.000Z");

    const result = await manager.collectGarbage();

    expect(result.deletedProfileKeys).toEqual([stale.profileKey]);
    await expect(stat(stale.userDataDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(running.userDataDir)).isDirectory()).toBe(true);
  });

  it("enforces the idle profile count quota using least-recently-used order", async () => {
    const home = await tempRoot("browser-quota-");
    let now = new Date("2026-08-29T00:00:00.000Z");
    const manager = new BrowserProfileManager({
      home,
      now: () => now,
      maxProfiles: 2,
      maxProfileBytes: Number.MAX_SAFE_INTEGER,
    });
    await manager.initialize();
    const oldest = await manager.ensureChatProfile("chatgpt-session:oldest");
    now = new Date("2026-08-29T00:01:00.000Z");
    const middle = await manager.ensureChatProfile("chatgpt-session:middle");
    now = new Date("2026-08-29T00:02:00.000Z");
    const newest = await manager.ensureChatProfile("chatgpt-session:newest");
    now = new Date("2026-08-29T00:32:00.000Z");

    await expect(manager.collectGarbage()).resolves.toMatchObject({
      deletedProfileKeys: [],
      remainingProfileCount: 3,
      limitsSatisfied: false,
    });
    now = new Date("2026-08-29T02:02:00.000Z");

    await expect(manager.collectGarbage()).resolves.toMatchObject({
      deletedProfileKeys: [oldest.profileKey],
      remainingProfileCount: 2,
      limitsSatisfied: true,
    });
    await expect(stat(oldest.userDataDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(middle.userDataDir)).isDirectory()).toBe(true);
    expect((await stat(newest.userDataDir)).isDirectory()).toBe(true);
  });

  it("enforces the tracked snapshot byte quota after the one-hour grace period", async () => {
    const home = await tempRoot("browser-byte-quota-");
    const seed = await tempRoot("browser-seed-");
    await seedChromeProfile(seed);
    let now = new Date("2026-08-29T00:00:00.000Z");
    const manager = new BrowserProfileManager({
      home,
      now: () => now,
      maxProfiles: 8,
      maxProfileBytes: 1,
    });
    await manager.initialize(seed, { seedState: "quiescent" });
    const profile = await manager.ensureChatProfile("chatgpt-session:byte-quota");
    now = new Date("2026-08-29T02:00:00.000Z");

    await expect(manager.collectGarbage()).resolves.toMatchObject({
      deletedProfileKeys: [profile.profileKey],
      remainingProfileCount: 0,
      remainingSnapshotBytes: 0,
      limitsSatisfied: true,
    });
  });

  it("cleans abandoned staging and trash on every initialization and seeds resume metadata", async () => {
    const home = await tempRoot("browser-startup-cleanup-");
    const manager = new BrowserProfileManager({ home });
    await manager.initialize();
    const profile = await manager.ensureChatProfile("chatgpt-session:existing");
    await rm(join(home, "chats", profile.profileKey, "resume.json"));
    await mkdir(join(home, "staging", "abandoned"), { recursive: true });
    await mkdir(join(home, "trash", "abandoned"), { recursive: true });
    await mkdir(join(home, "staging", "in-progress"), { recursive: true });
    await writeFile(join(home, "staging", "abandoned", "partial"), "partial");
    const abandonedAt = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(join(home, "staging", "abandoned"), abandonedAt, abandonedAt);
    await utimes(join(home, "trash", "abandoned"), abandonedAt, abandonedAt);

    const restarted = new BrowserProfileManager({ home });
    await restarted.initialize();

    expect(await readdir(join(home, "staging"))).toEqual(["in-progress"]);
    expect(await readdir(join(home, "trash"))).toEqual([]);
    await expect(restarted.getResumeState(profile.profileKey)).resolves.toMatchObject({ tabs: [] });
  });
});
