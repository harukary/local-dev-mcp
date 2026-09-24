import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("hands activation to an independent launchd worker", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-launchd-activate-"));
    tempDirs.push(tempDir);
    const launchAgentsDir = path.join(tempDir, "LaunchAgents");
    const fakeBin = path.join(tempDir, "bin");
    const launchctlLog = path.join(tempDir, "launchctl.log");
    const labelPrefix = "test.local-dev-mcp";
    mkdirSync(fakeBin, { recursive: true });
    const fakeLaunchctl = path.join(fakeBin, "launchctl");
    writeFileSync(fakeLaunchctl, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"\nexit 0\n`);
    chmodSync(fakeLaunchctl, 0o755);

    const result = spawnSync("/bin/bash", [path.resolve("scripts/install-launchd.sh"), "--activate"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_LAUNCHCTL_LOG: launchctlLog,
        LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR: launchAgentsDir,
        LOCAL_DEV_MCP_LOG_DIR: path.join(tempDir, "logs"),
        LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX: labelPrefix,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE: "1",
        PORT: "13461",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Activation handed off to one-shot launchd job ${labelPrefix}.activate.`);
    const calls = readFileSync(launchctlLog, "utf8");
    expect(calls).toContain(`bootout gui/${process.getuid?.() ?? 0}/${labelPrefix}.activate`);
    const activationPlistPath = path.join(tempDir, "logs", ".launchd-activate.plist");
    expect(calls).toContain(`bootstrap gui/${process.getuid?.() ?? 0} ${activationPlistPath}`);
    expect(calls).not.toContain("submit -l");
    const activationPlist = readFileSync(activationPlistPath, "utf8");
    expect(activationPlist).toContain("scripts/activate-launchd-worker.sh");
    expect(activationPlist).toContain(`${labelPrefix}.openai-tunnel-personal`);
    expect(activationPlist).toContain(`${labelPrefix}.openai-tunnel-business`);
    expect(activationPlist).toContain("<key>RunAtLoad</key>");
    expect(activationPlist).not.toContain("<key>KeepAlive</key>");
  });

  it("restarts services from the launchd-owned activation worker", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-launchd-worker-"));
    tempDirs.push(tempDir);
    const launchAgentsDir = path.join(tempDir, "LaunchAgents");
    const fakeBin = path.join(tempDir, "bin");
    const launchctlLog = path.join(tempDir, "launchctl.log");
    mkdirSync(launchAgentsDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    for (const label of ["test.server", "test.personal", "test.business", "test.legacy", "test.legacy-mini"]) {
      writeFileSync(path.join(launchAgentsDir, `${label}.plist`), "placeholder");
    }
    const activationPlist = path.join(tempDir, "activation.plist");
    writeFileSync(activationPlist, "placeholder");
    for (const [name, body] of [
      ["launchctl", `#!/bin/bash\nprintf '%s\\n' "$*" >> "$FAKE_LAUNCHCTL_LOG"\nif [ "$1" = "print" ]; then\n  if [[ "$2" == *test.server ]]; then\n    visible="$(cat "$FAKE_PRINT_STATE" 2>/dev/null || printf 0)"\n    if [ "$visible" -lt 2 ]; then\n      printf '%s' "$((visible + 1))" > "$FAKE_PRINT_STATE"\n      exit 0\n    fi\n  fi\n  exit 1\nfi\nif [ "$1" = "bootstrap" ] && [[ "$3" == *test.server.plist ]]; then\n  attempts="$(cat "$FAKE_BOOTSTRAP_STATE" 2>/dev/null || printf 0)"\n  if [ "$attempts" -lt 1 ]; then\n    printf 1 > "$FAKE_BOOTSTRAP_STATE"\n    echo "Bootstrap failed: 5: Input/output error" >&2\n    exit 5\n  fi\nfi\nexit 0\n`],
      ["curl", "#!/bin/bash\nexit 0\n"],
      ["sleep", "#!/bin/bash\nexit 0\n"],
    ] as const) {
      const file = path.join(fakeBin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }

    const result = spawnSync("/bin/bash", [
      path.resolve("scripts/activate-launchd-worker.sh"),
      "gui/501",
      launchAgentsDir,
      activationPlist,
      "test.server",
      "13461",
      "test.legacy",
      "test.legacy-mini",
      "test.personal",
      "test.business",
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_LAUNCHCTL_LOG: launchctlLog,
        FAKE_BOOTSTRAP_STATE: path.join(tempDir, "bootstrap-state"),
        FAKE_PRINT_STATE: path.join(tempDir, "print-state"),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Activated test.server and test.personal test.business");
    const calls = readFileSync(launchctlLog, "utf8");
    expect(calls).toContain("bootout gui/501/test.server");
    const serverPrint = "print gui/501/test.server";
    expect(calls.split("\n").filter((line) => line === serverPrint).length).toBeGreaterThanOrEqual(3);
    const serverBootstrap = `bootstrap gui/501 ${path.join(launchAgentsDir, "test.server.plist")}`;
    expect(calls.split("\n").filter((line) => line === serverBootstrap)).toHaveLength(2);
    expect(calls).toContain(`bootstrap gui/501 ${path.join(launchAgentsDir, "test.personal.plist")}`);
    expect(calls).toContain(`bootstrap gui/501 ${path.join(launchAgentsDir, "test.business.plist")}`);
    expect(() => readFileSync(path.join(launchAgentsDir, "test.legacy.plist"))).toThrow();
    expect(() => readFileSync(path.join(launchAgentsDir, "test.legacy-mini.plist"))).toThrow();
    expect(() => readFileSync(activationPlist)).toThrow();
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
