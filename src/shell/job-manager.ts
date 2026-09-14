import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialScope, ProjectConfig, RiskLevel } from "../types.js";
import { classifyRisk, isCatastrophicCommand } from "./risk-classifier.js";
import { redactOutput } from "./redactor.js";

export type JobStatus = "running" | "succeeded" | "failed" | "canceled" | "timeout" | "interrupted" | "unknown";

export interface Job {
  id: string;
  pid?: number;
  longRunning?: boolean;
  projectId: string;
  cwd: string;
  command: string;
  purpose?: string;
  credentialScope?: CredentialScope;
  riskLevel: RiskLevel;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stdout: string;
  stderr: string;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redactions: Array<{ type: string; count: number }>;
  process?: ChildProcess;
  recoveryReason?: string;
}

const STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = 10;
const JOB_STORE_DIR = process.env.LOCAL_DEV_MCP_JOB_STORE_DIR || join(process.cwd(), ".local-dev-mcp", "jobs");
const DEFAULT_PERSISTED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let JOB_RETENTION_TTL_MS = 5 * 60 * 1000;
let PERSISTED_JOB_RETENTION_MS = DEFAULT_PERSISTED_JOB_RETENTION_MS;

const jobs = new Map<string, Job>();
const isCanceling = new Set<string>();
const jobCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
const refreshers = new Map<string, () => void>();

cleanupOldPersistedJobs();

export function getJob(jobId: string): Job | undefined {
  refreshers.get(jobId)?.();
  return jobs.get(jobId) ?? readPersistedJob(jobId);
}

export function getAllJobs(): Job[] {
  return Array.from(jobs.values());
}

export function getActiveJobs(): Job[] {
  return getAllJobs().filter((j) => j.status === "running");
}

