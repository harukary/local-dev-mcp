import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_ENV, OPTIONAL_FEATURES, isFeatureEnabled, isToolFeatureEnabled } from "../../src/features.js";
import { buildToolDefinitions, buildToolSchemaSnapshot, isClientToolEnabled } from "../../src/mcp/tool-definitions.js";

const saved = new Map(OPTIONAL_FEATURES.map(name => [FEATURE_ENV[name], process.env[FEATURE_ENV[name]]]));
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("optional feature gates", () => {
  it("defaults to ON with no configuration, and accepts common boolean values", () => {
    for (const name of OPTIONAL_FEATURES) {
      expect(isFeatureEnabled(name, {})).toBe(true);
      expect(isFeatureEnabled(name, { [FEATURE_ENV[name]]: "0" })).toBe(false);
      expect(isFeatureEnabled(name, { [FEATURE_ENV[name]]: "false" })).toBe(false);
      expect(isFeatureEnabled(name, { [FEATURE_ENV[name]]: "YES" })).toBe(true);
      expect(() => isFeatureEnabled(name, { [FEATURE_ENV[name]]: "bad" })).toThrow(FEATURE_ENV[name]);
    }
    expect(isToolFeatureEnabled("project.list", {})).toBe(true);
  });

  it("hides disabled tool families in every client and rejects stale calls", () => {
    for (const feature of OPTIONAL_FEATURES) process.env[FEATURE_ENV[feature]] = "0";
    const prefixes = ["mobile.", "computer.", "browser.", "repo.action."];
    for (const profile of ["chatgpt", "claude", "muse"] as const) {
      const names = buildToolDefinitions(profile).map(tool => tool.name);
      for (const prefix of prefixes) {
        expect(names.some(name => name.startsWith(prefix))).toBe(false);
        expect(buildToolSchemaSnapshot({ prefix }, profile).tools).toHaveLength(0);
        expect(isClientToolEnabled(profile, prefix + "status")).toBe(false);
      }
      expect(names).toContain("project.list");
      expect(names).toContain("workspace.read");
      expect(names).toContain("feedback.report");
    }
  });

  it("can toggle features independently", () => {
    for (const feature of OPTIONAL_FEATURES) delete process.env[FEATURE_ENV[feature]];
    process.env.LOCAL_DEV_MCP_FEATURE_BROWSER = "off";
    const names = buildToolDefinitions().map(tool => tool.name);
    expect(names).not.toContain("browser.start");
    expect(names).toContain("mobile.status");
    expect(names).toContain("computer.status");
    expect(names).toContain("repo.action.list");
  });
});
