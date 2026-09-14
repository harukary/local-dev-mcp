import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolUsageMetrics } from "../../src/metrics/tool-usage.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("ToolUsageMetrics", () => {
  it("separates newly measured byte and histogram samples from historical counts", () => {
    root = mkdtempSync(join(tmpdir(), "local-dev-mcp-usage-"));
    const metrics = new ToolUsageMetrics(join(root, "metrics.json"), { flush_every: 1 });
    metrics.record({ tool: "workspace.read", duration_ms: 20 });
    metrics.record({ tool: "workspace.read", duration_ms: 51, failed: true, response_bytes: 120, request_bytes: 18, structured_response_bytes: 45, text_response_bytes: 45, error_code: "READ_FAILED" });
    expect(metrics.snapshot().totals).toMatchObject({ calls: 2, measurements: { calls: 1, response_bytes: 120, max_response_bytes: 120, request_bytes: 18, structured_response_bytes: 45, text_response_bytes: 45, duration_buckets_ms: { "100": 1 }, error_codes: { READ_FAILED: 1 } } });
  });
  it("aggregates tool/project counts without recording arguments or output", () => {
    root = mkdtempSync(join(tmpdir(), "local-dev-mcp-usage-"));
    const path = join(root, "tool-usage.json");
    const metrics = new ToolUsageMetrics(path, { flush_every: 2, flush_interval_ms: 60_000 });

    metrics.record({ tool: "workspace.search", project_id: "alpha", duration_ms: 12.4 });
    metrics.record({ tool: "shell.run", project_id: "alpha", duration_ms: 40.2, failed: true });

    const snapshot = metrics.snapshot();
    expect(snapshot.totals).toMatchObject({ calls: 2, failures: 1, total_duration_ms: 52, max_duration_ms: 40 });
    expect(snapshot.tools["workspace.search"].calls).toBe(1);
    expect(snapshot.tools["shell.run"].failures).toBe(1);
    expect(snapshot.projects.alpha.tools).toEqual({ "workspace.search": 1, "shell.run": 1 });
    expect(snapshot.ratios.shell_run_share).toBe(0.5);

    const persisted = readFileSync(path, "utf8");
    expect(persisted).toContain('"workspace.search"');
    expect(persisted).not.toContain("query");
    expect(persisted).not.toContain("stdout");
  });

  it("returns a compact default view and supports project/prefix narrowing", () => {
    root = mkdtempSync(join(tmpdir(), "local-dev-mcp-usage-"));
    const metrics = new ToolUsageMetrics(join(root, "metrics.json"), { flush_every: 10 });
    metrics.record({ tool: "workspace.read", project_id: "alpha", duration_ms: 10, response_bytes: 100, request_bytes: 10, structured_response_bytes: 30, text_response_bytes: 30 });
    metrics.record({ tool: "workspace.search", project_id: "alpha", duration_ms: 20, response_bytes: 200, request_bytes: 20, structured_response_bytes: 60, text_response_bytes: 60 });
    metrics.record({ tool: "shell.run", project_id: "beta", duration_ms: 30, response_bytes: 50 });

    const summary = metrics.view({ prefix: "workspace.", limit: 1 }) as { detail: string; tools: Array<{ name: string }>; matching_tools: number; truncated: boolean };
    expect(summary.detail).toBe("summary");
    expect(summary.matching_tools).toBe(2);
    expect(summary.truncated).toBe(true);
    expect(summary.tools).toHaveLength(1);
    expect(summary.tools[0].name.startsWith("workspace.")).toBe(true);

    const project = metrics.view({ project_id: "alpha" }) as { totals: { calls: number }; tools: Array<{ name: string; calls: number }>; ratios: { shell_run_share: number } };
    expect(project.totals.calls).toBe(2);
    expect(project.tools).toEqual(expect.arrayContaining([{ name: "workspace.read", calls: 1 }, { name: "workspace.search", calls: 1 }]));
    expect(project.ratios.shell_run_share).toBe(0);

    const recent = metrics.view({ project_id: "alpha", recent_days: 7 }) as { window: { timezone: string; recent_days: number }; totals: { calls: number; response_bytes: number }; tools: Array<{ name: string; calls: number; response_bytes: number }> };
    expect(recent.window).toMatchObject({ timezone: "UTC", recent_days: 7 });
    expect(recent.totals).toMatchObject({ calls: 2, response_bytes: 300 });
    expect(recent.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "workspace.read", calls: 1, response_bytes: 100 }),
      expect.objectContaining({ name: "workspace.search", calls: 1, response_bytes: 200 }),
    ]));

    const missing = metrics.view({ project_id: "missing" }) as { scope: { found: boolean }; totals: { calls: number }; tools: unknown[] };
    expect(missing.scope.found).toBe(false);
    expect(missing.totals.calls).toBe(0);
    expect(missing.tools).toEqual([]);

    expect(metrics.view({ detail: "full" })).toHaveProperty("projects.alpha");
  });

  it("loads and continues a previous aggregate", () => {
    root = mkdtempSync(join(tmpdir(), "local-dev-mcp-usage-"));
    const path = join(root, "tool-usage.json");
    const first = new ToolUsageMetrics(path, { flush_every: 1 });
    first.record({ tool: "git.inspect", project_id: "alpha", duration_ms: 10 });

    const second = new ToolUsageMetrics(path, { flush_every: 1 });
    second.record({ tool: "git.inspect", project_id: "alpha", duration_ms: 20 });

    expect(second.snapshot().tools["git.inspect"]).toMatchObject({ calls: 2, total_duration_ms: 30, max_duration_ms: 20 });
  });
});