export function startJob(
  project: ProjectConfig,
  command: string,
  purpose?: string,
  timeoutSeconds?: number,
  longRunning = false,
  credentialScope?: CredentialScope,
  env?: Record<string, string>
): Job | { error: string } {
  if (getActiveJobs().length >= MAX_CONCURRENT_JOBS) {
    return { error: `Too many active jobs (max ${MAX_CONCURRENT_JOBS}). Wait for some to complete.` };
  }

  const jobId = randomUUID();
  const risk = classifyRisk(command, project.deniedPaths);
  if (shouldBlockCommand(project, command, risk.level)) {
    return { error: `Forbidden command: ${risk.reasons.join(", ")}` };
  }

  const timeoutMs = longRunning
    ? null
    : Math.min(
        (timeoutSeconds ?? project.defaultTimeoutSeconds) * 1000,
        project.maxTimeoutSeconds * 1000
      );

  const child = spawn(project.defaultShell, ["-lc", command], {
    cwd: project.hostRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: env ? { ...process.env, ...env } : process.env,
  });

  const job: Job = {
    id: jobId,
    pid: child.pid,
    longRunning,
    projectId: project.projectId,
    cwd: project.hostRoot,
    command,
    purpose,
    credentialScope,
    riskLevel: risk.level,
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    redactions: [],
    process: child,
  };

  jobs.set(jobId, job);
  persistJob(job, true);

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let outputDirty = false;
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const tails = { stdout: "", stderr: "" };
  const retainedBytes = { stdout: 0, stderr: 0 };

  function appendOutput(buf: Buffer, target: "stdout" | "stderr"): void {
    const decoded = decoders[target].write(buf);
    tails[target] += decoded;
    if (Buffer.byteLength(tails[target]) > 128 * 1024) {
      const suffix = Buffer.from(tails[target]).subarray(-64 * 1024).toString("utf8");
      const newline = suffix.indexOf("\n");
      // Do not expose a partially retained first line, which may split credentials.
      tails[target] = newline < 0 ? "" : suffix.slice(newline + 1);
    }
    const maxBytes = target === "stdout" ? STDOUT_MAX_BYTES : STDERR_MAX_BYTES;
    const currentBytes = retainedBytes[target];
    if (currentBytes >= maxBytes) {
      if (target === "stdout") stdoutTruncated = true;
      else stderrTruncated = true;
      outputDirty = true;
      return;
    }
    const allowed = maxBytes - currentBytes;
    const encoded = Buffer.from(decoded);
    let end = Math.min(encoded.length, allowed);
    while (end > 0 && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end--;
    const text = encoded.subarray(0, end).toString("utf8");
    retainedBytes[target] += end;
    if (target === "stdout") stdout += text;
    else stderr += text;
    if (encoded.byteLength > allowed) {
      if (target === "stdout") stdoutTruncated = true;
      else stderrTruncated = true;
    }
    outputDirty = true;
  }

  function refreshJobView(): void {
    if (!outputDirty) return;
    outputDirty = false;
    const sensitiveValues = Object.values(env ?? {});
    const redactedStdout = redactOutput(stdout, project.redactionProfile, sensitiveValues);
    const redactedStderr = redactOutput(stderr, project.redactionProfile, sensitiveValues);
    const allRedactions = [...redactedStdout.redactions, ...redactedStderr.redactions];

    job.stdout = redactedStdout.text;
    job.stderr = redactedStderr.text;
    job.stdoutTail = redactOutput(tails.stdout, project.redactionProfile, sensitiveValues).text;
    job.stderrTail = redactOutput(tails.stderr, project.redactionProfile, sensitiveValues).text;
    job.stdoutTruncated = stdoutTruncated;
    job.stderrTruncated = stderrTruncated;
    job.redactions = mergeRedactions(allRedactions);
  }
  refreshers.set(jobId, refreshJobView);

  child.stdout?.on("data", (data: Buffer) => {
    appendOutput(data, "stdout");
  });

  child.stderr?.on("data", (data: Buffer) => {
    appendOutput(data, "stderr");
  });

  function finalize(exitCode: number | null, signal: NodeJS.Signals | null) {
    const cancelRequested = isCanceling.has(jobId);
    if (cancelRequested) {
      isCanceling.delete(jobId);
    }

    if (timer !== undefined) clearTimeout(timer);
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - new Date(job.startedAt).getTime();
    job.process = undefined;

    if (job.status === "canceled" && exitCode === 0 && signal === null) {
      job.status = "succeeded";
    } else if (job.status === "running") {
      if (exitCode === 0 && signal === null) {
        job.status = "succeeded";
      } else if (cancelRequested || signal !== null) {
        job.status = "canceled";
      } else {
        job.status = "failed";
      }
    }
    refreshJobView();
    refreshers.delete(jobId);
    persistJob(job);
    scheduleJobCleanup(jobId);
  }

  const timer = timeoutMs === null ? undefined : setTimeout(() => {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* ignore */ }
    }, 5000);
    job.status = "timeout";
  }, timeoutMs);

  child.on("close", finalize);

  child.on("error", () => {
    if (timer !== undefined) clearTimeout(timer);
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.process = undefined;
    refreshJobView();
    refreshers.delete(jobId);
    persistJob(job);
    scheduleJobCleanup(jobId);
  });

  child.unref();
  return job;
}

function shouldBlockCommand(project: ProjectConfig, command: string, riskLevel: RiskLevel): boolean {
  if (riskLevel === "forbidden") {
    return true;
  }
  if (project.approvalMode === "never") {
    return false;
  }
  if (project.approvalMode === "catastrophic_only") {
    return isCatastrophicCommand(command);
  }
  return false;
}

export function cancelJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running" || !job.process?.pid) {
    return false;
  }
  if (job.process.exitCode !== null || job.process.signalCode !== null) {
    return false;
  }
  isCanceling.add(jobId);
  job.status = "canceled";
  terminateProcessGroup(job.process.pid);
  return true;
}

