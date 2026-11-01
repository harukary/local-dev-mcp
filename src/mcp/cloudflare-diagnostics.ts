import { createHmac, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const CLOUDFLARE_REQUEST_DIAGNOSTICS_ENV = "LOCAL_DEV_MCP_CLOUDFLARE_REQUEST_DIAGNOSTICS";

const fingerprintKey = randomBytes(32);
const SAFE_FIELD_NAME = /^[a-zA-Z0-9._/-]{1,128}$/;
const MAX_FIELDS = 48;
const MAX_FINGERPRINT_VALUE_LENGTH = 1024;
const CORRELATION_HEADERS = /(?:^|[-_])(?:session|conversation|request-id|traceparent)(?:$|[-_])/i;
const KNOWN_MCP_METHODS = new Set([
  "initialize", "notifications/initialized", "ping", "tools/list",
  "tools/call", "resources/list", "resources/read", "resources/templates/list",
]);
const SENSITIVE_HEADERS = /(?:authorization|cookie|token|secret|password|credential|api-key|assertion)/i;

function fieldNames(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((name) => SAFE_FIELD_NAME.test(name))
    .sort()
    .slice(0, MAX_FIELDS);
}

function fingerprint(value: string): string | undefined {
  if (value.length > MAX_FINGERPRINT_VALUE_LENGTH) return undefined;
  return createHmac("sha256", fingerprintKey).update(value).digest("hex").slice(0, 16);
}

function fieldShape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const valueFingerprint = fingerprint(value);
    return { type: "string", length: value.length, ...(valueFingerprint ? { fingerprint: valueFingerprint } : {}) };
  }
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") return { type: "object", keys: fieldNames(value as Record<string, unknown>) };
  return { type: typeof value };
}

function metadataShape(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { type: value === undefined ? "missing" : Array.isArray(value) ? "array" : value === null ? "null" : typeof value };
  }
  const record = value as Record<string, unknown>;
  return { type: "object", fields: Object.fromEntries(fieldNames(record).map((name) => [name, fieldShape(record[name])])) };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeMethod(value: unknown): string {
  return typeof value === "string" && KNOWN_MCP_METHODS.has(value) ? value : "other";
}

function headerHint(value: string | string[] | undefined) {
  if (typeof value !== "string") return { type: Array.isArray(value) ? "array" : "missing" };
  return fieldShape(value);
}

/** Only authenticated Cloudflare MCP requests should reach this summary. Never log raw headers, JWTs, tool args or metadata values. */
export function summarizeCloudflareMcpRequest(
  headers: IncomingHttpHeaders,
  parsed: unknown
): Record<string, unknown> {
  const request = plainRecord(parsed);
  const params = plainRecord(request?.params);
  const clientInfo = plainRecord(params?.clientInfo);
  const allHeaderNames = Object.keys(headers).filter((name) => SAFE_FIELD_NAME.test(name)).sort();
  const headerNames = allHeaderNames.slice(0, MAX_FIELDS);
  const identifiers = Object.fromEntries(
    allHeaderNames.filter((name) => CORRELATION_HEADERS.test(name) && !SENSITIVE_HEADERS.test(name))
      .slice(0, MAX_FIELDS)
      .map((name) => [name, headerHint(headers[name])])
  );
  return {
    source: "cloudflare_access",
    method: safeMethod(request?.method),
    headers: headerNames,
    headerCount: allHeaderNames.length,
    identifierHeaders: identifiers,
    requestMeta: metadataShape(request?._meta),
    paramsMeta: metadataShape(params?._meta),
    ...(request?.method === "initialize" ? {
      clientInfo: clientInfo
        ? Object.fromEntries(["name", "version"].filter((key) => key in clientInfo).map((key) => [key, fieldShape(clientInfo[key])]))
        : { type: "missing" },
      protocolVersion: typeof params?.protocolVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
        ? params.protocolVersion : "unknown",
    } : {}),
  };
}
