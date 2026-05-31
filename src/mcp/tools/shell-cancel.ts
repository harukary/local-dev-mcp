import { cancelJob } from "../../shell/job-manager.js";

export async function handleShellCancel(args: { job_id: string }) {
  if (!args?.job_id) {
    return {
      content: [{ type: "text", text: "Missing required argument: job_id" }],
      isError: true,
    };
  }

  const canceled = cancelJob(args.job_id);
  if (!canceled) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "JOB_NOT_FOUND_OR_COMPLETED",
              message: `No active job found: "${args.job_id}".`,
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
          job_id: args.job_id,
        }, null, 2),
      },
    ],
  };
}
