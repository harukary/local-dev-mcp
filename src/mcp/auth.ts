import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const ENV_KEY = "LOCAL_DEV_MCP_API_KEY";
export const HTTP_AUTH_MODE_ENV = "LOCAL_DEV_MCP_AUTH_MODE";
export const OPENAI_TUNNEL_TOKEN_ENV = "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN";
export const OPENAI_TUNNEL_TOKEN_FILE_ENV = "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE";
export const OPENAI_TUNNEL_HEADER_NAME = "x-local-dev-mcp-tunnel-token";
export const OPENAI_TUNNEL_HEADER_DISPLAY_NAME = "X-Local-Dev-MCP-Tunnel-Token";

export type HttpAuthMode = "oauth" | "openai-tunnel";

export type HttpAuthConfig =
  | { mode: "oauth" }
  | { mode: "openai-tunnel"; token: string };

const MIN_OPENAI_TUNNEL_TOKEN_LENGTH = 32;

export function loadApiKey(): string | null {
  const key = process.env[ENV_KEY];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function resolveHttpAuthConfig(env: NodeJS.ProcessEnv = process.env): HttpAuthConfig {
  const rawMode = env[HTTP_AUTH_MODE_ENV]?.trim().toLowerCase();
  const mode: HttpAuthMode = !rawMode || rawMode === "oauth"
    ? "oauth"
    : rawMode === "openai-tunnel"
      ? "openai-tunnel"
      : invalidAuthMode(rawMode);

  if (mode === "oauth") {
    return { mode };
  }

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
      `${HTTP_AUTH_MODE_ENV}=openai-tunnel requires ${OPENAI_TUNNEL_TOKEN_ENV} or ${OPENAI_TUNNEL_TOKEN_FILE_ENV}.`
    );
  }
  if (token.length < MIN_OPENAI_TUNNEL_TOKEN_LENGTH) {
    throw new Error(`OpenAI Tunnel token must be at least ${MIN_OPENAI_TUNNEL_TOKEN_LENGTH} characters.`);
  }

  return { mode, token };
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

export function requireAuth(
  apiKey: string | null,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (!apiKey) {
    return true;
  }

  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    sendUnauthorized(res);
    return false;
  }

  const token = auth.slice(7);
  if (token !== apiKey) {
    sendUnauthorized(res);
    return false;
  }

  return true;
}

function invalidAuthMode(value: string): never {
  throw new Error(
    `${HTTP_AUTH_MODE_ENV} must be "oauth" or "openai-tunnel"; received ${JSON.stringify(value)}.`
  );
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": 'Bearer realm="local-dev-mcp"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized", message: "A valid API key is required." }));
}
