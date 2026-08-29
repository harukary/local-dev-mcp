import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const OPENAI_TUNNEL_TOKEN_ENV = "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN";
export const OPENAI_TUNNEL_TOKEN_FILE_ENV = "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE";
export const OPENAI_TUNNEL_HEADER_NAME = "x-local-dev-mcp-tunnel-token";
export const OPENAI_TUNNEL_HEADER_DISPLAY_NAME = "X-Local-Dev-MCP-Tunnel-Token";

export interface OpenAiTunnelAuthConfig {
  token: string;
}

const MIN_OPENAI_TUNNEL_TOKEN_LENGTH = 32;

export function resolveOpenAiTunnelAuthConfig(env: NodeJS.ProcessEnv = process.env): OpenAiTunnelAuthConfig {
  const inlineToken = env[OPENAI_TUNNEL_TOKEN_ENV]?.trim();
  const tokenFile = env[OPENAI_TUNNEL_TOKEN_FILE_ENV]?.trim();
  if (inlineToken && tokenFile) {
    throw new Error(`${OPENAI_TUNNEL_TOKEN_ENV} and ${OPENAI_TUNNEL_TOKEN_FILE_ENV} are mutually exclusive.`);
  }

  let token = inlineToken;
  if (tokenFile) {
    const path = expandHomePath(tokenFile);
    try {
      token = readFileSync(path, "utf8").trim();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read ${OPENAI_TUNNEL_TOKEN_FILE_ENV}: ${detail}`);
    }
  }

  if (!token) {
    throw new Error(
      `HTTP MCP requires ${OPENAI_TUNNEL_TOKEN_ENV} or ${OPENAI_TUNNEL_TOKEN_FILE_ENV}. ` +
      "The HTTP transport is intended only for OpenAI Secure MCP Tunnel."
    );
  }
  if (token.length < MIN_OPENAI_TUNNEL_TOKEN_LENGTH) {
    throw new Error(`OpenAI Tunnel token must be at least ${MIN_OPENAI_TUNNEL_TOKEN_LENGTH} characters.`);
  }

  return { token };
}

export function verifyOpenAiTunnelToken(
  headerValue: string | string[] | undefined,
  expectedToken: string
): boolean {
  const provided = Array.isArray(headerValue)
    ? headerValue.length === 1 ? headerValue[0] : undefined
    : headerValue;
  if (!provided) return false;

  const actual = Buffer.from(provided);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
