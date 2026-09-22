import { BrowserProfileManager, type BrowserLease, type ChatProfile } from "./profile-manager.js";

export const DEFAULT_BROWSER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_BROWSER_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_BROWSER_FAILURE_REPORT_INTERVAL_MS = 15 * 60 * 1000;
const BROWSER_START_GRACE_MS = 30 * 1000;

export type BrowserStopReason = "idle_timeout" | "startup_reconcile" | "server_shutdown";
export type StopManagedBrowserProfile = (
  profileKey: string,
  expectedLease: BrowserLease,
  reason: BrowserStopReason,
  expectedLastUsedAt?: string,
) => Promise<{ stopped?: boolean } | unknown>;

type TimerHandle = ReturnType<typeof setInterval>;
type LeasedChatProfile = ChatProfile & {
  instanceId: string;
  pid: number;
  port: number;
  leaseStartedAt: string;
};

type BrowserLifecycleOptions = {
  manager: BrowserProfileManager;
  stopManagedBrowserProfile: StopManagedBrowserProfile;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
  isCdpReachable?: (port: number) => Promise<boolean>;
  setIntervalFn?: (callback: () => void, delayMs: number) => TimerHandle;
  clearIntervalFn?: (timer: TimerHandle) => void;
  onError?: (error: unknown) => void;
};

export type BrowserLifecycleFailure = {
  profileKey: string;
  reason: BrowserStopReason;
  message: string;
};

export type BrowserLifecycleSweepResult = {
  recoveredProfileKeys: string[];
  stoppedProfileKeys: string[];
  failedProfileKeys: string[];
  failures: BrowserLifecycleFailure[];
};

