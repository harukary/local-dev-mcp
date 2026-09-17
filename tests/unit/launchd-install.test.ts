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
        HOME: tempDir,
        LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR: tempDir,
        LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX: labelPrefix,
        LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY: "",
        PORT: "13461",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const server = readFileSync(path.join(tempDir, `${labelPrefix}.server.plist`), "utf8");
    const tunnel = readFileSync(path.join(tempDir, `${labelPrefix}.openai-tunnel-personal.plist`), "utf8");

    expect(server).toContain("scripts/server.sh");
    expect(server).toContain("logs/mcp-server.log");
    expect(tunnel).toContain("scripts/tunnel.sh");
    expect(tunnel).toContain("logs/openai-tunnel-personal.log");
    expect(tunnel).toContain("<key>LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR</key>");
    expect(tunnel).toContain(`<string>${tempDir}/.local-dev-mcp/openai-tunnel-personal</string>`);
    expect(tunnel).toContain(`<string>${tempDir}/.openai-tunnels/personal/runtime-api-key</string>`);
    expect(tunnel).toContain("<string>127.0.0.1:3460</string>");
    expect(server).toContain("<key>PORT</key>");
    expect(server).toContain("<string>13461</string>");
    expect(tunnel).toContain("<key>PORT</key>");
    expect(tunnel).toContain("<string>13461</string>");
    expect(server).toContain("run-with-rotating-log.mjs");
    expect(tunnel).toContain("run-with-rotating-log.mjs");
    expect(tunnel).not.toContain("CONTROL_PLANE_API_KEY");
    expect(tunnel).not.toContain("<key>LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN</key>");
    expect(server).toContain("<key>ExitTimeOut</key>");
    expect(server).toContain("<integer>60</integer>");
    expect(server).not.toContain("LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY");
  });

  it("embeds an explicit subject policy in the server LaunchAgent", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-launchd-subject-policy-"));
    tempDirs.push(tempDir);
    const labelPrefix = "test.local-dev-mcp";

    const result = spawnSync("/bin/bash", [path.resolve("scripts/install-launchd.sh"), "--install-only"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: tempDir,
        LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR: tempDir,
        LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX: labelPrefix,
        LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY: "enforce",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const server = readFileSync(path.join(tempDir, `${labelPrefix}.server.plist`), "utf8");
    expect(server).toContain("<key>LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY</key>");
    expect(server).toContain("<string>enforce</string>");
  });

  it("generates an optional Business Secure MCP Tunnel LaunchAgent", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-launchd-business-"));
    tempDirs.push(tempDir);
    const launchAgentsDir = path.join(tempDir, "LaunchAgents");
    const labelPrefix = "test.local-dev-mcp";

    const result = spawnSync("/bin/bash", [path.resolve("scripts/install-launchd.sh"), "--install-only"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: tempDir,
        LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR: launchAgentsDir,
        LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX: labelPrefix,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE: "1",
        PORT: "13461",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const businessTunnel = readFileSync(path.join(launchAgentsDir, `${labelPrefix}.openai-tunnel-business.plist`), "utf8");

    expect(businessTunnel).toContain("scripts/tunnel.sh");
    expect(businessTunnel).toContain("logs/openai-tunnel-business.log");
    expect(businessTunnel).toContain("<key>LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR</key>");
    expect(businessTunnel).toContain(`<string>${tempDir}/.local-dev-mcp/openai-tunnel-business</string>`);
    expect(businessTunnel).toContain("<key>LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE</key>");
    expect(businessTunnel).toContain(`<string>${tempDir}/.openai-tunnels/business/runtime-api-key</string>`);
    expect(businessTunnel).toContain("<key>LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE</key>");
    expect(businessTunnel).toContain(`<string>${tempDir}/.local-dev-mcp/openai-tunnel/mcp-token</string>`);
    expect(businessTunnel).toContain("<key>LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_ADDR</key>");
    expect(businessTunnel).toContain("<string>127.0.0.1:3462</string>");
  });

});
