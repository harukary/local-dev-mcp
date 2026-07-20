import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFileIfExists } from "../../src/env.js";

describe("loadEnvFileIfExists", () => {
  it("loads missing process env values without overwriting existing values", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-dev-mcp-env-"));
    const path = join(dir, ".env");
    const previousLoaded = process.env.LOCAL_DEV_MCP_TEST_LOADED;
    const previousExisting = process.env.LOCAL_DEV_MCP_TEST_EXISTING;
    try {
      process.env.LOCAL_DEV_MCP_TEST_EXISTING = "from-shell";
      delete process.env.LOCAL_DEV_MCP_TEST_LOADED;
      writeFileSync(path, [
        "LOCAL_DEV_MCP_TEST_LOADED=\"from file\"",
        "LOCAL_DEV_MCP_TEST_EXISTING=from-file",
        "# comment",
        "",
      ].join("\n"));

      const result = loadEnvFileIfExists(path);

      expect(result).toMatchObject({ path, loaded: true });
      expect(result.keys).toEqual(["LOCAL_DEV_MCP_TEST_LOADED"]);
      expect(process.env.LOCAL_DEV_MCP_TEST_LOADED).toBe("from file");
      expect(process.env.LOCAL_DEV_MCP_TEST_EXISTING).toBe("from-shell");
    } finally {
      if (previousLoaded === undefined) {
        delete process.env.LOCAL_DEV_MCP_TEST_LOADED;
      } else {
        process.env.LOCAL_DEV_MCP_TEST_LOADED = previousLoaded;
      }
      if (previousExisting === undefined) {
        delete process.env.LOCAL_DEV_MCP_TEST_EXISTING;
      } else {
        process.env.LOCAL_DEV_MCP_TEST_EXISTING = previousExisting;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing env files without throwing", () => {
    const result = loadEnvFileIfExists("/path/that/does/not/exist/.env");
    expect(result.loaded).toBe(false);
    expect(result.keys).toEqual([]);
  });
});