export class BrowserLifecycleService {
  private readonly manager: BrowserProfileManager;
  private readonly stopManagedBrowserProfile: StopManagedBrowserProfile;
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => Date;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly isCdpReachable: (port: number) => Promise<boolean>;
  private readonly setIntervalFn: BrowserLifecycleOptions["setIntervalFn"];
  private readonly clearIntervalFn: BrowserLifecycleOptions["clearIntervalFn"];
  private readonly onError: (error: unknown) => void;
  private timer?: TimerHandle;
  private activeOperation: Promise<unknown> = Promise.resolve();
  private lastFailureSignature?: string;
  private lastFailureReportedAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: BrowserLifecycleOptions) {
    this.manager = options.manager;
    this.stopManagedBrowserProfile = options.stopManagedBrowserProfile;
    this.idleTimeoutMs = requirePositiveDuration(options.idleTimeoutMs ?? DEFAULT_BROWSER_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    this.sweepIntervalMs = requirePositiveDuration(options.sweepIntervalMs ?? DEFAULT_BROWSER_SWEEP_INTERVAL_MS, "sweepIntervalMs");
    this.now = options.now ?? (() => new Date());
    this.isPidAlive = options.isPidAlive ?? processIsAlive;
    this.isCdpReachable = options.isCdpReachable ?? cdpIsReachable;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.onError = options.onError ?? ((error) => console.error("[BrowserLifecycle]", error));
  }

  async start(): Promise<BrowserLifecycleSweepResult> {
    const result = await this.runExclusive(() => this.sweepInternal(true));
    this.reportFailures(result);
    if (!this.timer) {
      this.timer = this.setIntervalFn!(() => {
        void this.sweep().then((result) => {
          this.reportFailures(result);
        }).catch(this.onError);
      }, this.sweepIntervalMs);
      this.timer.unref?.();
    }
    return result;
  }

  async sweep(): Promise<BrowserLifecycleSweepResult> {
    return await this.runExclusive(() => this.sweepInternal(false));
  }

  async drain(): Promise<BrowserLifecycleSweepResult> {
    this.stopTimer();
    return await this.runExclusive(async () => {
      const profiles = await this.manager.listManagedProfiles();
      const candidates = profiles.filter(hasLease);
      return await this.stopProfiles(candidates, "server_shutdown", []);
    });
  }

  stopTimer(): void {
    if (!this.timer) return;
    this.clearIntervalFn!(this.timer);
    this.timer = undefined;
  }

  private async sweepInternal(startup: boolean): Promise<BrowserLifecycleSweepResult> {
    const recoveredProfileKeys: string[] = [];
    const stopCandidates: Array<{ profile: LeasedChatProfile; reason: BrowserStopReason }> = [];
    const profiles = await this.manager.listManagedProfiles();
    for (const profile of profiles) {
      if (!hasLease(profile)) continue;
      if (profile.pid === 0 && this.leaseAgeMs(profile) < BROWSER_START_GRACE_MS) continue;
      const pidAlive = this.isPidAlive(profile.pid);
      const cdpReachable = await this.isCdpReachable(profile.port);
      if (!pidAlive && !cdpReachable) {
        const recovered = await this.manager.recoverStaleLease(profile.profileKey, leaseFromProfile(profile));
        if (recovered) recoveredProfileKeys.push(profile.profileKey);
        continue;
      }
      if (profile.state === "checkpointing") {
        stopCandidates.push({ profile, reason: startup ? "startup_reconcile" : "idle_timeout" });
        continue;
      }
      if (startup && (!pidAlive || !cdpReachable)) {
        stopCandidates.push({ profile, reason: "startup_reconcile" });
        continue;
      }
      if (profile.state === "running" && this.isIdle(profile)) {
        stopCandidates.push({ profile, reason: "idle_timeout" });
      }
    }
    return await this.stopProfilesWithReasons(stopCandidates, recoveredProfileKeys);
  }

  private isIdle(profile: ChatProfile): boolean {
    const lastUsedAt = Date.parse(profile.lastUsedAt);
    return Number.isFinite(lastUsedAt) && this.now().getTime() - lastUsedAt >= this.idleTimeoutMs;
  }

  private leaseAgeMs(profile: LeasedChatProfile): number {
    const startedAt = Date.parse(profile.leaseStartedAt);
    return Number.isFinite(startedAt) ? this.now().getTime() - startedAt : Number.POSITIVE_INFINITY;
  }

  private async stopProfiles(
    profiles: LeasedChatProfile[],
    reason: BrowserStopReason,
    recoveredProfileKeys: string[],
  ): Promise<BrowserLifecycleSweepResult> {
    return await this.stopProfilesWithReasons(profiles.map((profile) => ({ profile, reason })), recoveredProfileKeys);
  }

  private async stopProfilesWithReasons(
    candidates: Array<{ profile: LeasedChatProfile; reason: BrowserStopReason }>,
    recoveredProfileKeys: string[],
  ): Promise<BrowserLifecycleSweepResult> {
    const stoppedProfileKeys: string[] = [];
    const failedProfileKeys: string[] = [];
    const failures: BrowserLifecycleFailure[] = [];
    const results = await Promise.allSettled(candidates.map(async ({ profile, reason }) => {
      const result = await this.stopManagedBrowserProfile(
        profile.profileKey,
        leaseFromProfile(profile),
        reason,
        reason === "idle_timeout" ? profile.lastUsedAt : undefined,
      );
      return { profileKey: profile.profileKey, stopped: !result || typeof result !== "object" || !("stopped" in result) || result.stopped !== false };
    }));
    for (let index = 0; index < results.length; index += 1) {
      const profileKey = candidates[index]!.profile.profileKey;
      const result = results[index]!;
      if (result.status === "fulfilled") {
        if (result.value.stopped) stoppedProfileKeys.push(profileKey);
      } else {
        failedProfileKeys.push(profileKey);
        failures.push({
          profileKey,
          reason: candidates[index]!.reason,
          message: errorMessage(result.reason),
        });
      }
    }
    return { recoveredProfileKeys, stoppedProfileKeys, failedProfileKeys, failures };
  }

  private reportFailures(result: BrowserLifecycleSweepResult): void {
    if (result.failures.length === 0) {
      this.lastFailureSignature = undefined;
      this.lastFailureReportedAtMs = Number.NEGATIVE_INFINITY;
      return;
    }
    const signature = result.failures
      .map((failure) => `${failure.profileKey}:${failure.reason}:${failure.message}`)
      .sort()
      .join("|");
    const nowMs = this.now().getTime();
    if (signature === this.lastFailureSignature
      && nowMs - this.lastFailureReportedAtMs < DEFAULT_BROWSER_FAILURE_REPORT_INTERVAL_MS) return;
    this.lastFailureSignature = signature;
    this.lastFailureReportedAtMs = nowMs;
    const details = result.failures
      .map((failure) => `${failure.profileKey} (${failure.reason}): ${failure.message}`)
      .join("; ");
    this.onError(new Error(`Browser lifecycle sweep failed for ${result.failures.length} profile(s): ${details}`));
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.activeOperation;
    let release!: () => void;
    this.activeOperation = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function browserIdleTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LOCAL_DEV_MCP_BROWSER_IDLE_TIMEOUT_MINUTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BROWSER_IDLE_TIMEOUT_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new Error("LOCAL_DEV_MCP_BROWSER_IDLE_TIMEOUT_MINUTES must be greater than 0 and at most 1440");
  }
  return Math.round(minutes * 60 * 1000);
}

function hasLease(profile: ChatProfile): profile is LeasedChatProfile {
  return Boolean(profile.instanceId
    && typeof profile.pid === "number"
    && profile.port
    && profile.leaseStartedAt);
}

function leaseFromProfile(profile: LeasedChatProfile): BrowserLease {
  return {
    instanceId: profile.instanceId,
    pid: profile.pid,
    port: profile.port,
    startedAt: profile.leaseStartedAt,
  };
}

function requirePositiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive duration`);
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cdpIsReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}
