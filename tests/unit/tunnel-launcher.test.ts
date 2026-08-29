import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Secure MCP Tunnel launcher", () => {
  it("passes environment secret references without putting secret values in argv", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-openai-tunnel-"));
    tempDirs.push(tempDir);
    const fakeBin = path.join(tempDir, "tunnel-client");
    const argsFile = path.join(tempDir, "args.txt");
    writeFileSync(fakeBin, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o700 });

    const apiKey = "runtime-key-value-that-must-not-appear";
    const mcpToken = "mcp-token-value-that-must-not-appear-0123456789abcdef";
    const result = spawnSync("/bin/bash", [path.resolve("scripts/tunnel.sh"), "--doctor"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_ID: "tunnel_0123456789abcdef0123456789abcdef",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY: apiKey,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN: mcpToken,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_ID_FILE: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE: "",
        LOCAL_DEV_MCP_TUNNEL_CLIENT_BIN: fakeBin,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("doctor");
    expect(args).toContain("env:LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY");
    expect(args).toContain("X-Local-Dev-MCP-Tunnel-Token: env:LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN");
    expect(args).toContain("--mcp.discovery-extra-headers");
    expect(args).toContain("http://127.0.0.1:3456/mcp");
    expect(args).not.toContain(apiKey);
    expect(args).not.toContain(mcpToken);
  });

  it("uses file references from the service state directory", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-openai-files-"));
    tempDirs.push(tempDir);
    const fakeBin = path.join(tempDir, "tunnel-client");
    const argsFile = path.join(tempDir, "args.txt");
    writeFileSync(fakeBin, `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o700 });
    writeFileSync(path.join(tempDir, "tunnel-id"), "tunnel_0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
    writeFileSync(path.join(tempDir, "runtime-api-key"), "runtime-key\n", { mode: 0o600 });
    writeFileSync(path.join(tempDir, "mcp-token"), "m".repeat(48), { mode: 0o600 });

    const result = spawnSync("/bin/bash", [path.resolve("scripts/tunnel.sh"), "--doctor"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR: tempDir,
        LOCAL_DEV_MCP_TUNNEL_CLIENT_BIN: fakeBin,
        LOCAL_DEV_MCP_OPENAI_TUNNEL_ID: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_ID_FILE: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE: "",
        LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain(`file:${path.join(tempDir, "runtime-api-key")}`);
    expect(args).toContain(`X-Local-Dev-MCP-Tunnel-Token: file:${path.join(tempDir, "mcp-token")}`);
  });
});
