import { cancelJob, cancelJobByPid } from "../../shell/job-manager.js";

export async function handleShellCancel(args: { job_id?: string; pid?: number }) {
  if (!args?.job_id && args?.pid === undefined) {
    return {
      content: [{ type: "text", text: "Missing required argument: job_id or pid" }],
      isError: true,
    };
  }

  const matchedJob = args.job_id ? undefined : cancelJobByPid(args.pid!);
  const canceled = args.job_id ? cancelJob(args.job_id) : matchedJob !== undefined;
  const jobId = args.job_id ?? matchedJob?.id;
  if (!canceled || !jobId) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "JOB_NOT_FOUND_OR_COMPLETED",
              message: args.job_id ? `No active job found: "${args.job_id}".` : `No active managed job found for pid: ${args.pid}.`,
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
          canceled: true,
          job_id: jobId,
          pid: args.pid ?? matchedJob?.pid,
        }, null, 2),
      },
    ],
  };
}
