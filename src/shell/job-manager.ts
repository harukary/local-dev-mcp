import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, RiskLevel } from "../types.js";
import { classifyRisk, isCatastrophicCommand } from "./risk-classifier.js";
import { redactOutput } from "./redactor.js";

export type JobStatus = "running" | "succeeded" | "failed" | "canceled" | "timeout";

export interface Job {
  id: string;
  projectId: string;
  cwd: string;
  command: string;
  purpose?: string;
  riskLevel: RiskLevel;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redactions: Array<{ type: string; count: number }>;
  process?: ChildProcess;
}

const STDOUT_MAX_BYTES = 100 * 1024;
const STDERR_MAX_BYTES = 100 * 1024;
const MAX_CONCURRENT_JOBS = 10;
const JOB_STORE_DIR = join(process.cwd(), ".local-dev-mcp", "jobs");
const DEFAULT_PERSISTED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let JOB_RETENTION_TTL_MS = 5 * 60 * 1000;
let PERSISTED_JOB_RETENTION_MS = DEFAULT_PERSISTED_JOB_RETENTION_MS;

const jobs = new Map<string, Job>();
const isCanceling = new Set<string>();
const jobCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

cleanupOldPersistedJobs();

export function getJob(jobId: string): Job | undefined {
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
  timeoutSeconds?: number
): Job | { error: string } {
  if (getActiveJobs().length >= MAX_CONCURRENT_JOBS) {
    return { error: `Too many active jobs (max ${MAX_CONCURRENT_JOBS}). Wait for some to complete.` };
  }

  const jobId = randomUUID();
  const risk = classifyRisk(command, project.deniedPaths);
  if (shouldBlockCommand(project, command, risk.level)) {
    return { error: `Forbidden command: ${risk.reasons.join(", ")}` };
  }

  const timeoutMs = Math.min(
    (timeoutSeconds ?? project.defaultTimeoutSeconds) * 1000,
    project.maxTimeoutSeconds * 1000
  );

  const child = spawn(project.defaultShell, ["-lc", command], {
    cwd: project.hostRoot,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const job: Job = {
    id: jobId,
    projectId: project.projectId,
    cwd: project.hostRoot,
    command,
    purpose,
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

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;

  function appendOutput(buf: Buffer, target: "stdout" | "stderr"): void {
    const maxBytes = target === "stdout" ? STDOUT_MAX_BYTES : STDERR_MAX_BYTES;
    const current = target === "stdout" ? stdout : stderr;
    const currentBytes = Buffer.byteLength(current, "utf-8");
    if (currentBytes >= maxBytes) {
      if (target === "stdout") stdoutTruncated = true;
      else stderrTruncated = true;
      refreshJobView();
      return;
    }
    const allowed = maxBytes - currentBytes;
    const text = buf.toString("utf-8", 0, Math.min(buf.byteLength, allowed));
    if (target === "stdout") stdout += text;
    else stderr += text;
    if (buf.byteLength > allowed) {
      if (target === "stdout") stdoutTruncated = true;
      else stderrTruncated = true;
    }
    refreshJobView();
  }

  function refreshJobView(): void {
    const redactedStdout = redactOutput(stdout, project.redactionProfile);
    const redactedStderr = redactOutput(stderr, project.redactionProfile);
    const allRedactions = [...redactedStdout.redactions, ...redactedStderr.redactions];

    job.stdout = redactedStdout.text;
    job.stderr = redactedStderr.text;
    job.stdoutTruncated = stdoutTruncated;
    job.stderrTruncated = stderrTruncated;
    job.redactions = mergeRedactions(allRedactions);
  }

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

    clearTimeout(timer);
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
    persistJob(job);
    scheduleJobCleanup(jobId);
  }

  const timer = setTimeout(() => {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* ignore */ }
    }, 5000);
    job.status = "timeout";
  }, timeoutMs);

  child.on("close", finalize);

  child.on("error", () => {
    clearTimeout(timer);
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.process = undefined;
    refreshJobView();
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
  if (!job || job.status !== "running" || !job.process) {
    return false;
  }
  if (job.process.exitCode !== null || job.process.signalCode !== null) {
    return false;
  }
  isCanceling.add(jobId);
  job.status = "canceled";
  try { process.kill(-job.process.pid!, "SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => {
    try { process.kill(-job.process!.pid!, "SIGKILL"); } catch { /* ignore */ }
  }, 5000);
  return true;
}

function persistedJobPath(jobId: string): string {
  return join(JOB_STORE_DIR, `${jobId}.json`);
}

function toPersistedJob(job: Job): Job {
  const { process: _process, ...persisted } = job;
  return persisted;
}

function persistJob(job: Job): void {
  if (job.status === "running") {
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
  for (const timer of jobCleanupTimers.values()) {
    clearTimeout(timer);
  }
  jobCleanupTimers.clear();
  jobs.clear();
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
