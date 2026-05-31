import type { ShellRunInput, ShellRunResult, ProjectConfig } from "../types.js";
import { createSandbox, type Sandbox } from "./sandbox.js";
import { classifyRisk } from "./risk-classifier.js";
import { redactOutput } from "./redactor.js";

export class ShellRunner {
  private sandboxCache: Map<string, Sandbox> = new Map();

  getSandbox(config: ProjectConfig): Sandbox {
    const key = `${config.sandboxType}:${config.projectId}`;
    let sandbox = this.sandboxCache.get(key);
    if (!sandbox) {
      sandbox = createSandbox(config);
      this.sandboxCache.set(key, sandbox);
    }
    return sandbox;
  }

  clearCache(): void {
    this.sandboxCache.clear();
  }

  async run(
    project: ProjectConfig,
    input: ShellRunInput,
    chatContextId: string
  ): Promise<ShellRunResult> {
    const timeoutMs = Math.min(
      (input.timeoutSeconds ?? project.defaultTimeoutSeconds) * 1000,
      project.maxTimeoutSeconds * 1000
    );

    const risk = classifyRisk(input.command, project.deniedPaths);

    const sandbox = this.getSandbox(project);
    const execResult = await sandbox.exec({
      command: input.command,
      timeoutMs,
    });

    const redactedStdout = redactOutput(execResult.stdout, project.redactionProfile);
    const redactedStderr = redactOutput(execResult.stderr, project.redactionProfile);

    const allRedactions = [...redactedStdout.redactions, ...redactedStderr.redactions];
    const mergedRedactions = mergeRedactions(allRedactions);

    const result: ShellRunResult = {
      projectId: project.projectId,
      cwd: sandbox.getCwd(),
      command: input.command,
      purpose: input.purpose,
      riskLevel: risk.level,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      stdout: redactedStdout.text,
      stderr: redactedStderr.text,
      stdoutTruncated: execResult.stdoutTruncated,
      stderrTruncated: execResult.stderrTruncated,
      redactions: mergedRedactions,
    };

    return result;
  }
}

function mergeRedactions(items: Array<{ type: string; count: number }>): Array<{ type: string; count: number }> {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.type, (map.get(item.type) ?? 0) + item.count);
  }
  return Array.from(map.entries()).map(([type, count]) => ({ type, count }));
}
