import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ToolUsageCounter = {
  calls: number;
  failures: number;
  total_duration_ms: number;
  max_duration_ms: number;
  last_called_at: string;
};

export type ProjectUsageCounter = {
  calls: number;
  failures: number;
  tools: Record<string, number>;
};

export type ToolUsageSnapshot = {
  version: 1;
  period_started_at: string;
  updated_at: string;
  totals: ToolUsageCounter;
  tools: Record<string, ToolUsageCounter>;
  projects: Record<string, ProjectUsageCounter>;
  ratios: {
    shell_run_share: number;
  };
};

type PersistedToolUsage = Omit<ToolUsageSnapshot, "ratios"> & { ratios?: ToolUsageSnapshot["ratios"] };

function emptyCounter(now: string): ToolUsageCounter {
  return { calls: 0, failures: 0, total_duration_ms: 0, max_duration_ms: 0, last_called_at: now };
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function shellRunShare(calls: number, shellCalls: number): number {
  if (calls <= 0) return 0;
  return Number((shellCalls / calls).toFixed(6));
}

export class ToolUsageMetrics {
  private readonly path: string;
  private readonly flushEvery: number;
  private readonly flushIntervalMs: number;
  private data: PersistedToolUsage;
  private dirtyCalls = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(path: string, options: { flush_every?: number; flush_interval_ms?: number } = {}) {
    this.path = path;
    this.flushEvery = Math.max(1, options.flush_every ?? 100);
    this.flushIntervalMs = Math.max(100, options.flush_interval_ms ?? 30_000);
    mkdirSync(dirname(path), { recursive: true });
    this.data = this.load();
  }

  record(input: { tool: string; project_id?: string; duration_ms: number; failed?: boolean }): void {
    const now = new Date().toISOString();
    const duration = normalizeDuration(input.duration_ms);
    const failed = input.failed === true;
    this.bump(this.data.totals, duration, failed, now);

    const tool = this.data.tools[input.tool] ?? emptyCounter(now);
    this.bump(tool, duration, failed, now);
    this.data.tools[input.tool] = tool;

    const projectId = input.project_id?.trim() || "(none)";
    const project = this.data.projects[projectId] ?? { calls: 0, failures: 0, tools: {} };
    project.calls += 1;
    if (failed) project.failures += 1;
    project.tools[input.tool] = (project.tools[input.tool] ?? 0) + 1;
    this.data.projects[projectId] = project;

    this.data.updated_at = now;
    this.dirtyCalls += 1;
    if (this.dirtyCalls >= this.flushEvery) this.flush();
    else this.scheduleFlush();
  }

  snapshot(): ToolUsageSnapshot {
    const copy = JSON.parse(JSON.stringify(this.data)) as PersistedToolUsage;
    return {
      ...copy,
      ratios: {
        shell_run_share: shellRunShare(copy.totals.calls, copy.tools["shell.run"]?.calls ?? 0),
      },
    };
  }

  flush(): void {
    if (this.dirtyCalls === 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const snapshot = this.snapshot();
    const tempPath = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.path);
    this.dirtyCalls = 0;
  }

  private bump(counter: ToolUsageCounter, duration: number, failed: boolean, now: string): void {
    counter.calls += 1;
    if (failed) counter.failures += 1;
    counter.total_duration_ms += duration;
    counter.max_duration_ms = Math.max(counter.max_duration_ms, duration);
    counter.last_called_at = now;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private load(): PersistedToolUsage {
    const now = new Date().toISOString();
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as PersistedToolUsage;
        if (parsed.version === 1 && parsed.totals && parsed.tools && parsed.projects) {
          return {
            version: 1,
            period_started_at: parsed.period_started_at || now,
            updated_at: parsed.updated_at || now,
            totals: parsed.totals,
            tools: parsed.tools,
            projects: parsed.projects,
          };
        }
      } catch {
        // Start a new aggregate if the compact metrics file is missing or corrupt.
      }
    }
    return {
      version: 1,
      period_started_at: now,
      updated_at: now,
      totals: emptyCounter(now),
      tools: {},
      projects: {},
    };
  }
}
