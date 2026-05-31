import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "../../../types.js";

const execFileAsync = promisify(execFile);
const DIFF_MAX_BYTES = 512 * 1024;

export async function git(project: ProjectConfig, args: string[], input?: string) {
  if (input === undefined) {
    return execFileAsync("git", args, {
      cwd: project.hostRoot,
      maxBuffer: 2 * 1024 * 1024,
    });
  }

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: project.hostRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(stderr || `git exited with code ${code}`) as Error & { stdout?: string; stderr?: string; code?: number | null };
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function gitDiffForPaths(project: ProjectConfig, paths: string[]) {
  if (paths.length === 0) return { diff: "", truncated: false };
  try {
    const { stdout } = await git(project, ["diff", "--", ...paths]);
    return {
      diff: stdout.length > DIFF_MAX_BYTES ? `${stdout.slice(0, DIFF_MAX_BYTES)}\n[truncated]` : stdout,
      truncated: stdout.length > DIFF_MAX_BYTES,
    };
  } catch {
    return { diff: "", truncated: false };
  }
}
