import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("launchd installer", () => {
  it("generates canonical server and Secure MCP Tunnel LaunchAgents", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-launchd-"));
    tempDirs.push(tempDir);
    const labelPrefix = "test.local-dev-mcp";

    const result = spawnSync("/bin/bash", [path.resolve("scripts/install-launchd.sh"), "--install-only"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR: tempDir,
        LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX: labelPrefix,
        PORT: "13461",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const server = readFileSync(path.join(tempDir, `${labelPrefix}.server.plist`), "utf8");
    const tunnel = readFileSync(path.join(tempDir, `${labelPrefix}.openai-tunnel.plist`), "utf8");

    expect(server).toContain("scripts/server.sh");
    expect(server).toContain("logs/mcp-server.log");
    expect(tunnel).toContain("scripts/tunnel.sh");
    expect(tunnel).toContain("logs/openai-tunnel.log");
    expect(server).toContain("<key>PORT</key>");
    expect(server).toContain("<string>13461</string>");
    expect(tunnel).toContain("<key>PORT</key>");
    expect(tunnel).toContain("<string>13461</string>");
    expect(server).toContain("run-with-rotating-log.mjs");
    expect(tunnel).toContain("run-with-rotating-log.mjs");
    expect(tunnel).not.toContain("CONTROL_PLANE_API_KEY");
    expect(tunnel).not.toContain("OPENAI_TUNNEL_TOKEN");
    expect(server).toContain("<key>ExitTimeOut</key>");
    expect(server).toContain("<integer>60</integer>");
  });
});
