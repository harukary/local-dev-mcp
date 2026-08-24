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
