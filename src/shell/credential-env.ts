import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CredentialScope } from "../types.js";

const execFileAsync = promisify(execFile);

interface CredentialResolverOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readTextFile?: (path: string) => Promise<string>;
  readKeychainSecret?: (service: string, account: string) => Promise<string>;
}

export async function resolveCredentialEnv(
  scope: CredentialScope,
  options: CredentialResolverOptions = {}
): Promise<Record<string, string>> {
  if (scope !== "bitwarden") {
    throw new Error(`Unsupported credential scope: ${scope}`);
  }

  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const localDevHome = env.LOCAL_DEV_MCP_HOME?.trim() || join(homeDir, ".local-dev-mcp");
  const configPath = join(localDevHome, ".bitwarden.env");
  const readTextFile = options.readTextFile ?? ((path) => readFile(path, "utf-8"));
  const config = parseEnvConfig(await readTextFile(configPath));
  const service = config.BITWARDEN_ACCESS_TOKEN_KEYCHAIN_SERVICE?.trim();
  const account = config.BITWARDEN_ACCESS_TOKEN_KEYCHAIN_ACCOUNT?.trim();

  if (!service || !account) {
    throw new Error(`Bitwarden Keychain service/account is not configured in ${configPath}`);
  }

  const readKeychainSecret = options.readKeychainSecret ?? readMacOsKeychainSecret;
  const token = (await readKeychainSecret(service, account)).trim();
  if (!token) {
    throw new Error(`Bitwarden access token was not found in Keychain account ${account}`);
  }

  const localBin = join(homeDir, ".local", "bin");
  return {
    BWS_ACCESS_TOKEN: token,
    PATH: prependPathEntry(env.PATH, localBin),
  };
}

function prependPathEntry(currentPath: string | undefined, entry: string): string {
  const parts = (currentPath ?? "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part !== entry);
  return [entry, ...parts].join(":");
}

function parseEnvConfig(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    result[match[1]] =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;
  }
  return result;
}

async function readMacOsKeychainSecret(service: string, account: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { maxBuffer: 1024 * 1024 }
    );
    return stdout;
  } catch {
    throw new Error(`Bitwarden access token was not found in Keychain account ${account}`);
  }
}
