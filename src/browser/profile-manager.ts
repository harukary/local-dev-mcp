import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyChromeProfileSnapshot, type SnapshotCopyMode } from "./snapshot-copier.js";

const PROFILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const CLAIM_REFRESH_MS = 6 * 60 * 60 * 1000;

export type AuthClaimStatus = "authenticated" | "signed_out" | "unknown";

export type AuthClaimInput = {
  probeId: string;
  probeVersion: number;
  status: AuthClaimStatus;
  principal?: string;
  verifiedAt: string;
  validUntil: string;
};

type StoredAuthClaim = Omit<AuthClaimInput, "principal"> & { principalHash?: string };
type SnapshotVerification = "structural_only" | "live_auth_reprobe";

type BrowserLease = { instanceId: string; pid: number; port: number; startedAt: string };

type ChatProfileManifest = {
  schemaVersion: 1;
  kind: "chat";
  profileKey: string;
  state: "idle" | "running" | "checkpointing" | "quarantined";
  baseGeneration: string;
  createdAt: string;
  lastUsedAt: string;
  revision: number;
  lease?: BrowserLease;
  authClaims: StoredAuthClaim[];
  copyMode: SnapshotCopyMode;
  snapshotBytes: number;
  excludedBytes: number;
  baseVerification: SnapshotVerification;
  lastPromotionAt?: string;
};

type GoldenManifest = {
  schemaVersion: 1;
  kind: "golden";
  generationId: string;
  createdAt: string;
  authClaims: StoredAuthClaim[];
  copyMode: SnapshotCopyMode;
  snapshotBytes: number;
  excludedBytes: number;
  snapshotVerification: SnapshotVerification;
  complete: true;
};

type BrowserState = {
  schemaVersion: 1;
  goldenGeneration: string;
  principalSalt: string;
  updatedAt: string;
};

type ManagerOptions = { home: string; now?: () => Date; lockTimeoutMs?: number; lockStaleMs?: number };

export type ChatProfile = {
  profileKey: string;
  userDataDir: string;
  baseGeneration: string;
  lastUsedAt: string;
  state: ChatProfileManifest["state"];
  port?: number;
  pid?: number;
  instanceId?: string;
  snapshotBytes: number;
  copyMode: SnapshotCopyMode;
  snapshotVerification: SnapshotVerification;
};

export function browserProfileKey(chatContextId: string): string {
  return createHash("sha256").update(`v1\0${chatContextId}`).digest("hex").slice(0, 32);
}

export class BrowserProfileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class BrowserProfileManager {
  private readonly home: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;

  constructor(options: ManagerOptions) {
    this.home = options.home;
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
  }

