import { describe, it, expect } from "vitest";
import { redactOutput } from "../../src/shell/redactor.js";

describe("Redactor", () => {
  it("redacts Bearer tokens", () => {
    const result = redactOutput("Authorization: Bearer sk-test123token");
    expect(result.text).not.toContain("sk-test123token");
    expect(result.text).toContain("[REDACTED]");
    expect(result.redactions).toContainEqual({ type: "bearer_token", count: 1 });
  });

  it("redacts OpenAI keys", () => {
    const result = redactOutput("key=sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.redactions).toContainEqual({ type: "openai_key", count: 1 });
  });

  it("redacts GitHub PATs", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890abcde";
    const result = redactOutput(`token=${token}`);
    expect(result.text).not.toContain(token);
    expect(result.redactions).toContainEqual({ type: "github_pat", count: 1 });
  });

  it("redacts AWS access keys", () => {
    const result = redactOutput("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(result.text).not.toContain("wJalrXUtnFEMI");
    expect(result.redactions).toContainEqual({ type: "aws_secret_key", count: 1 });
  });

  it("redacts private keys", () => {
    const output = "-----BEGIN PRIVATE KEY-----\nABCDEF12345\n-----END PRIVATE KEY-----";
    const result = redactOutput(output);
    expect(result.text).not.toContain("ABCDEF12345");
    expect(result.redactions).toContainEqual({ type: "private_key", count: 1 });
  });

  it("redacts multiple patterns", () => {
    const output = `Header: Authorization: Bearer tok_123\nBody: sk-testkeyabcdefghijklmnopqrstuv\nFooter: OK`;
    const result = redactOutput(output);
    expect(result.redactions.length).toBeGreaterThanOrEqual(2);
  });

  it("handles text with no secrets", () => {
    const result = redactOutput("Hello world, this is safe output.");
    expect(result.text).toBe("Hello world, this is safe output.");
    expect(result.redactions).toHaveLength(0);
  });

  it("applies strict patterns when profile is strict", () => {
    const result = redactOutput("DATABASE_URL=postgres://user:pass@localhost/db", "strict");
    expect(result.text).not.toContain("postgres://user:pass@localhost/db");
    expect(result.redactions).toContainEqual({ type: "database_url", count: 1 });
  });

  it("does not apply strict patterns when profile is default", () => {
    const result = redactOutput("DATABASE_URL=postgres://user:pass@localhost/db", "default");
    expect(result.text).toContain("postgres://user:pass@localhost/db");
  });
});
