import type { AuditLogEntry } from "../types.js";

const SUBJECT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface SubjectCountWindow {
  since: string;
  until: string;
}

export interface SubjectCountResult extends SubjectCountWindow {
  distinctAuthorizedSubjects: number;
  matchedRecords: number;
}

export function countDistinctAuthorizedSubjects(
  lines: Iterable<string>,
  window: SubjectCountWindow
): SubjectCountResult {
  const sinceMs = parseBoundary(window.since, "since");
  const untilMs = parseBoundary(window.until, "until");
  if (sinceMs >= untilMs) throw new Error("since must be earlier than until");

  const hashes = new Set<string>();
  let matchedRecords = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: AuditLogEntry;
    try {
      entry = JSON.parse(line) as AuditLogEntry;
    } catch {
      continue;
    }
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < sinceMs || timestamp >= untilMs) continue;
    if (entry.event !== "openai_subject_authorization" || entry.openAiSubjectAuthorized !== true) continue;
    if (!entry.openAiSubjectHash || !SUBJECT_HASH_PATTERN.test(entry.openAiSubjectHash)) continue;
    matchedRecords += 1;
    hashes.add(entry.openAiSubjectHash);
  }

  return {
    ...window,
    distinctAuthorizedSubjects: hashes.size,
    matchedRecords,
  };
}

function parseBoundary(value: string, name: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return timestamp;
}
