import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ToolUsageCounter = {
  calls: number;
  failures: number;
  total_duration_ms: number;
  max_duration_ms: number;
  last_called_at: string;
  measurements?: {
    started_at: string;
    calls: number;
    response_bytes: number;
    max_response_bytes: number;
    request_bytes?: number;
    structured_response_bytes?: number;
    text_response_bytes?: number;
    duration_buckets_ms: Record<string, number>;
    error_codes: Record<string, number>;
  };
};

export type ProjectUsageCounter = {
  calls: number;
  failures: number;
  tools: Record<string, number>;
};

type WindowCounter = {
  calls: number;
  failures: number;
  total_duration_ms: number;
  response_bytes: number;
  request_bytes: number;
  structured_response_bytes: number;
  text_response_bytes: number;
  error_codes: Record<string, number>;
};

type DailyUsageBucket = {
  totals: WindowCounter;
  tools: Record<string, WindowCounter>;
  projects: Record<string, { totals: WindowCounter; tools: Record<string, WindowCounter> }>;
};

export type ToolUsageSnapshot = {
  version: 1;
  period_started_at: string;
  updated_at: string;
  runtime?: { run_id: string; started_at: string; build_id: string | null };
  totals: ToolUsageCounter;
  tools: Record<string, ToolUsageCounter>;
  projects: Record<string, ProjectUsageCounter>;
  daily?: Record<string, DailyUsageBucket>;
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

function emptyWindowCounter(): WindowCounter {
  return { calls: 0, failures: 0, total_duration_ms: 0, response_bytes: 0, request_bytes: 0, structured_response_bytes: 0, text_response_bytes: 0, error_codes: {} };
}

function bumpWindowCounter(counter: WindowCounter, input: { duration: number; failed: boolean; response_bytes?: number; request_bytes?: number; structured_response_bytes?: number; text_response_bytes?: number; error_code?: string }): void {
  counter.calls++;
  if (input.failed) counter.failures++;
  counter.total_duration_ms += input.duration;
  counter.response_bytes += normalizeDuration(input.response_bytes ?? 0);
  counter.request_bytes += normalizeDuration(input.request_bytes ?? 0);
  counter.structured_response_bytes += normalizeDuration(input.structured_response_bytes ?? 0);
  counter.text_response_bytes += normalizeDuration(input.text_response_bytes ?? 0);
  if (input.error_code) counter.error_codes[input.error_code] = (counter.error_codes[input.error_code] ?? 0) + 1;
}

function mergeWindowCounter(target: WindowCounter, source: WindowCounter): void {
  target.calls += source.calls;
  target.failures += source.failures;
  target.total_duration_ms += source.total_duration_ms;
  target.response_bytes += source.response_bytes;
  target.request_bytes += source.request_bytes;
  target.structured_response_bytes += source.structured_response_bytes;
  target.text_response_bytes += source.text_response_bytes;
  for (const [code, count] of Object.entries(source.error_codes)) target.error_codes[code] = (target.error_codes[code] ?? 0) + count;
}

function windowToolSummary(name: string, counter: WindowCounter) {
  return {
    name,
    calls: counter.calls,
    failures: counter.failures,
    failure_rate: counter.calls ? Number((counter.failures / counter.calls).toFixed(4)) : 0,
    avg_duration_ms: counter.calls ? Math.round(counter.total_duration_ms / counter.calls) : 0,
    response_bytes: counter.response_bytes,
    avg_response_bytes: counter.calls ? Math.round(counter.response_bytes / counter.calls) : 0,
    request_bytes: counter.request_bytes,
    structured_response_bytes: counter.structured_response_bytes,
    text_response_bytes: counter.text_response_bytes,
    error_codes: counter.error_codes,
  };
}

export class ToolUsageMetrics {
  private readonly runtime = { run_id: randomUUID(), started_at: new Date().toISOString(), build_id: process.env.LOCAL_DEV_MCP_BUILD_ID?.trim() || null };
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

  record(input: { tool: string; project_id?: string; duration_ms: number; failed?: boolean; response_bytes?: number; request_bytes?: number; structured_response_bytes?: number; text_response_bytes?: number; error_code?: string }): void {
    const now = new Date().toISOString();
    const duration = normalizeDuration(input.duration_ms);
    const failed = input.failed === true;
    this.bump(this.data.totals, duration, failed, now);

    const tool = this.data.tools[input.tool] ?? emptyCounter(now);
    this.bump(tool, duration, failed, now);
    this.data.tools[input.tool] = tool;
    if (input.response_bytes !== undefined) {
      for (const counter of [this.data.totals, tool]) {
        const measures = counter.measurements ??= { started_at: now, calls: 0, response_bytes: 0, max_response_bytes: 0, request_bytes: 0, structured_response_bytes: 0, text_response_bytes: 0, duration_buckets_ms: {}, error_codes: {} };
        const bytes = normalizeDuration(input.response_bytes);
        measures.calls++;
        measures.response_bytes += bytes;
        measures.max_response_bytes = Math.max(measures.max_response_bytes, bytes);
        measures.request_bytes = (measures.request_bytes ?? 0) + normalizeDuration(input.request_bytes ?? 0);
        measures.structured_response_bytes = (measures.structured_response_bytes ?? 0) + normalizeDuration(input.structured_response_bytes ?? 0);
        measures.text_response_bytes = (measures.text_response_bytes ?? 0) + normalizeDuration(input.text_response_bytes ?? 0);
        const bucket = String([10, 50, 100, 500, 1000, 5000, 15000, 30000, 60000, 240000].find(bound => duration <= bound) ?? "over_240000");
        measures.duration_buckets_ms[bucket] = (measures.duration_buckets_ms[bucket] ?? 0) + 1;
        if (input.error_code) measures.error_codes[input.error_code] = (measures.error_codes[input.error_code] ?? 0) + 1;
      }
    }

    const projectId = input.project_id?.trim() || "(none)";
    const project = this.data.projects[projectId] ?? { calls: 0, failures: 0, tools: {} };
    project.calls += 1;
    if (failed) project.failures += 1;
    project.tools[input.tool] = (project.tools[input.tool] ?? 0) + 1;
    this.data.projects[projectId] = project;

    const day = now.slice(0, 10);
    const daily = this.data.daily ??= {};
    const bucket = daily[day] ??= { totals: emptyWindowCounter(), tools: {}, projects: {} };
    const windowInput = { duration, failed, response_bytes: input.response_bytes, request_bytes: input.request_bytes, structured_response_bytes: input.structured_response_bytes, text_response_bytes: input.text_response_bytes, error_code: input.error_code };
    bumpWindowCounter(bucket.totals, windowInput);
    const dailyTool = bucket.tools[input.tool] ??= emptyWindowCounter();
    bumpWindowCounter(dailyTool, windowInput);
    const dailyProject = bucket.projects[projectId] ??= { totals: emptyWindowCounter(), tools: {} };
    bumpWindowCounter(dailyProject.totals, windowInput);
    const dailyProjectTool = dailyProject.tools[input.tool] ??= emptyWindowCounter();
    bumpWindowCounter(dailyProjectTool, windowInput);
    const days = Object.keys(daily).sort();
    for (const stale of days.slice(0, Math.max(0, days.length - 31))) delete daily[stale];

    this.data.updated_at = now;
    this.dirtyCalls += 1;
    if (this.dirtyCalls >= this.flushEvery) this.flush();
    else this.scheduleFlush();
  }

  snapshot(): ToolUsageSnapshot {
    const copy = JSON.parse(JSON.stringify(this.data)) as PersistedToolUsage;
    return {
      ...copy,
      runtime: this.runtime,
      ratios: {
        shell_run_share: shellRunShare(copy.totals.calls, copy.tools["shell.run"]?.calls ?? 0),
      },
    };
  }

  view(options: { detail?: "summary" | "full"; project_id?: string; prefix?: string; limit?: number; recent_days?: number } = {}) {
    const snapshot = this.snapshot();
    if (options.detail === "full") return snapshot;
    const projectId = options.project_id?.trim();
    const project = projectId ? snapshot.projects[projectId] : undefined;
    const prefix = options.prefix?.trim() || "";
    const limit = Math.min(200, Math.max(1, options.limit ?? 30));
    if (options.recent_days !== undefined) {
      const recentDays = Math.min(31, Math.max(1, Math.floor(options.recent_days)));
      const today = new Date().toISOString().slice(0, 10);
      const cutoffDate = new Date(`${today}T00:00:00.000Z`);
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - recentDays + 1);
      const fromDay = cutoffDate.toISOString().slice(0, 10);
      const selectedDays = Object.keys(snapshot.daily ?? {}).filter(day => day >= fromDay && day <= today).sort();
      const totals = emptyWindowCounter();
      const toolCounters: Record<string, WindowCounter> = {};
      for (const day of selectedDays) {
        const bucket = snapshot.daily![day];
        const sourceTotals = projectId ? bucket.projects[projectId]?.totals : bucket.totals;
        if (sourceTotals) mergeWindowCounter(totals, sourceTotals);
        const sourceTools = projectId ? bucket.projects[projectId]?.tools ?? {} : bucket.tools;
        for (const [name, counter] of Object.entries(sourceTools)) {
          if (prefix && !name.startsWith(prefix)) continue;
          mergeWindowCounter(toolCounters[name] ??= emptyWindowCounter(), counter);
        }
      }
      const names = Object.keys(toolCounters).sort((a, b) => toolCounters[b].calls - toolCounters[a].calls || a.localeCompare(b));
      return {
        version: snapshot.version,
        period_started_at: snapshot.period_started_at,
        updated_at: snapshot.updated_at,
        runtime: snapshot.runtime,
        detail: "summary" as const,
        window: { recent_days: recentDays, timezone: "UTC", from_day: fromDay, to_day: today, available_days: selectedDays },
        scope: projectId ? { project_id: projectId, found: Boolean(project) } : { project_id: null, found: true },
        filter: prefix ? { prefix } : null,
        totals: windowToolSummary("(total)", totals),
        tools: names.slice(0, limit).map(name => windowToolSummary(name, toolCounters[name])),
        matching_tools: names.length,
        truncated: names.length > limit,
        ratios: { shell_run_share: shellRunShare(totals.calls, toolCounters["shell.run"]?.calls ?? 0) },
      };
    }
    const names = (projectId ? Object.keys(project?.tools ?? {}) : Object.keys(snapshot.tools))
      .filter((name) => !prefix || name.startsWith(prefix))
      .sort((a, b) => {
        const callsA = project ? project.tools[a] ?? 0 : snapshot.tools[a]?.calls ?? 0;
        const callsB = project ? project.tools[b] ?? 0 : snapshot.tools[b]?.calls ?? 0;
        return callsB - callsA || a.localeCompare(b);
      });
    const tools = names.slice(0, limit).map((name) => {
      if (project) return { name, calls: project.tools[name] ?? 0 };
      const counter = snapshot.tools[name];
      const measured = counter.measurements;
      return {
        name,
        calls: counter.calls,
        failures: counter.failures,
        failure_rate: counter.calls ? Number((counter.failures / counter.calls).toFixed(4)) : 0,
        avg_duration_ms: counter.calls ? Math.round(counter.total_duration_ms / counter.calls) : 0,
        response_bytes: measured?.response_bytes ?? 0,
        avg_response_bytes: measured?.calls ? Math.round(measured.response_bytes / measured.calls) : 0,
        request_bytes: measured?.request_bytes ?? 0,
        structured_response_bytes: measured?.structured_response_bytes ?? 0,
        text_response_bytes: measured?.text_response_bytes ?? 0,
      };
    });
    return {
      version: snapshot.version,
      period_started_at: snapshot.period_started_at,
      updated_at: snapshot.updated_at,
      runtime: snapshot.runtime,
      detail: "summary" as const,
      scope: projectId ? { project_id: projectId, found: Boolean(project) } : { project_id: null, found: true },
      filter: prefix ? { prefix } : null,
      totals: projectId ? { calls: project?.calls ?? 0, failures: project?.failures ?? 0 } : {
        calls: snapshot.totals.calls,
        failures: snapshot.totals.failures,
        measurements: snapshot.totals.measurements ? {
          started_at: snapshot.totals.measurements.started_at,
          calls: snapshot.totals.measurements.calls,
          response_bytes: snapshot.totals.measurements.response_bytes,
          request_bytes: snapshot.totals.measurements.request_bytes ?? 0,
          structured_response_bytes: snapshot.totals.measurements.structured_response_bytes ?? 0,
          text_response_bytes: snapshot.totals.measurements.text_response_bytes ?? 0,
        } : undefined,
      },
      tools,
      matching_tools: names.length,
      truncated: names.length > limit,
      ratios: { shell_run_share: projectId ? shellRunShare(project?.calls ?? 0, project?.tools["shell.run"] ?? 0) : snapshot.ratios.shell_run_share },
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
            daily: parsed.daily ?? {},
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
      daily: {},
    };
  }
}
