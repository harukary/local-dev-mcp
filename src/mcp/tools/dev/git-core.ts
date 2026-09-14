import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "../../../types.js";
import { utf8Prefix } from "../../output.js";
import { requestSignal } from "../../request-context.js";

const execFileAsync = promisify(execFile);

export async function git(project: ProjectConfig, args: string[]) {
  return execFileAsync("git", args, {
    cwd: project.hostRoot, maxBuffer: 2 * 1024 * 1024, timeout: 30_000, signal: requestSignal(),
  });
}

export async function boundedGit(project: ProjectConfig, args: string[], maxBytes: number) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: project.hostRoot, encoding: "utf8", maxBuffer: maxBytes + 4, timeout: 30_000, signal: requestSignal(),
    });
    return { output: utf8Prefix(stdout, maxBytes), truncated: Buffer.byteLength(stdout) > maxBytes };
  } catch (error) {
    const err = error as Error & { code?: string; stdout?: string };
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && typeof err.stdout === "string") {
      return { output: utf8Prefix(err.stdout, maxBytes), truncated: true };
    }
    throw error;
  }
}
