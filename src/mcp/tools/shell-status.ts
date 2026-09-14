import { getJob } from "../../shell/job-manager.js";
import { boundedInteger, utf8Prefix } from "../output.js";

type OutputCursor = { stdout: number; stderr: number };

function encodeCursor(cursor: OutputCursor): string {
  return `${cursor.stdout}:${cursor.stderr}`;
}

function decodeCursor(value: string | undefined): OutputCursor | null {
  if (value === undefined) return { stdout: 0, stderr: 0 };
  const match = value.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const stdout = Number(match[1]);
  const stderr = Number(match[2]);
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) return null;
  return { stdout, stderr };
}

function jsonError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

function hasChanged(jobId: string, cursor: OutputCursor, initialStatus: string, statusOnly: boolean): boolean {
  const job = getJob(jobId);
  if (!job) return true;
  return job.status !== initialStatus || (!statusOnly && (job.stdout.length > cursor.stdout || job.stderr.length > cursor.stderr));
}

async function waitForChange(jobId: string, cursor: OutputCursor, waitMs: number, initialStatus: string, statusOnly: boolean): Promise<void> {
  if (waitMs <= 0 || initialStatus !== "running") return;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (hasChanged(jobId, cursor, initialStatus, statusOnly)) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(10, deadline - Date.now()))));
  }
}

export async function handleShellStatus(args: { job_id: string; cursor?: string; wait_ms?: number; max_bytes?: number; output?: "all" | "none" | "tail" }) {
  if (!args?.job_id) return jsonError("JOB_ID_REQUIRED", "Missing required argument: job_id");

  const requestedCursor = decodeCursor(args.cursor);
  if (!requestedCursor) return jsonError("INVALID_CURSOR", "cursor must use the <stdout_offset>:<stderr_offset> format returned by shell.status");

  let job = getJob(args.job_id);
  if (!job) {
    return jsonError("JOB_NOT_FOUND", `No job found: "${args.job_id}". Completed jobs are persisted for seven days when available.`);
  }

  const cursor = {
    stdout: Math.min(requestedCursor.stdout, job.stdout.length),
    stderr: Math.min(requestedCursor.stderr, job.stderr.length),
  };
  const waitMs = Math.min(Math.max(args.wait_ms ?? 0, 0), 30_000);
  await waitForChange(args.job_id, cursor, waitMs, job.status, args.output === "none");
  job = getJob(args.job_id) ?? job;

  const budget = boundedInteger(args.max_bytes, 16 * 1024, 4, 256 * 1024);
  const tail = (value: string) => {
    if (Buffer.byteLength(value) <= budget / 2) return value;
    const bytes = Buffer.from(value);
    let start = bytes.length - Math.floor(budget / 2);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  const stdout = args.output === "none" ? "" : args.output === "tail" ? tail(job.stdoutTail ?? job.stdout) : utf8Prefix(job.stdout.slice(cursor.stdout), Math.max(4, Math.floor(budget / 2)));
  const stderr = args.output === "none" ? "" : args.output === "tail" ? tail(job.stderrTail ?? job.stderr) : utf8Prefix(job.stderr.slice(cursor.stderr), budget - Buffer.byteLength(stdout));
  const nextCursor = args.output === "tail" ? { stdout: job.stdout.length, stderr: job.stderr.length } : { stdout: cursor.stdout + stdout.length, stderr: cursor.stderr + stderr.length };
  const common = {
    job_id: job.id,
    pid: job.pid,
    long_running: job.longRunning ?? false,
    project_id: job.projectId,
    status: job.status,
    exit_code: job.exitCode,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    duration_ms: job.durationMs,
    cursor: encodeCursor(nextCursor),
    stdout_truncated: job.stdoutTruncated,
    stderr_truncated: job.stderrTruncated,
    redactions: job.redactions,
    recovery_reason: job.recoveryReason,
    has_more: nextCursor.stdout < job.stdout.length || nextCursor.stderr < job.stderr.length,
    output_mode: args.output ?? "all",
  };

  const payload = args.cursor === undefined
    ? {
        ...common,
        stdout,
        stderr,
      }
    : {
        ...common,
        stdout_delta: stdout,
        stderr_delta: stderr,
      };

  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
