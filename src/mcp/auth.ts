import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const OPENAI_TUNNEL_TOKEN_ENV = "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN";
export const OPENAI_TUNNEL_TOKEN_FILE_ENV = "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE";
export const OPENAI_TUNNEL_HEADER_NAME = "x-local-dev-mcp-tunnel-token";
export const OPENAI_TUNNEL_HEADER_DISPLAY_NAME = "X-Local-Dev-MCP-Tunnel-Token";
export const OPENAI_ALLOWED_SUBJECT_ENV = "LOCAL_DEV_MCP_ALLOWED_OPENAI_SUBJECT";
export const OPENAI_ALLOWED_SUBJECT_FILE_ENV = "LOCAL_DEV_MCP_ALLOWED_OPENAI_SUBJECT_FILE";
export const OPENAI_SUBJECT_POLICY_ENV = "LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY";
export const DEFAULT_OPENAI_ALLOWED_SUBJECT_FILE = resolve(homedir(), ".local-dev-mcp", "allowed-openai-subject");

export type OpenAiSubjectPolicy = "enforce" | "tunnel_only";

export interface OpenAiTunnelAuthConfig {
  token: string;
}

export interface OpenAiSubjectAuthConfig {
  subject: string;
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

  return secureStringEqual(provided, expectedToken);
}

export function resolveOpenAiSubjectAuthConfig(env: NodeJS.ProcessEnv = process.env): OpenAiSubjectAuthConfig {
  const inlineSubject = env[OPENAI_ALLOWED_SUBJECT_ENV]?.trim();
  const configuredFile = env[OPENAI_ALLOWED_SUBJECT_FILE_ENV]?.trim();
  if (inlineSubject && configuredFile) {
    throw new Error(`${OPENAI_ALLOWED_SUBJECT_ENV} and ${OPENAI_ALLOWED_SUBJECT_FILE_ENV} are mutually exclusive.`);
  }

  let subject = inlineSubject;
  if (!subject) {
    const path = expandHomePath(configuredFile || DEFAULT_OPENAI_ALLOWED_SUBJECT_FILE);
    try {
      subject = readFileSync(path, "utf8").trim();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read ChatGPT allowed subject file: ${detail}`);
    }
  }

  if (!subject) {
    throw new Error("ChatGPT allowed subject must not be empty.");
  }
  if (subject.length > 4096) {
    throw new Error("ChatGPT allowed subject is unexpectedly large.");
  }

  return { subject };
}

export function verifyOpenAiSubject(subject: unknown, expectedSubject: string): boolean {
  return typeof subject === "string" && subject.length > 0 && secureStringEqual(subject, expectedSubject);
}

export function resolveOpenAiSubjectPolicy(env: NodeJS.ProcessEnv = process.env): OpenAiSubjectPolicy {
  const policy = env[OPENAI_SUBJECT_POLICY_ENV]?.trim() || "enforce";
  if (policy === "enforce" || policy === "tunnel_only") return policy;
  throw new Error(`${OPENAI_SUBJECT_POLICY_ENV} must be enforce or tunnel_only.`);
}

export function hashOpenAiSubject(subject: unknown): string | undefined {
  if (typeof subject !== "string" || subject.length === 0) return undefined;
  return `sha256:${createHash("sha256").update(subject, "utf8").digest("hex")}`;
}

function secureStringEqual(actualValue: string, expectedValue: string): boolean {
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
