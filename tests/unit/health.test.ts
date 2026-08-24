import { describe, expect, it } from "vitest";
import { buildHealthStatus } from "../../src/mcp/server.js";

describe("HTTP health status", () => {
  it("returns a stable server identity and process uptime", () => {
    const first = buildHealthStatus();
    const second = buildHealthStatus();

    expect(first.ok).toBe(true);
    expect(first.instance_id).toBe(second.instance_id);
    expect(first.instance_id.length).toBeGreaterThan(10);
    expect(Number.isNaN(Date.parse(first.started_at))).toBe(false);
    expect(first.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(second.uptime_seconds).toBeGreaterThanOrEqual(first.uptime_seconds);
  });
});
