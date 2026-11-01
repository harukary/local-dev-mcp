import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const MUSE_HOST_ENV = "LOCAL_DEV_MCP_MUSE_HOST";
export const MUSE_TOKEN_FILE_ENV = "LOCAL_DEV_MCP_MUSE_TOKEN_FILE";

export interface MuseAuthConfig {
  host: string;
  token: string;
  ownerHash: string;
}

export function resolveMuseAuthConfig(env: NodeJS.ProcessEnv = process.env): MuseAuthConfig | undefined {
  const host = env[MUSE_HOST_ENV]?.trim().toLowerCase();
  const tokenFile = env[MUSE_TOKEN_FILE_ENV]?.trim();
  if (!host && !tokenFile) return undefined;
  if (!host || !tokenFile) throw new Error("Muse requires both " + MUSE_HOST_ENV + " and " + MUSE_TOKEN_FILE_ENV + ".");
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net):([1-9][0-9]{0,4})$/.exec(host);
  if (!match || Number(match[2]) > 65535 || host.length > 260) {
    throw new Error(MUSE_HOST_ENV + " must be an exact Tailscale DNS host and HTTPS port.");
  }
  if (!isAbsolute(tokenFile)) throw new Error(MUSE_TOKEN_FILE_ENV + " must be an absolute path.");
  const stat = lstatSync(tokenFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("Muse token must be a regular private file (mode 0600 or stricter).");
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("Muse token must be a strong base64url or hex secret of 43-128 characters.");
  }
  return {
    host,
    token,
    ownerHash: createHash("sha256").update("muse-auth-owner:v1\0").update(token).digest("hex"),
  };
}

export function verifyMuseBearer(authorization: string | string[] | undefined, config: MuseAuthConfig): boolean {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const given = authorization.slice(7);
  const actual = Buffer.from(given, "utf8");
  const expected = Buffer.from(config.token, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function museWorkContextId(ownerHash: string, projectId: string, workingDir = "."): string {
  return "muse-work:" + createHash("sha256")
    .update(ownerHash).update("\0").update(projectId).update("\0").update(workingDir)
    .digest("hex");
}
