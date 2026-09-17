import { describe, expect, it } from "vitest";
import { countDistinctAuthorizedSubjects } from "../../src/audit/subject-count.js";
import { hashOpenAiSubject } from "../../src/mcp/auth.js";

describe("ChatGPT subject hashing", () => {
  it("is stable, distinct, and uses the documented SHA-256 format", () => {
    const first = hashOpenAiSubject("synthetic-owner-a");
    expect(first).toBe(hashOpenAiSubject("synthetic-owner-a"));
    expect(first).not.toBe(hashOpenAiSubject("synthetic-owner-b"));
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("distinguishes a missing subject from a hash", () => {
    expect(hashOpenAiSubject(undefined)).toBeUndefined();
    expect(hashOpenAiSubject("")).toBeUndefined();
  });
});

describe("authorized subject cardinality", () => {
  it("counts distinct authorized hashes only within the requested window", () => {
    const first = hashOpenAiSubject("synthetic-owner-a")!;
    const second = hashOpenAiSubject("synthetic-owner-b")!;
    const lines = [
      JSON.stringify({ timestamp: "2026-09-17T10:00:00.000Z", event: "openai_subject_authorization", openAiSubjectAuthorized: true, openAiSubjectHash: first }),
      JSON.stringify({ timestamp: "2026-09-17T10:01:00.000Z", event: "openai_subject_authorization", openAiSubjectAuthorized: true, openAiSubjectHash: first }),
      JSON.stringify({ timestamp: "2026-09-17T10:02:00.000Z", event: "openai_subject_authorization", openAiSubjectAuthorized: false, openAiSubjectHash: second }),
      JSON.stringify({ timestamp: "2026-09-17T10:03:00.000Z", event: "openai_subject_authorization", openAiSubjectAuthorized: true, openAiSubjectHash: second }),
      JSON.stringify({ timestamp: "2026-09-18T10:00:00.000Z", event: "openai_subject_authorization", openAiSubjectAuthorized: true, openAiSubjectHash: hashOpenAiSubject("outside-window") }),
    ];

    expect(countDistinctAuthorizedSubjects(lines, {
      since: "2026-09-17T10:00:00.000Z",
      until: "2026-09-18T00:00:00.000Z",
    })).toMatchObject({ distinctAuthorizedSubjects: 2, matchedRecords: 3 });
  });
});
