import { describe, expect, it } from "vitest";
import { structuredTextFallback } from "../../src/mcp/output.js";

describe("structuredTextFallback", () => {
  it("keeps small structured results fully compatible with text-only readers", () => {
    const value = { ok: true, value: "small" };
    expect(JSON.parse(structuredTextFallback(value))).toEqual(value);
  });

  it("bounds the duplicate text copy for large structured results", () => {
    const value = { payload: "x".repeat(20_000) };
    const text = structuredTextFallback(value);
    const fallback = JSON.parse(text);
    expect(Buffer.byteLength(text)).toBeLessThan(2_000);
    expect(fallback).toMatchObject({ structured_content: true, text_fallback_truncated: true });
    expect(fallback.serialized_bytes).toBeGreaterThan(20_000);
    expect(fallback.preview).toContain("payload");
  });
});
