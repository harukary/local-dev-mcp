import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";

const script = resolve("scripts/setup.mjs");
const tmp = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-dev-mcp-setup-"));
  tmp.push(dir);
  return dir;
}
afterEach(() => { for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(dir, args = []) {
  return execFileSync(process.execPath, [script, ...args, "--yes"], { cwd: dir, encoding: "utf8", env: { ...process.env } });
}

describe("pnpm setup", () => {
  it("creates a project registry and enables all four optional features by default", () => {
    const dir = fixture();
    run(dir);
    const data = yaml.load(readFileSync(join(dir, "config/projects.local.yaml"), "utf8"));
    expect(Object.keys(data.projects)).toEqual([dir.split("/").at(-1)]);
    const project = Object.values(data.projects)[0];
    expect(project.host_root).toBe(realpathSync(dir));
    expect(project.write_policy).toBe("confirm");
    const env = readFileSync(join(dir, ".env"), "utf8");
    for (const name of ["MOBILE", "COMPUTER", "BROWSER", "REPO_ACTIONS"]) {
      expect(env).toContain(`LOCAL_DEV_MCP_FEATURE_${name}=1`);
    }
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "config/projects.local.yaml")).mode & 0o777).toBe(0o600);
  });

  it("retains existing secrets and project registry while toggling selected features", () => {
    const dir = fixture();
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config/projects.local.yaml"), "projects:\n  my-project: {}\n");
    writeFileSync(join(dir, ".env"), "MY_SECRET=should-remain-unchanged\nLOCAL_DEV_MCP_FEATURE_BROWSER=0\n");
    run(dir, ["--disable", "mobile,repo-actions"]);
    let env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("MY_SECRET=should-remain-unchanged");
    expect(env).toContain("LOCAL_DEV_MCP_FEATURE_MOBILE=0");
    expect(env).toContain("LOCAL_DEV_MCP_FEATURE_BROWSER=0");
    expect(env).toContain("LOCAL_DEV_MCP_FEATURE_REPO_ACTIONS=0");
    run(dir, ["--enable", "browser,mobile"]);
    env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("LOCAL_DEV_MCP_FEATURE_BROWSER=1");
    expect(env).toContain("LOCAL_DEV_MCP_FEATURE_MOBILE=1");
    expect(env.match(/LOCAL_DEV_MCP_FEATURE_BROWSER=/g)).toHaveLength(1);
    expect(readFileSync(join(dir, "config/projects.local.yaml"), "utf8")).toBe("projects:\n  my-project: {}\n");
  });

  it("rejects invalid names before touching the filesystem", () => {
    const dir = fixture();
    const result = spawnSync(process.execPath, [script, "--disable", "invented", "--yes"], { cwd: dir, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown optional feature");
  });
});
