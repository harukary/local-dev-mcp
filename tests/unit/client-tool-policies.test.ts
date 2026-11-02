import { describe, expect, it } from "vitest";
import {
  buildToolDefinitions, isClientToolEnabled, isClaudeContextRequired,
  isMuseProjectScopedTool, supportsExplicitProjectScope,
} from "../../src/mcp/tool-definitions.js";

describe("authenticated client tool policy", () => {
  it("keeps the complete existing external tool surfaces but fails closed for new tool names", () => {
    const chatgpt = buildToolDefinitions("chatgpt").map((tool) => tool.name);
    const claude = buildToolDefinitions("claude").map((tool) => tool.name);
    const muse = buildToolDefinitions("muse").map((tool) => tool.name);
    expect(chatgpt).toHaveLength(82);
    expect(claude).toHaveLength(80);
    expect(muse).toHaveLength(75);
    expect(claude.every((name) => isClientToolEnabled("claude", name))).toBe(true);
    expect(muse.every((name) => isClientToolEnabled("muse", name))).toBe(true);
    for (const unknown of ["future.privileged", "shell.terminate_all", "project.erase", "browser.admin"]) {
      expect(isClientToolEnabled("claude", unknown)).toBe(false);
      expect(isClientToolEnabled("muse", unknown)).toBe(false);
    }
    expect(claude).not.toContain("artifact.receive");
    expect(claude).not.toContain("project.open");
    expect(muse).not.toContain("project.select");
    expect(muse).not.toContain("shell.approve");
    expect(muse).not.toContain("artifact.link");
    expect(muse).toContain("project.open");
    expect(chatgpt).toContain("artifact.receive");
    expect(chatgpt).toContain("artifact.link");
  });

  it("uses context handles only for Claude and explicit project scope only for Muse", () => {
    const name = "workspace.read";
    expect(supportsExplicitProjectScope(name)).toBe(true);
    const chatgpt = buildToolDefinitions("chatgpt").find((tool) => tool.name === name)!;
    const claude = buildToolDefinitions("claude").find((tool) => tool.name === name)!;
    const muse = buildToolDefinitions("muse").find((tool) => tool.name === name)!;
    expect(chatgpt.inputSchema.properties).toHaveProperty("project_id");
    expect(chatgpt.inputSchema.required).not.toContain("project_id");
    expect(chatgpt.inputSchema.properties).not.toHaveProperty("context_id");
    expect(claude.inputSchema.required).toContain("context_id");
    expect(claude.inputSchema.properties).not.toHaveProperty("project_id");
    expect(claude.inputSchema.properties).not.toHaveProperty("working_dir");
    expect(muse.inputSchema.required).toContain("project_id");
    expect(muse.inputSchema.properties).not.toHaveProperty("context_id");
    expect(isClaudeContextRequired(name)).toBe(true);
    expect(isMuseProjectScopedTool(name)).toBe(true);
    const resume = buildToolDefinitions("claude").find((tool) => tool.name === "project.select")!;
    expect(resume.inputSchema.properties).toHaveProperty("working_dir");
    expect(resume.inputSchema.properties).toHaveProperty("context_id");
  });
});