export function cancelJobByPid(pid: number): Job | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const job = Array.from(jobs.values()).find((candidate) => candidate.pid === pid && candidate.status === "running");
  if (!job) return undefined;
  if (!cancelJob(job.id)) return undefined;
  return job;
}

function terminateProcessGroup(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  const forceKill = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
  }, 5000);
  forceKill.unref?.();
}

function persistedJobPath(jobId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid job ID");
  return join(JOB_STORE_DIR, `${jobId}.json`);
}

function toPersistedJob(job: Job): Job {
  const { process: _process, ...persisted } = job;
  return persisted;
}

function persistJob(job: Job, allowRunning = false): void {
  if (job.status === "running" && !allowRunning) {
    return;
  }

  try {
    mkdirSync(JOB_STORE_DIR, { recursive: true });
    writeFileSync(persistedJobPath(job.id), JSON.stringify(toPersistedJob(job), null, 2), "utf-8");
  } catch {
    // Best-effort persistence: shell.status should still work from memory.
  }
}

function readPersistedJob(jobId: string): Job | undefined {
  try {
    const raw = readFileSync(persistedJobPath(jobId), "utf-8");
    const parsed = JSON.parse(raw) as Job;
    if (parsed.status === "running") {
      let exists = false;
      try {
        if (Number.isSafeInteger(parsed.pid) && parsed.pid! > 0) {
          process.kill(parsed.pid!, 0);
          exists = true;
        }
      } catch (error) { exists = (error as NodeJS.ErrnoException).code === "EPERM"; }
      // A live PID alone cannot establish ownership or recover its exit status.
      parsed.status = exists ? "unknown" : "interrupted";
      parsed.recoveryReason = exists ? "Process ownership and completion cannot be recovered after restart." : "Persisted running job has no live process; exit status is unavailable.";
    }
    return { ...parsed, process: undefined };
  } catch {
    return undefined;
  }
}

function cleanupOldPersistedJobs(now = Date.now()): void {
  try {
    for (const entry of readdirSync(JOB_STORE_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = join(JOB_STORE_DIR, entry.name);
      const ageMs = now - statSync(filePath).mtimeMs;
      if (ageMs >= PERSISTED_JOB_RETENTION_MS) {
        rmSync(filePath, { force: true });
      }
    }
  } catch {
    // Best-effort cleanup: stale persisted jobs should not break shell execution.
  }
}

function scheduleJobCleanup(jobId: string): void {
  const existing = jobCleanupTimers.get(jobId);
  if (existing) {
    clearTimeout(existing);
  }

  const cleanup = setTimeout(() => {
    jobs.delete(jobId);
    jobCleanupTimers.delete(jobId);
  }, JOB_RETENTION_TTL_MS);
  jobCleanupTimers.set(jobId, cleanup);
}

export function setJobRetentionTtlForTests(ttlMs: number): void {
  JOB_RETENTION_TTL_MS = ttlMs;
}

export function setPersistedJobRetentionForTests(ttlMs: number): void {
  PERSISTED_JOB_RETENTION_MS = ttlMs;
}

export function cleanupOldPersistedJobsForTests(now?: number): void {
  cleanupOldPersistedJobs(now);
}

export function clearJobsForTests(): void {
  if (process.env.VITEST !== "true" || !process.env.LOCAL_DEV_MCP_JOB_STORE_DIR) throw new Error("Test cleanup requires an isolated job store.");
  for (const timer of jobCleanupTimers.values()) {
    clearTimeout(timer);
  }
  jobCleanupTimers.clear();
  jobs.clear();
  refreshers.clear();
  isCanceling.clear();
  rmSync(JOB_STORE_DIR, { recursive: true, force: true });
}

function mergeRedactions(items: Array<{ type: string; count: number }>): Array<{ type: string; count: number }> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.type, (map.get(item.type) ?? 0) + item.count);
  }
  return Array.from(map.entries()).map(([type, count]) => ({ type, count }));
}
