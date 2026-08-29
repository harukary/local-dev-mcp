import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLiveAuthProbeConfiguration, loadLiveAuthProbes, runLiveAuthProbes } from "../../src/browser/auth-probes.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("browser live auth probes", () => {
  it("loads only explicit allowlisted probe contracts", async () => {
    root = await mkdtemp(join(tmpdir(), "browser-probes-"));
    const path = join(root, "probes.yaml");
    await writeFile(path, `probes:\n  - id: github\n    version: 2\n    url: https://github.com/settings/profile\n    authenticated_host: github.com\n    authenticated_selector: '[data-login]'\n    signed_out_selector: 'a[href="/login"]'\n    principal_selector: '[data-login]'\n    ttl_hours: 12\n`);
    expect(await loadLiveAuthProbes(path)).toMatchObject([{
      id: "github", version: 2, authenticatedSelector: "[data-login]", principalSelector: "[data-login]", ttlHours: 12,
    }]);
  });

  it("turns probe failures into unknown claims without inventing login state", async () => {
    const claims = await runLiveAuthProbes([{
      id: "github", version: 1, url: "https://github.com/", authenticatedHost: "github.com", authenticatedSelector: "x", principalSelector: "y", timeoutMs: 1000, ttlHours: 24,
    }], async () => { throw new Error("network"); }, new Date("2026-08-29T00:00:00.000Z"));
    expect(claims).toEqual([expect.objectContaining({ probeId: "github", status: "unknown" })]);
    expect(claims[0]).not.toHaveProperty("principal");
  });

  it("reports missing and empty configuration explicitly", async () => {
    root = await mkdtemp(join(tmpdir(), "browser-probes-status-"));
    await expect(loadLiveAuthProbeConfiguration(join(root, "missing.yaml"))).resolves.toEqual({ status: "missing", probes: [] });
    const path = join(root, "empty.yaml");
    await writeFile(path, "probes: []\n");
    await expect(loadLiveAuthProbeConfiguration(path)).resolves.toEqual({ status: "empty", probes: [] });
  });

  it("ships a non-empty Google auth probe", async () => {
    const config = await loadLiveAuthProbeConfiguration(join(process.cwd(), "config", "browser-auth-probes.yaml"));
    expect(config.status).toBe("ready");
    expect(config.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "google", authenticatedSelector: 'a[href*="SignOutOptions"]' }),
    ]));
  });
});
