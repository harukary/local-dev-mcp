import { spawn } from "node:child_process";
import type { ProjectConfig } from "../types.js";

const STDOUT_MAX_BYTES = 100 * 1024;
const STDERR_MAX_BYTES = 100 * 1024;

export interface ExecOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface Sandbox {
  exec(options: ExecOptions): Promise<ExecResult>;
  getCwd(): string;
  getLabel(): string;
}

function appendOutput(buf: Buffer, current: string, maxBytes: number): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf-8");
  if (currentBytes >= maxBytes) {
    return { text: "", truncated: true };
  }
  const allowed = maxBytes - currentBytes;
  const text = buf.toString("utf-8", 0, Math.min(buf.byteLength, allowed));
  return { text, truncated: buf.byteLength > allowed };
}

export class HostSandbox implements Sandbox {
  private hostRoot: string;
  private shell: string;

  constructor(config: ProjectConfig) {
    this.hostRoot = config.hostRoot;
    this.shell = config.defaultShell;
  }

  getCwd(): string {
    return this.hostRoot;
  }

  getLabel(): string {
    return `host:${this.hostRoot}`;
  }

  async exec(options: ExecOptions): Promise<ExecResult> {
    const start = Date.now();
    const timeout = options.timeoutMs ?? 30_000;
    const workdir = options.cwd || this.hostRoot;

    return new Promise((resolve) => {
      const child = spawn(this.shell, ["-lc", options.command], {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* ignore */ }
        }, 5000);
      }, timeout);

      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;

      child.stdout?.on("data", (data: Buffer) => {
        const result = appendOutput(data, stdout, STDOUT_MAX_BYTES);
        stdout += result.text;
        if (result.truncated) stdoutTruncated = true;
      });

      child.stderr?.on("data", (data: Buffer) => {
        const result = appendOutput(data, stderr, STDERR_MAX_BYTES);
        stderr += result.text;
        if (result.truncated) stderrTruncated = true;
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - start,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          stdout,
          stderr: `Sandbox error: ${err.message}`,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - start,
        });
      });
    });
  }
}

export function createSandbox(config: ProjectConfig): Sandbox {
  if (config.sandboxType === "host") {
    return new HostSandbox(config);
  }
  throw new Error(`Unknown sandbox type: ${config.sandboxType}`);
}
