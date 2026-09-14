import { describe, expect, it, vi } from "vitest";
import { resolveCredentialEnv } from "../../src/shell/credential-env.js";

describe("credential environment resolver", () => {
  it("reads the Bitwarden token and makes the user-local bws binary discoverable", async () => {
    const readKeychainSecret = vi.fn().mockResolvedValue("keychain-token\n");
    const env = await resolveCredentialEnv("bitwarden", {
      env: {
        LOCAL_DEV_MCP_HOME: "/private/local-dev-mcp",
        PATH: "/usr/bin:/bin:/Users/test/.local/bin",
      },
      homeDir: "/Users/test",
      readTextFile: vi.fn().mockResolvedValue(
        [
          "BITWARDEN_ACCESS_TOKEN_KEYCHAIN_SERVICE=haruclaw.bitwarden-secrets",
          "BITWARDEN_ACCESS_TOKEN_KEYCHAIN_ACCOUNT=haruclaw-air",
        ].join("\n")
      ),
      readKeychainSecret,
    });

    expect(env).toEqual({
      BWS_ACCESS_TOKEN: "keychain-token",
      PATH: "/Users/test/.local/bin:/usr/bin:/bin",
    });
    expect(readKeychainSecret).toHaveBeenCalledWith(
      "haruclaw.bitwarden-secrets",
      "haruclaw-air"
    );
  });

  it("adds ~/.local/bin even when PATH is initially missing", async () => {
    const env = await resolveCredentialEnv("bitwarden", {
      env: { LOCAL_DEV_MCP_HOME: "/private/local-dev-mcp" },
      homeDir: "/Users/test",
      readTextFile: vi.fn().mockResolvedValue(
        [
          "BITWARDEN_ACCESS_TOKEN_KEYCHAIN_SERVICE=haruclaw.bitwarden-secrets",
          "BITWARDEN_ACCESS_TOKEN_KEYCHAIN_ACCOUNT=haruclaw-air",
        ].join("\n")
      ),
      readKeychainSecret: vi.fn().mockResolvedValue("keychain-token"),
    });

    expect(env.PATH).toBe("/Users/test/.local/bin");
  });

  it("fails explicitly when the Keychain mapping is incomplete", async () => {
    await expect(
      resolveCredentialEnv("bitwarden", {
        env: { LOCAL_DEV_MCP_HOME: "/private/local-dev-mcp" },
        readTextFile: vi.fn().mockResolvedValue("BITWARDEN_PROJECT_ID=project"),
      })
    ).rejects.toThrow("Keychain service/account is not configured");
  });
});
