import { getJob } from "../../shell/job-manager.js";

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
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }, null, 2) }],
    isError: true,
  };
}

function hasChanged(jobId: string, cursor: OutputCursor, initialStatus: string): boolean {
  const job = getJob(jobId);
  if (!job) return true;
  return job.stdout.length > cursor.stdout || job.stderr.length > cursor.stderr || job.status !== initialStatus;
}

async function waitForChange(jobId: string, cursor: OutputCursor, waitMs: number, initialStatus: string): Promise<void> {
  if (waitMs <= 0 || initialStatus !== "running") return;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (hasChanged(jobId, cursor, initialStatus)) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(10, deadline - Date.now()))));
  }
}

export async function handleShellStatus(args: { job_id: string; cursor?: string; wait_ms?: number }) {
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
  await waitForChange(args.job_id, cursor, waitMs, job.status);
  job = getJob(args.job_id) ?? job;

  const nextCursor = { stdout: job.stdout.length, stderr: job.stderr.length };
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
  };

  const payload = args.cursor === undefined
    ? {
        ...common,
        command: job.command,
        purpose: job.purpose,
        stdout: job.stdout,
        stderr: job.stderr,
      }
    : {
        ...common,
        stdout_delta: job.stdout.slice(cursor.stdout),
        stderr_delta: job.stderr.slice(cursor.stderr),
      };

  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
