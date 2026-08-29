import { readFile } from "node:fs/promises";
import { load as parseYaml } from "js-yaml";
import type { AuthClaimInput, AuthClaimStatus } from "./profile-manager.js";

export type LiveAuthProbe = {
  id: string;
  version: number;
  url: string;
  authenticatedHost: string;
  authenticatedSelector: string;
  signedOutSelector?: string;
  signedOutUrlPattern?: string;
  principalSelector: string;
  timeoutMs: number;
  ttlHours: number;
};

type ProbeDocument = { probes?: unknown };
type ProbeObservation = { status: AuthClaimStatus; principal?: string };

export type LiveAuthProbeConfiguration = {
  status: "ready" | "missing" | "empty";
  probes: LiveAuthProbe[];
};

export async function loadLiveAuthProbeConfiguration(path: string): Promise<LiveAuthProbeConfiguration> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
    if (code === "ENOENT") return { status: "missing", probes: [] };
    throw error;
  }
  const document = parseYaml(raw) as ProbeDocument;
  if (!Array.isArray(document?.probes)) throw new Error("browser auth probe config requires a probes array");
  const probes = document.probes.map((value, index) => parseProbe(value, index));
  const identities = new Set<string>();
  for (const probe of probes) {
    const identity = `${probe.id}:${probe.version}`;
    if (identities.has(identity)) throw new Error(`browser auth probe config contains duplicate ${identity}`);
    identities.add(identity);
  }
  return { status: probes.length > 0 ? "ready" : "empty", probes };
}

export async function loadLiveAuthProbes(path: string): Promise<LiveAuthProbe[]> {
  return (await loadLiveAuthProbeConfiguration(path)).probes;
}

export async function runLiveAuthProbes(
  probes: LiveAuthProbe[],
  observe: (probe: LiveAuthProbe) => Promise<ProbeObservation>,
  now = new Date(),
): Promise<AuthClaimInput[]> {
  const claims: AuthClaimInput[] = [];
  for (const probe of probes) {
    let observation: ProbeObservation;
    try {
      observation = await observe(probe);
    } catch {
      observation = { status: "unknown" };
    }
    claims.push({
      probeId: probe.id,
      probeVersion: probe.version,
      status: observation.status,
      ...(observation.status === "authenticated" && observation.principal?.trim()
        ? { principal: observation.principal.trim() }
        : {}),
      verifiedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + probe.ttlHours * 60 * 60 * 1000).toISOString(),
    });
  }
  return claims;
}

function parseProbe(value: unknown, index: number): LiveAuthProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`browser auth probe ${index} must be an object`);
  const raw = value as Record<string, unknown>;
  const id = requiredString(raw.id, `probes[${index}].id`);
  const url = requiredString(raw.url, `probes[${index}].url`);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`probes[${index}].url must be http(s)`);
  const version = positiveInteger(raw.version ?? 1, `probes[${index}].version`);
  const timeoutMs = boundedInteger(raw.timeout_ms ?? 10_000, 500, 60_000, `probes[${index}].timeout_ms`);
  const ttlHours = boundedNumber(raw.ttl_hours ?? 24, 1, 168, `probes[${index}].ttl_hours`);
  return {
    id,
    version,
    url: parsed.toString(),
    authenticatedHost: requiredString(raw.authenticated_host, `probes[${index}].authenticated_host`).toLowerCase(),
    authenticatedSelector: requiredString(raw.authenticated_selector, `probes[${index}].authenticated_selector`),
    ...(typeof raw.signed_out_selector === "string" && raw.signed_out_selector.trim()
      ? { signedOutSelector: raw.signed_out_selector.trim() }
      : {}),
    ...(typeof raw.signed_out_url_pattern === "string" && raw.signed_out_url_pattern.trim()
      ? { signedOutUrlPattern: validateRegex(raw.signed_out_url_pattern.trim(), `probes[${index}].signed_out_url_pattern`) }
      : {}),
    principalSelector: requiredString(raw.principal_selector, `probes[${index}].principal_selector`),
    timeoutMs,
    ttlHours,
  };
}

function validateRegex(value: string, field: string): string {
  try { new RegExp(value); } catch { throw new Error(`${field} must be a valid regular expression`); }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  const number = positiveInteger(value, field);
  if (number < min || number > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return number;
}

function boundedNumber(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return value;
}
