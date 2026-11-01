import { describe, expect, it } from "vitest";
import { adaptMcpToolResult } from "../../src/mcp/response-adapter.js";
import { limitMcpToolResponse } from "../../src/mcp/server.js";

function canonical(data: Record<string, unknown>) {
  return { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] };
}

const sampleRead = {
  project_id: "diary", path: "README.md", absolute_path: "/tmp/diary/README.md",
  start_line: 1, end_line: 3, total_lines: 3, has_more: false, truncated: false,
  next_start_line: null, next_start_column: 0,
  returned_bytes: 14, size_bytes: 14, sha256: "deadbeef",
  lines: [
    { line: 1, text: "# 日記" },
    { line: 2, text: "" },
    { line: 3, text: "  indented: 👋" },
  ],
};

describe("Claude MCP response adapter", () => {
  it("sends file text once, with exact lines and no duplicated JSON metadata", () => {
    const original = canonical(sampleRead);
    const result = adaptMcpToolResult("claude", "workspace.read", { path: "README.md" }, original);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content![0].text).toBe(
      "README.md (lines 1-3 / 3)\n1 | # 日記\n2 | \n3 |   indented: 👋"
    );
    expect(result.content![0].text).not.toContain("sha256");
    expect(adaptMcpToolResult("chatgpt", "workspace.read", {}, original)).toBe(original);
  });

  it("preserves a Unicode long-line continuation at the exact UTF-16 column", () => {
    const incomplete = {
      ...sampleRead, total_lines: 8, end_line: 2, truncated: true, has_more: true,
      next_start_line: 2, next_start_column: 207,
      lines: [{ line: 2, text: "日本語🙂の途中" }],
    };
    const result = adaptMcpToolResult("claude", "workspace.read", {}, canonical(incomplete));
    const text = result.content![0].text!;
    expect(text).toContain("2 | 日本語🙂の途中");
    expect(text).toContain("truncated");
    expect(text).toContain("next: start_line=2 start_column=207");
  });

  it("renders search context and pagination with real line numbers", () => {
    const data = {
      project_id: "diary", query: "needle", root: "src",
      matches: [{ path: "src/日本 語.ts", line: 7, text: "needle",
        before: ["before A", "before B"], after: ["after A", "after B"] }],
      truncated: true, max_results: 1, offset: 3, next_offset: 4,
      line_preview_max_bytes: 4096, context_preview_max_bytes: 2048,
    };
    const result = adaptMcpToolResult("claude", "workspace.search", {}, canonical(data));
    expect(result.structuredContent).toBeUndefined();
    expect(result.content![0].text).toContain(
      "src/日本 語.ts\n  5 | before A\n  6 | before B\n  7 | needle\n  8 | after A\n  9 | after B"
    );
    expect(result.content![0].text).toContain("next_offset=4");
  });

  it("lists paths and types and identifies truncated directory listings", () => {
    const data = { project_id: "diary", root: "src",
      entries: [{ path: "src/日本 語.ts", type: "file", size: 2048 },
        { path: "src/assets", type: "directory" }],
      truncated: true, max_entries: 2 };
    const result = adaptMcpToolResult("claude", "workspace.list", {}, canonical(data));
    expect(result.structuredContent).toBeUndefined();
    expect(result.content![0].text).toContain("src/日本 語.ts [file]");
    expect(result.content![0].text).toContain("src/assets [directory]");
    expect(result.content![0].text).toContain("truncated;");
    expect(result.content![0].text).not.toContain("2048");
  });

  it("keeps mixed batch results, indices, errors and the full-data escape hatch", () => {
    const data = { results: [
      { index: 0, tool: "workspace.read", result: sampleRead },
      { index: 1, tool: "workspace.search", result: {
        root: ".", matches: [], truncated: false, max_results: 10, offset: 0,
        next_offset: null } },
      { index: 2, tool: "workspace.list", result: {
        error: { code: "BATCH_OUTPUT_LIMIT", message: "Read this item separately." } } },
    ] };
    const compact = adaptMcpToolResult("claude", "workspace.batch", {}, canonical(data));
    expect(compact.structuredContent).toBeUndefined();
    const text = compact.content![0].text!;
    expect(text.indexOf("#0 workspace.read")).toBeLessThan(text.indexOf("#1 workspace.search"));
    expect(text.indexOf("#1 workspace.search")).toBeLessThan(text.indexOf("#2 workspace.list"));
    expect(text).toContain("BATCH_OUTPUT_LIMIT");
    const full = canonical(data);
    expect(adaptMcpToolResult("claude", "workspace.batch", { detail: "full" }, full)).toBe(full);
  });

  it("sends the complete Skill content with provenance, not a JSON preview", () => {
    const source = "---\nname: hello\n---\n\n# 日本語 Skill\n" + "x".repeat(12000);
    const data = { path: "/workspace/.agents/skills/hello/SKILL.md", scope: "project",
      origin: "project", name: "hello", description: "test", sha256: "digest",
      bytes: Buffer.byteLength(source), content: source };
    const result = adaptMcpToolResult("claude", "skills.read", {}, canonical(data));
    expect(result.structuredContent).toBeUndefined();
    expect(result.content![0].text).toContain("Source: /workspace/.agents/skills/hello/SKILL.md");
    expect(result.content![0].text!.endsWith(source)).toBe(true);
  });

  it("includes a reusable work handle and complete agent instructions", () => {
    const data = {
      selected: true, changed: true, project_id: "diary", display_name: "Diary",
      project_root: "/work/diary", working_dir: ".", cwd: "/work/diary",
      sandbox_type: "host", context_id: "ctx_" + "a".repeat(43),
      agent_instructions: {
        path: "/work/diary/AGENTS.md", content: "Rule 1\n\nRule 2\n",
        truncated: false, sources: [{ scope: "global", path: "/home/AGENTS.md", truncated: false },
          { scope: "project", path: "/work/diary/AGENTS.md", truncated: false }],
      },
    };
    const result = adaptMcpToolResult("claude", "project.select", {}, canonical(data));
    expect(result.structuredContent).toBeUndefined();
    expect(result.content![0].text).toContain(data.context_id);
    expect(result.content![0].text).toContain("Rule 1\n\nRule 2\n");
    expect(result.content![0].text).toContain("project: /work/diary/AGENTS.md");
  });

  it("passes through errors, unknown shapes and media unchanged", () => {
    const error = { ...canonical({ error: { code: "CONTEXT_NOT_FOUND", message: "missing" } }), isError: true };
    expect(adaptMcpToolResult("claude", "workspace.read", {}, error)).toBe(error);
    const newShape = canonical({ ...sampleRead, unexpected: "must not disappear" });
    expect(adaptMcpToolResult("claude", "workspace.read", {}, newShape)).toBe(newShape);
    const media = { ...canonical(sampleRead), content: [{ type: "image", data: "data", mimeType: "image/png" }] };
    expect(adaptMcpToolResult("claude", "workspace.read", {}, media)).toBe(media);
  });

  it("applies the safety limit to projected bytes rather than redundant canonical JSON", () => {
    const original = canonical(sampleRead);
    const projected = adaptMcpToolResult("claude", "workspace.read", {}, original);
    const size = Buffer.byteLength(JSON.stringify(projected));
    expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(size);
    expect(limitMcpToolResponse(projected, size + 1).limited).toBe(false);
    expect(limitMcpToolResponse(original, size + 1).limited).toBe(true);
  });
});
