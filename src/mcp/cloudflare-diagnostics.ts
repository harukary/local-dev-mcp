import { createHmac, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const CLOUDFLARE_REQUEST_DIAGNOSTICS_ENV = "LOCAL_DEV_MCP_CLOUDFLARE_REQUEST_DIAGNOSTICS";

const fingerprintKey = randomBytes(32);
const captureId = randomBytes(8).toString("hex");
const SAFE_FIELD_NAME = /^[a-zA-Z0-9._/-]{1,128}$/;
const MAX_FIELDS = 64;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 4;
const MAX_NODES = 256;
const MAX_FINGERPRINT_VALUE_LENGTH = 2048;
const CORRELATION_HEADERS = /(?:^|[-_])(?:session|conversation|request-id|traceparent)(?:$|[-_])/i;
const SENSITIVE_HEADER = /(?:authorization|cookie|token|secret|password|credential|api-key|assertion|private-key)/i;
const PRIVATE_HEADER = /^(?:cf-connecting-ip|cf-ipcountry|cf-warp-tag-id|cf-access-authenticated-user-email|x-forwarded-for|x-real-ip|true-client-ip)$/i;
const PRIVATE_FIELD = /(?:authorization|cookie|token|secret|password|credential|api[-_]?key|assertion|private[-_]?key|jwt|prompt|message|command|content|query|payload|body|access[-_]?key)|(?:^|[._/-])text(?:$|[._/-])/i;
const KNOWN_MCP_METHODS = new Set([
  "server/discover", "initialize", "notifications/initialized", "ping",
  "tools/list", "tools/call", "resources/list", "resources/read",
  "resources/templates/list", "prompts/list", "prompts/get",
  "completion/complete", "logging/setLevel",
]);

function fieldNames(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((name) => SAFE_FIELD_NAME.test(name)).sort().slice(0, MAX_FIELDS);
}

function fingerprint(value: string): string | undefined {
  if (value.length > MAX_FINGERPRINT_VALUE_LENGTH) return undefined;
  return createHmac("sha256", fingerprintKey).update(value).digest("hex").slice(0, 16);
}

function scalarShape(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === "boolean") return { type: "boolean" };
  const raw = String(value);
  const valueFingerprint = fingerprint(raw);
  return {
    type: typeof value,
    length: raw.length,
    ...(valueFingerprint ? { fingerprint: valueFingerprint } : {}),
  };
}

type ShapeBudget = { remaining: number };

function fieldShape(value: unknown, depth: number, budget: ShapeBudget): Record<string, unknown> {
  if (budget.remaining-- <= 0 || depth > MAX_DEPTH) return { type: "truncated" };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return scalarShape(value);
  }
  if (value === undefined || value === null) return { type: value === null ? "null" : "missing" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      ...(depth < MAX_DEPTH
        ? { items: value.slice(0, MAX_ARRAY_ITEMS).map((item) => fieldShape(item, depth + 1, budget)) }
        : {}),
    };
  }
  if (typeof value !== "object") return { type: typeof value };
  const record = value as Record<string, unknown>;
  const names = fieldNames(record);
  return {
    type: "object",
    keys: names,
    keyCount: Object.keys(record).length,
    ...(depth < MAX_DEPTH ? {
      fields: Object.fromEntries(names.map((name) => [
        name,
        PRIVATE_FIELD.test(name) ? { type: "redacted" } : fieldShape(record[name], depth + 1, budget),
      ])),
    } : {}),
  };
}

function metadataShape(value: unknown): Record<string, unknown> {
  return fieldShape(value, 0, { remaining: MAX_NODES });
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeMethod(value: unknown): string {
  return typeof value === "string" && KNOWN_MCP_METHODS.has(value) ? value : "other";
}

function headerHint(name: string, value: string | string[] | undefined): Record<string, unknown> {
  if (SENSITIVE_HEADER.test(name) || PRIVATE_HEADER.test(name)) return { type: "redacted" };
  if (typeof value !== "string") return { type: Array.isArray(value) ? "array" : "missing" };
  const detail = scalarShape(value);
  if (name === "mcp-protocol-version" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ...detail, protocolVersion: value };
  }
  if (name === "mcp-method" && KNOWN_MCP_METHODS.has(value)) {
    return { ...detail, method: value };
  }
  return detail;
}

function argumentShape(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return { type: value === null ? "null" : "missing" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value !== "object") return { type: typeof value };
  const args = value as Record<string, unknown>;
  return { type: "object", keys: fieldNames(args), keyCount: Object.keys(args).length };
}

/** Call only for authenticated Cloudflare MCP requests. No raw headers, JWTs, tool arguments or metadata values are logged. */
export function summarizeCloudflareMcpRequest(
  headers: IncomingHttpHeaders,
  parsed: unknown
): Record<string, unknown> {
  const request = plainRecord(parsed);
  const params = plainRecord(request?.params);
  const allHeaderNames = Object.keys(headers).filter((name) => SAFE_FIELD_NAME.test(name)).sort();
  const headerNames = allHeaderNames.slice(0, MAX_FIELDS);
  const identifierNames = allHeaderNames
    .filter((name) => CORRELATION_HEADERS.test(name) && !SENSITIVE_HEADER.test(name) && !PRIVATE_HEADER.test(name))
    .slice(0, MAX_FIELDS);
  const metadata = plainRecord(params?._meta);
  const clientInfo = plainRecord(params?.clientInfo) ??
    plainRecord(metadata?.["io.modelcontextprotocol/clientInfo"]);
  const mcpMethod = safeMethod(request?.method);
  const paramNames = params ? fieldNames(params) : [];
  const additionalParamNames = paramNames.filter((name) =>
    name !== "arguments" && name !== "_meta" && name !== "name"
  );
  const bodyNames = request ? fieldNames(request) : [];
  const extraBodyNames = bodyNames.filter((name) =>
    name !== "id" && name !== "jsonrpc" && name !== "method" && name !== "params"
  );
  return {
    source: "cloudflare_access",
    diagnosticSchema: 2,
    captureId,
    method: mcpMethod,
    ...(mcpMethod === "other" && typeof request?.method === "string"
      ? { unknownMethod: scalarShape(request.method) } : {}),
    headers: headerNames,
    headerCount: allHeaderNames.length,
    headerDetails: Object.fromEntries(headerNames.map((name) => [name, headerHint(name, headers[name])])),
    identifierHeaders: Object.fromEntries(identifierNames.map((name) => [name, headerHint(name, headers[name])])),
    bodyFields: bodyNames,
    bodyFieldCount: request ? Object.keys(request).length : 0,
    requestId: metadataShape(request?.id),
    requestMeta: metadataShape(request?._meta),
    paramsFields: paramNames,
    paramsFieldCount: params ? Object.keys(params).length : 0,
    paramsMeta: metadataShape(params?._meta),
    paramsArguments: argumentShape(params?.arguments),
    additionalParams: Object.fromEntries(additionalParamNames.map((name) => [
      name, PRIVATE_FIELD.test(name) ? { type: "redacted" } : metadataShape(params?.[name]),
    ])),
    additionalBodyFields: Object.fromEntries(extraBodyNames.map((name) => [
      name, PRIVATE_FIELD.test(name) ? { type: "redacted" } : metadataShape(request?.[name]),
    ])),
    ...(mcpMethod === "initialize" || mcpMethod === "server/discover"
      ? { clientInfo: metadataShape(clientInfo) } : {}),
  };
}