  async initialize(
    seedProfileRoot?: string,
    options: { seedState?: "absent" | "quiescent"; revalidateSeed?: () => Promise<boolean> } = {},
  ): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await Promise.all([
      mkdir(this.chatRoot(), { recursive: true, mode: 0o700 }),
      mkdir(this.goldenRoot(), { recursive: true, mode: 0o700 }),
      mkdir(this.locksRoot(), { recursive: true, mode: 0o700 }),
      mkdir(join(this.home, "staging"), { recursive: true, mode: 0o700 }),
      mkdir(join(this.home, "trash"), { recursive: true, mode: 0o700 }),
    ]);
    try {
      await this.readState();
      return;
    } catch (error) {
      if (!(error instanceof BrowserProfileError) || error.code !== "BROWSER_STATE_NOT_FOUND") throw error;
    }
    if (seedProfileRoot && options.seedState !== "quiescent") {
      throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_STATE_UNKNOWN", "Legacy browser profile state was not verified as quiescent.");
    }
    await this.withLock("state", async () => {
      const existing = await this.readState().catch((error) => {
        if (error instanceof BrowserProfileError && error.code === "BROWSER_STATE_NOT_FOUND") return undefined;
        throw error;
      });
      if (existing) return;
      await this.recoverAbandonedOperations();
      if (seedProfileRoot && options.revalidateSeed && !(await options.revalidateSeed())) {
        throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_REQUIRES_STOP", "Legacy browser became active before migration.");
      }
      await this.bootstrapGolden(seedProfileRoot, options.revalidateSeed);
    });
  }

  async ensureChatProfile(chatContextId: string): Promise<ChatProfile> {
    this.requireSessionContext(chatContextId);
    const profileKey = browserProfileKey(chatContextId);
    return await this.withLock(`profile-${profileKey}`, async () => {
      const existing = await this.readChatManifest(profileKey).catch((error) => {
        if (error instanceof BrowserProfileError && error.code === "BROWSER_PROFILE_NOT_FOUND") return undefined;
        throw error;
      });
      if (existing) return this.publicProfile(existing);
      const state = await this.readState();
      const golden = await this.readGoldenManifest(state.goldenGeneration);
      const staging = join(this.home, "staging", `chat-${randomUUID()}`);
      const destination = this.chatDirectory(profileKey);
      try {
        const copy = await this.withLock(`generation-${state.goldenGeneration}`, () =>
          copyChromeProfileSnapshot(this.goldenUserDataDir(state.goldenGeneration), join(staging, "user-data"))
        );
        const now = this.now().toISOString();
        const manifest: ChatProfileManifest = {
        schemaVersion: 1,
        kind: "chat",
        profileKey,
        state: "idle",
        baseGeneration: golden.generationId,
        createdAt: now,
        lastUsedAt: now,
        revision: 1,
        authClaims: golden.authClaims,
        copyMode: copy.copyMode,
        snapshotBytes: copy.copiedBytes,
        excludedBytes: copy.excludedBytes,
        baseVerification: golden.snapshotVerification ?? "structural_only",
        };
        await this.atomicWriteJson(join(staging, "manifest.json"), manifest);
        await rename(staging, destination);
        return this.publicProfile(manifest);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async getOwnedProfile(chatContextId: string, requestedProfileKey?: string): Promise<ChatProfile> {
    this.requireSessionContext(chatContextId);
    const ownedKey = browserProfileKey(chatContextId);
    if (requestedProfileKey && requestedProfileKey !== ownedKey) {
      throw new BrowserProfileError("BROWSER_PROFILE_NOT_OWNED", "The browser profile belongs to another chat.");
    }
    const manifest = await this.readChatManifest(ownedKey);
    return this.publicProfile(manifest);
  }

  async getOptionalOwnedProfile(chatContextId: string): Promise<ChatProfile | undefined> {
    this.requireSessionContext(chatContextId);
    try {
      return await this.getOwnedProfile(chatContextId);
    } catch (error) {
      if (error instanceof BrowserProfileError && error.code === "BROWSER_PROFILE_NOT_FOUND") return undefined;
      throw error;
    }
  }

  async touch(profileKey: string): Promise<void> {
    await this.updateChatManifest(profileKey, (manifest) => ({
      ...manifest,
      lastUsedAt: this.now().toISOString(),
      revision: manifest.revision + 1,
    }));
  }

  async markRunning(profileKey: string, lease: Omit<BrowserLease, "startedAt">): Promise<void> {
    await this.updateChatManifest(profileKey, (manifest) => {
      if (manifest.state !== "running" || !sameLease(manifest.lease, lease, true)) {
        throw new BrowserProfileError("BROWSER_PROFILE_BUSY", "Browser profile lease changed while Chrome was starting.");
      }
      return {
        ...manifest,
        lease: { ...lease, startedAt: manifest.lease.startedAt },
        lastUsedAt: this.now().toISOString(),
        revision: manifest.revision + 1,
      };
    });
  }

  async beginCheckpoint(profileKey: string, lease: Omit<BrowserLease, "startedAt">): Promise<void> {
    await this.updateChatManifest(profileKey, (manifest) => {
      if (manifest.state !== "running" || !sameLease(manifest.lease, lease)) {
        throw new BrowserProfileError("BROWSER_PROFILE_BUSY", "Browser profile lease changed before checkpointing.");
      }
      return { ...manifest, state: "checkpointing", revision: manifest.revision + 1 };
    });
  }

  async finishCheckpoint(profileKey: string, lease: Omit<BrowserLease, "startedAt">, claims: AuthClaimInput[]): Promise<void> {
    const state = await this.readState();
    const stored = this.storeAuthClaims(state.principalSalt, claims);
    await this.updateChatManifest(profileKey, (manifest) => {
      if (manifest.state !== "checkpointing" || !sameLease(manifest.lease, lease)) {
        throw new BrowserProfileError("BROWSER_PROFILE_BUSY", "Browser profile lease changed during checkpointing.");
      }
      const { lease: _lease, ...rest } = manifest;
      return {
        ...rest,
        state: "idle",
        authClaims: stored,
        lastUsedAt: this.now().toISOString(),
        revision: manifest.revision + 1,
      };
    });
  }

  async markIdle(profileKey: string): Promise<void> {
    await this.updateChatManifest(profileKey, (manifest) => {
      const { lease: _lease, ...rest } = manifest;
      return { ...rest, state: "idle", lastUsedAt: this.now().toISOString(), revision: manifest.revision + 1 };
    });
  }

  async recordAuthClaims(profileKey: string, claims: AuthClaimInput[]): Promise<void> {
    const state = await this.readState();
    const stored = this.storeAuthClaims(state.principalSalt, claims);
    await this.updateChatManifest(profileKey, (manifest) => ({ ...manifest, authClaims: stored, revision: manifest.revision + 1 }));
  }

  async promoteIfDominant(
    profileKey: string,
    validateSnapshot: (userDataDir: string) => Promise<boolean>,
  ): Promise<{ promoted: boolean; generationId?: string; reason?: string; snapshotVerification?: SnapshotVerification }> {
    const generationId = randomUUID();
    const staging = join(this.home, "staging", `golden-${generationId}`);
    const prepared = await this.withLock(`profile-${profileKey}`, async () => {
      const candidate = await this.readChatManifest(profileKey);
      if (candidate.state === "running" || candidate.lease) {
        return { result: { promoted: false, reason: "profile_is_running" } as const };
      }
      try {
        const copy = await copyChromeProfileSnapshot(this.chatUserDataDir(profileKey), join(staging, "user-data"));
        return { candidate, copy };
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    });
    if ("result" in prepared && prepared.result) return prepared.result;

    const validationRoot = join(this.home, "staging", `validation-${randomUUID()}`);
    try {
      await copyChromeProfileSnapshot(join(staging, "user-data"), join(validationRoot, "user-data"));
      if (!(await validateSnapshot(join(validationRoot, "user-data")))) {
        await rm(staging, { recursive: true, force: true });
        return { promoted: false, reason: "snapshot_validation_failed" };
      }
    } catch {
      await rm(staging, { recursive: true, force: true });
      return { promoted: false, reason: "snapshot_validation_failed" };
    } finally {
      await rm(validationRoot, { recursive: true, force: true });
    }

    return await this.withLock("state", async () => this.withLock(`profile-${profileKey}`, async () => {
      const state = await this.readState();
      const candidate = await this.readChatManifest(profileKey);
      if (candidate.revision !== prepared.candidate.revision || candidate.state !== "idle" || candidate.lease) {
        await rm(staging, { recursive: true, force: true });
        return { promoted: false, reason: "candidate_changed_during_checkpoint" };
      }
      const golden = await this.readGoldenManifest(state.goldenGeneration);
      if (!dominates(candidate.authClaims, golden.authClaims, this.now())) {
        await rm(staging, { recursive: true, force: true });
        return { promoted: false, reason: "candidate_does_not_dominate" };
      }
      const createdAt = this.now().toISOString();
      const manifest: GoldenManifest = {
        schemaVersion: 1,
        kind: "golden",
        generationId,
        createdAt,
        authClaims: candidate.authClaims,
        copyMode: prepared.copy.copyMode,
        snapshotBytes: prepared.copy.copiedBytes,
        excludedBytes: prepared.copy.excludedBytes,
        snapshotVerification: "live_auth_reprobe",
        complete: true,
      };
      await this.atomicWriteJson(join(staging, "manifest.json"), manifest);
      await rename(staging, this.goldenDirectory(generationId));
      await this.atomicWriteJson(this.statePath(), { ...state, goldenGeneration: generationId, updatedAt: createdAt });
      await this.atomicWriteJson(this.chatManifestPath(profileKey), {
        ...candidate,
        lastPromotionAt: createdAt,
        revision: candidate.revision + 1,
      });
      await this.pruneGoldenGenerations(generationId);
      return { promoted: true, generationId, snapshotVerification: manifest.snapshotVerification };
    }));
  }

  async statusForChat(chatContextId: string): Promise<{
    profileKey: string;
    state: ChatProfileManifest["state"];
    lastUsedAt: string;
    gcAfter: string;
    authenticatedProbeIds: string[];
    baseGeneration: string;
    snapshotBytes: number;
    copyMode: SnapshotCopyMode;
    snapshotVerification: SnapshotVerification;
  }> {
    const profile = await this.getOwnedProfile(chatContextId);
    const manifest = await this.readChatManifest(profile.profileKey);
    return {
      profileKey: manifest.profileKey,
      state: manifest.state,
      lastUsedAt: manifest.lastUsedAt,
      gcAfter: new Date(Date.parse(manifest.lastUsedAt) + PROFILE_RETENTION_MS).toISOString(),
      authenticatedProbeIds: activeClaims(manifest.authClaims, this.now()).map((claim) => claim.probeId).sort(),
      baseGeneration: manifest.baseGeneration,
      snapshotBytes: manifest.snapshotBytes,
      copyMode: manifest.copyMode,
      snapshotVerification: manifest.baseVerification ?? "structural_only",
    };
  }

  async collectGarbage(): Promise<{ deletedProfileKeys: string[] }> {
    const deletedProfileKeys: string[] = [];
    await this.withLock("state", async () => {
      for (const entry of await readdir(this.chatRoot(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const profileKey = entry.name;
        const manifest = await this.readChatManifest(profileKey).catch(() => undefined);
        if (!manifest || manifest.state !== "idle" || manifest.lease) continue;
        if (this.now().getTime() - Date.parse(manifest.lastUsedAt) < PROFILE_RETENTION_MS) continue;
        await this.withLock(`profile-${profileKey}`, async () => {
          const current = await this.readChatManifest(profileKey).catch(() => undefined);
          if (!current || current.state !== "idle" || current.lease) return;
          if (this.now().getTime() - Date.parse(current.lastUsedAt) < PROFILE_RETENTION_MS) return;
          const trash = join(this.home, "trash", `${profileKey}-${randomUUID()}`);
          await rename(this.chatDirectory(profileKey), trash);
          await rm(trash, { recursive: true, force: true });
          deletedProfileKeys.push(profileKey);
        });
      }
    });
    return { deletedProfileKeys };
  }

  private async bootstrapGolden(seedProfileRoot?: string, revalidateSeed?: () => Promise<boolean>): Promise<void> {
    const generationId = randomUUID();
    const staging = join(this.home, "staging", `golden-${generationId}`);
    const userData = join(staging, "user-data");
    try {
      const copy = seedProfileRoot
        ? await copyChromeProfileSnapshot(seedProfileRoot, userData)
        : (await mkdir(join(userData, "Default"), { recursive: true }), { copyMode: "copy" as const, fileCount: 0, copiedBytes: 0, excludedBytes: 0 });
      if (seedProfileRoot && revalidateSeed && !(await revalidateSeed())) {
        throw new BrowserProfileError("BROWSER_PROFILE_MIGRATION_REQUIRES_STOP", "Legacy browser became active during migration.");
      }
      const now = this.now().toISOString();
      const golden: GoldenManifest = {
      schemaVersion: 1,
      kind: "golden",
      generationId,
      createdAt: now,
      authClaims: [],
      copyMode: copy.copyMode,
      snapshotBytes: copy.copiedBytes,
      excludedBytes: copy.excludedBytes,
      snapshotVerification: "structural_only",
      complete: true,
      };
      await this.atomicWriteJson(join(staging, "manifest.json"), golden);
      await rename(staging, this.goldenDirectory(generationId));
      await this.atomicWriteJson(this.statePath(), {
        schemaVersion: 1,
        goldenGeneration: generationId,
        principalSalt: randomBytes(32).toString("hex"),
        updatedAt: now,
      } satisfies BrowserState);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private requireSessionContext(chatContextId: string): void {
    if (!chatContextId.startsWith("chatgpt-session:") || chatContextId.length <= "chatgpt-session:".length) {
      throw new BrowserProfileError("BROWSER_CHAT_ID_UNAVAILABLE", "Browser profiles require an OpenAI chat session identity.");
    }
  }

  private publicProfile(manifest: ChatProfileManifest): ChatProfile {
    return {
      profileKey: manifest.profileKey,
      userDataDir: this.chatUserDataDir(manifest.profileKey),
      baseGeneration: manifest.baseGeneration,
      lastUsedAt: manifest.lastUsedAt,
      state: manifest.state,
      port: manifest.lease?.port,
      pid: manifest.lease?.pid,
      instanceId: manifest.lease?.instanceId,
      snapshotBytes: manifest.snapshotBytes,
      copyMode: manifest.copyMode,
      snapshotVerification: manifest.baseVerification ?? "structural_only",
    };
  }

  async reservePort(
    profileKey: string,
    range: { min: number; max: number },
    instanceId: string,
    canListen: (port: number) => Promise<boolean>,
  ): Promise<number> {
    return await this.withLock("state", async () => {
      const used = new Set<number>();
      for (const entry of await readdir(this.chatRoot(), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = await this.readChatManifest(entry.name).catch(() => undefined);
        if (manifest?.lease?.port) used.add(manifest.lease.port);
      }
      for (let port = range.min; port <= range.max; port += 1) {
        if (used.has(port) || !(await canListen(port))) continue;
        await this.updateChatManifest(profileKey, (manifest) => {
          if (manifest.state !== "idle" || manifest.lease) {
            throw new BrowserProfileError("BROWSER_PROFILE_BUSY", "Browser profile is already running or checkpointing.");
          }
          return {
            ...manifest,
            state: "running",
            lease: { instanceId, pid: 0, port, startedAt: this.now().toISOString() },
            lastUsedAt: this.now().toISOString(),
            revision: manifest.revision + 1,
          };
        });
        return port;
      }
      throw new BrowserProfileError("BROWSER_PORT_UNAVAILABLE", "No browser port is available.");
    });
  }

  private async updateChatManifest(profileKey: string, update: (manifest: ChatProfileManifest) => ChatProfileManifest): Promise<void> {
    await this.withLock(`profile-${profileKey}`, async () => {
      const manifest = await this.readChatManifest(profileKey);
      await this.atomicWriteJson(this.chatManifestPath(profileKey), update(manifest));
    });
  }

  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = join(this.locksRoot(), `${name}.lock`);
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lockPath);
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
        if (code !== "EEXIST") throw error;
        const age = await stat(lockPath).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        const ownerPid = await readFile(join(lockPath, "owner.json"), "utf8")
          .then((raw) => (JSON.parse(raw) as { pid?: unknown }).pid)
          .catch(() => undefined);
        if (age > this.lockStaleMs && !isPidAlive(ownerPid)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new BrowserProfileError("BROWSER_PROFILE_BUSY", "Browser profile state is busy.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  }

  private async readJson<T>(path: string, notFoundCode: string): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      if (code === "ENOENT") throw new BrowserProfileError(notFoundCode, `Browser profile state is missing: ${notFoundCode}`);
      throw new BrowserProfileError("BROWSER_STATE_CORRUPT", "Browser profile state is corrupt.");
    }
  }

  private readState(): Promise<BrowserState> { return this.readJson(this.statePath(), "BROWSER_STATE_NOT_FOUND"); }
  private readChatManifest(key: string): Promise<ChatProfileManifest> { return this.readJson(this.chatManifestPath(key), "BROWSER_PROFILE_NOT_FOUND"); }
  private readGoldenManifest(id: string): Promise<GoldenManifest> { return this.readJson(join(this.goldenDirectory(id), "manifest.json"), "BROWSER_GOLDEN_NOT_FOUND"); }
  private hashPrincipal(salt: string, principal: string): string { return createHash("sha256").update(`${salt}\0${principal.trim().toLowerCase()}`).digest("hex"); }
  private storeAuthClaims(salt: string, claims: AuthClaimInput[]): StoredAuthClaim[] {
    return claims.map((claim): StoredAuthClaim => ({
      probeId: claim.probeId,
      probeVersion: claim.probeVersion,
      status: claim.status,
      verifiedAt: claim.verifiedAt,
      validUntil: claim.validUntil,
      ...(claim.principal ? { principalHash: this.hashPrincipal(salt, claim.principal) } : {}),
    }));
  }
  private async recoverAbandonedOperations(): Promise<void> {
    for (const name of ["staging", "trash"]) {
      const root = join(this.home, name);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) await rm(join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
  private async pruneGoldenGenerations(currentGeneration: string): Promise<void> {
    const generations: Array<{ id: string; createdAt: string }> = [];
    for (const entry of await readdir(this.goldenRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readGoldenManifest(entry.name).catch(() => undefined);
      if (manifest?.complete) generations.push({ id: entry.name, createdAt: manifest.createdAt });
    }
    generations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const previous = generations.find((item) => item.id !== currentGeneration)?.id;
    const keep = new Set([currentGeneration, ...(previous ? [previous] : [])]);
    for (const generation of generations) {
      if (!keep.has(generation.id)) {
        await this.withLock(`generation-${generation.id}`, () =>
          rm(this.goldenDirectory(generation.id), { recursive: true, force: true })
        );
      }
    }
  }
  private statePath(): string { return join(this.home, "state.json"); }
  private locksRoot(): string { return join(this.home, "locks"); }
  private chatRoot(): string { return join(this.home, "chats"); }
  private goldenRoot(): string { return join(this.home, "golden", "generations"); }
  private chatDirectory(key: string): string { return join(this.chatRoot(), key); }
  private chatManifestPath(key: string): string { return join(this.chatDirectory(key), "manifest.json"); }
  private chatUserDataDir(key: string): string { return join(this.chatDirectory(key), "user-data"); }
  private goldenDirectory(id: string): string { return join(this.goldenRoot(), id); }
  private goldenUserDataDir(id: string): string { return join(this.goldenDirectory(id), "user-data"); }
}

function isPidAlive(value: unknown): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function sameLease(
  current: BrowserLease | undefined,
  expected: Omit<BrowserLease, "startedAt">,
  allowReservedPid = false,
): current is BrowserLease {
  return Boolean(current
    && current.instanceId === expected.instanceId
    && current.port === expected.port
    && (current.pid === expected.pid || (allowReservedPid && current.pid === 0)));
}

function activeClaims(claims: StoredAuthClaim[], now: Date): StoredAuthClaim[] {
  return claims.filter((claim) => claim.status === "authenticated" && claim.principalHash && Date.parse(claim.validUntil) > now.getTime());
}

function dominates(candidateClaims: StoredAuthClaim[], goldenClaims: StoredAuthClaim[], now: Date): boolean {
  const candidate = new Map(activeClaims(candidateClaims, now).map((claim) => [`${claim.probeId}:${claim.probeVersion}`, claim]));
  const golden = new Map(activeClaims(goldenClaims, now).map((claim) => [`${claim.probeId}:${claim.probeVersion}`, claim]));
  for (const [key, claim] of golden) {
    const other = candidate.get(key);
    if (!other || other.principalHash !== claim.principalHash) return false;
  }
  if (candidate.size > golden.size) return true;
  if (candidate.size === 0 || candidate.size !== golden.size) return false;
  return [...golden].every(([key, claim]) =>
    Date.parse(candidate.get(key)!.verifiedAt) - Date.parse(claim.verifiedAt) >= CLAIM_REFRESH_MS
  );
}
