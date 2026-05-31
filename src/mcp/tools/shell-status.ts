import { getJob } from "../../shell/job-manager.js";

export async function handleShellStatus(args: { job_id: string }) {
  if (!args?.job_id) {
    return {
      content: [{ type: "text", text: "Missing required argument: job_id" }],
      isError: true,
    };
  }

  const job = getJob(args.job_id);
  if (!job) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "JOB_NOT_FOUND",
              message: `No job found: "${args.job_id}". Completed jobs are persisted for seven days when available.`,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          job_id: job.id,
          project_id: job.projectId,
          command: job.command,
          purpose: job.purpose,
          status: job.status,
          exit_code: job.exitCode,
          started_at: job.startedAt,
          finished_at: job.finishedAt,
          duration_ms: job.durationMs,
          stdout: job.stdout,
          stderr: job.stderr,
          stdout_truncated: job.stdoutTruncated,
          stderr_truncated: job.stderrTruncated,
          redactions: job.redactions,
        }, null, 2),
      },
    ],
  };
}
