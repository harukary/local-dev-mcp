import { expect, it } from "vitest";
import { validateToolInput } from "../../src/mcp/input-validation.js";
import { buildToolDefinitions, buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";

it("compiles every tool schema and rejects invalid required arguments before execution", () => {
  for (const tool of buildToolDefinitions()) expect(() => validateToolInput(tool.name, {})).not.toThrow();
  expect(validateToolInput("workspace.patch", { patches: "not-an-array" })).toBeDefined();
  expect(validateToolInput("workspace.patch", { patches: [{ path: "a.txt", old_text: "before" }] })).toBeDefined();
  expect(validateToolInput("workspace.patch", { patches: [{ path: "a.txt", replacement: "after", unified_diff: "--- a/a.txt\n+++ b/a.txt\n" }] })).toBeDefined();
  expect(validateToolInput("workspace.patch", { patches: [{ path: "a.txt", old_text: "before", new_text: "after" }] })).toBeUndefined();
  expect(validateToolInput("workspace.patch", { patches: [{ unified_diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n" }] })).toBeUndefined();
  expect(validateToolInput("shell.status", { job_id: "job", max_bytes: -1 })).toBeDefined();
  expect(validateToolInput("shell.status", { job_id: "job", max_bytes: 4096, output: "none" })).toBeUndefined();
});

it("offers bounded schema discovery without hiding tools from tools/list", () => {
  const full = buildToolSchemaSnapshot();
  const summary = buildToolSchemaSnapshot({ prefix: "workspace.", detail: "summary" });
  expect(summary.tools.length).toBeGreaterThan(0);
  expect(summary.tools.every(tool => tool.name.startsWith("workspace."))).toBe(true);
  expect(summary.tools[0]).not.toHaveProperty("inputSchema");
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)) / 4);
});
