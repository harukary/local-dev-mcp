import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type AppContext } from "../../src/mcp/server.js";
import { hashClaudeOwner } from "../../src/mcp/claude-context.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { ToolUsageMetrics } from "../../src/metrics/tool-usage.js";
import type { ProjectConfig } from "../../src/types.js";

const roots: string[] = [];
const active: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((close) => close()));
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-context-"));
  roots.push(root);
  const secondary = join(root, "secondary");
  mkdirSync(secondary);
  writeFileSync(join(root, "sample.txt"), "primary project\n");
  writeFileSync(join(root, "AGENTS.md"), "Primary project instructions: do not skip source evidence.\n");
  writeFileSync(join(root, "日本 語.md"), "before\nneedle in 日本語\nafter\nneedle again\n");
  writeFileSync(join(root, "long.txt"), "😀".repeat(25) + "\n");
  mkdirSync(join(root, ".agents", "skills", "fixture"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "fixture", "SKILL.md"), "---\nname: fixture\ndescription: test skill\n---\n\n# Complete fixture instructions\n");
  writeFileSync(join(secondary, "sample.txt"), "secondary project\n");
  const project = (id: string, path: string): ProjectConfig => ({
    projectId: id, displayName: id, hostRoot: path, sandboxRoot: path,
    sandboxType: "host", defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30,
    networkPolicy: "ask", writePolicy: "allow", approvalMode: "never",
    deniedPaths: [], redactionProfile: "default",
  });
  const projects = [project("primary", root), project("secondary", secondary)];
  const store = new ChatContextStore(join(root, "contexts.json"));
  const registry = {
    has: (id: string) => projects.some((p) => p.projectId === id),
    get: (id: string) => projects.find((p) => p.projectId === id),
    getAll: () => projects,
  };
  const audit = vi.fn().mockResolvedValue(undefined);
  return { root, store, registry, audit };
}

async function connect(
  f: ReturnType<typeof fixture>,
  profile: "claude" | "chatgpt",
  principal: string,
) {
  const metrics = new ToolUsageMetrics(join(f.root, `usage-${principal}.json`));
  const ctx = {
    registry: f.registry, contextStore: f.store,
    shellRunner: new ShellRunner(), auditLogger: { log: f.audit },
    toolUsageMetrics: metrics, clientProfile: profile,
    ...(profile === "claude" ? { claudeOwnerHash: hashClaudeOwner(principal) } : {}),
  } as unknown as AppContext;
  const server = createMcpServer(ctx);
  const client = new Client({ name: "claude-context-integration", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  active.push(async () => { await client.close(); await server.close(); metrics.flush(); });
  return client;
}

const getPayload = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;
const getText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";
const getTextPayload = (r: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(getText(r)) as Record<string, any>;
const getContextId = (r: { content: Array<{ type: string; text?: string }> }) =>
  getText(r).match(/(?:^|\n)Context ID: (ctx_[A-Za-z0-9_-]{43})(?:\n|$)/)?.[1];

describe("Claude explicit work contexts through real MCP dispatcher", () => {
  it("creates isolated projects, maintains cwd, supports explicit resume, and rejects default fallbacks", async () => {
    const f = fixture();
    // Existing ChatGPT state must never be inherited.
    f.store.setCurrentProject("default", "primary");
    const client = await connect(f, "claude", "owner-one");
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "workspace.read")?.inputSchema.required).toContain("context_id");
    expect(tools.some((t) => t.name === "artifact.link")).toBe(false);
    expect(tools.some((t) => t.name === "artifact.receive")).toBe(false);
    expect(tools.some((t) => t.name === "project.open")).toBe(false);
    const hiddenProjectOpen = await client.callTool({ name: "project.open", arguments: { project_id: "primary" } });
    expect(hiddenProjectOpen.isError).toBe(true);
    expect(getPayload(hiddenProjectOpen)).toMatchObject({ error: { code: "TOOL_UNAVAILABLE" } });
    const initial = await client.callTool({ name: "project.list", arguments: {} });
    expect(getPayload(initial).projects.every((p: { current: boolean }) => !p.current)).toBe(true);

    const first = await client.callTool({ name: "project.select", arguments: { project_id: "primary" } });
    expect(first.isError).toBeUndefined();
    const a = getContextId(first)!;
    expect(a).toMatch(/^ctx_[a-zA-Z0-9_-]{43}$/);
    expect(first.structuredContent).toBeUndefined();
    expect(getText(first)).toContain("Primary project instructions: do not skip source evidence.");
    expect(getText(first)).not.toContain("[available in structuredContent]");

    const second = await client.callTool({ name: "project.select", arguments: { project_id: "secondary" } });
    const b = getContextId(second)!;
    expect(b).not.toBe(a);

    const jobStarted = await client.callTool({
      name: "shell.run", arguments: { context_id: a, command: "printf hello", async: true },
    });
    expect(jobStarted.isError).toBeUndefined();
    const job = getTextPayload(jobStarted).job_id as string;
    expect(job).toMatch(/^[0-9a-f-]{36}$/);
    expect(getPayload(await client.callTool({
      name: "shell.status", arguments: { context_id: b, job_id: job },
    })).error.code).toBe("JOB_NOT_FOUND");
    expect(getPayload(await client.callTool({
      name: "shell.cancel", arguments: { context_id: b, job_id: job },
    })).error.code).toBe("JOB_NOT_FOUND");
    expect(getPayload(await client.callTool({
      name: "shell.status", arguments: { context_id: a, job_id: job },
    })).job_id).toBe(job);

    const firstRead = await client.callTool({ name: "workspace.read", arguments: { context_id: a, path: "sample.txt" } });
    const secondRead = await client.callTool({ name: "workspace.read", arguments: { context_id: b, path: "sample.txt" } });
    expect(firstRead.structuredContent).toBeUndefined();
    expect(getText(firstRead)).toContain("1 | primary project");
    expect(getText(secondRead)).toContain("1 | secondary project");

    const batch = await client.callTool({
      name: "workspace.batch", arguments: {
        context_id: b,
        requests: [{ tool: "workspace.read", arguments: { path: "sample.txt" } }],
      },
    });
    expect(batch.structuredContent).toBeUndefined();
    expect(getText(batch)).toContain("#0 workspace.read");
    expect(getText(batch)).toContain("1 | secondary project");
    const fullBatch = await client.callTool({ name: "workspace.batch", arguments: {
      context_id: b, detail: "full",
      requests: [{ tool: "workspace.read", arguments: { path: "sample.txt" } }],
    } });
    expect(getPayload(fullBatch).results[0].result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(getPayload(fullBatch).results[0].result.absolute_path).toContain("sample.txt");
    const nestedScope = await client.callTool({
      name: "workspace.batch", arguments: {
        context_id: b,
        requests: [{ tool: "workspace.read", arguments: { path: "sample.txt", project_id: "primary" } }],
      },
    });
    expect(getPayload(nestedScope).error.code).toBe("CONTEXT_PROJECT_CONFLICT");

    const missing = await client.callTool({ name: "workspace.read", arguments: { path: "sample.txt" } });
    expect(getPayload(missing).error.code).toBe("CONTEXT_ID_REQUIRED");
    const unknown = await client.callTool({ name: "workspace.read", arguments: { context_id: "ctx_" + "a".repeat(43), path: "sample.txt" } });
    expect(getPayload(unknown).error.code).toBe("CONTEXT_NOT_FOUND");
    const badScope = await client.callTool({ name: "workspace.read", arguments: { context_id: a, project_id: "secondary", path: "sample.txt" } });
    expect(getPayload(badScope).error.code).toBe("CONTEXT_PROJECT_CONFLICT");

    const resumed = await client.callTool({ name: "project.select", arguments: { context_id: a, project_id: "secondary" } });
    expect(getContextId(resumed)).toBe(a);
    expect(getText(resumed)).toContain("Changed: true");
    const after = await client.callTool({ name: "workspace.read", arguments: { context_id: a, path: "sample.txt" } });
    expect(getText(after)).toContain("secondary project");
    const wrongHandle = await client.callTool({ name: "project.select", arguments: { context_id: "ctx_invalid", project_id: "primary" } });
    expect(getPayload(wrongHandle).error.code).toBe("CONTEXT_NOT_FOUND");

    const hidden = await client.callTool({ name: "artifact.link", arguments: { context_id: a, path: "sample.txt" } });
    expect(getPayload(hidden).error.code).toBe("TOOL_UNAVAILABLE");
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: "local-dev-artifact://primary/sample.txt" })).rejects.toThrow("unavailable");
    await expect(client.readResource({ uri: "project://primary/status" })).rejects.toThrow("unavailable");

    const schema = await client.callTool({ name: "tool.schema", arguments: { prefix: "workspace.read" } });
    expect(getPayload(schema).schema_version).toBe("2026-11-01.1");
    expect(getPayload(schema).tools[0].inputSchema.required).toContain("context_id");
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(a);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(b);
  });

  it("returns real Unicode file/search/list/batch/skill results as complete model-readable text", async () => {
    const f = fixture();
    const client = await connect(f, "claude", "reader");
    const context_id = getContextId(await client.callTool({
      name: "project.select", arguments: { project_id: "primary" },
    }))!;
    const search = await client.callTool({
      name: "workspace.search", arguments: { context_id, query: "needle",
        path: "日本 語.md", context_lines: 1, max_results: 1 },
    });
    expect(search.structuredContent).toBeUndefined();
    expect(getText(search)).toContain("日本 語.md");
    expect(getText(search)).toContain("1 | before");
    expect(getText(search)).toContain("2 | needle in 日本語");
    expect(getText(search)).toContain("3 | after");
    expect(getText(search)).toContain("next_offset=1");

    const listing = await client.callTool({
      name: "workspace.list", arguments: { context_id, path: ".", depth: 1, max_entries: 100 },
    });
    expect(listing.structuredContent).toBeUndefined();
    expect(getText(listing)).toContain("日本 語.md [file]");

    const read = await client.callTool({
      name: "workspace.read", arguments: { context_id, path: "long.txt", max_bytes: 8 },
    });
    expect(read.structuredContent).toBeUndefined();
    expect(getText(read)).toContain("1 | 😀😀");
    expect(getText(read)).toContain("next: start_line=1 start_column=4");

    const batch = await client.callTool({
      name: "workspace.batch", arguments: {
        context_id, requests: [
          { tool: "workspace.read", arguments: { path: "sample.txt" } },
          { tool: "workspace.search", arguments: { query: "missing-needle" } },
          { tool: "workspace.read", arguments: { path: "does-not-exist.txt" } },
        ],
      },
    });
    expect(batch.structuredContent).toBeUndefined();
    const output = getText(batch);
    expect(output).toContain("#0 workspace.read");
    expect(output).toContain("#1 workspace.search");
    expect(output).toContain("0 matches");
    expect(output).toContain("#2 workspace.read");
    expect(output).toContain("READ_FAILED");

    const skill = await client.callTool({
      name: "skills.read", arguments: {
        path: join(f.root, ".agents", "skills", "fixture", "SKILL.md"),
      },
    });
    expect(skill.structuredContent).toBeUndefined();
    expect(getText(skill)).toContain("Source: ");
    expect(getText(skill)).toContain("# Complete fixture instructions");

    const missing = await client.callTool({
      name: "workspace.read", arguments: { context_id, path: "does-not-exist.txt" },
    });
    expect(getPayload(missing).error.code).toBe("READ_FAILED");
  });

  it("prevents a different verified Cloudflare user from using a valid context handle", async () => {
    const f = fixture();
    const owner = await connect(f, "claude", "owner");
    const other = await connect(f, "claude", "other");
    const context = getContextId(await owner.callTool({ name: "project.select", arguments: { project_id: "primary" } }))!;
    const bad = await other.callTool({ name: "workspace.read", arguments: { context_id: context, path: "sample.txt" } });
    expect(getPayload(bad).error.code).toBe("CONTEXT_NOT_FOUND");
    const retry = await other.callTool({ name: "project.select", arguments: { context_id: context, project_id: "primary" } });
    expect(getPayload(retry).error.code).toBe("CONTEXT_NOT_FOUND");
  });

  it("keeps the ChatGPT MCP tool surface and session scope unchanged", async () => {
    const f = fixture();
    f.store.setCurrentProject("chatgpt-session:expected", "primary");
    const client = await connect(f, "chatgpt", "legacy");
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "workspace.read")?.inputSchema.properties).not.toHaveProperty("context_id");
    expect(tools.some((t) => t.name === "artifact.link")).toBe(true);
    expect(tools.some((t) => t.name === "artifact.receive")).toBe(true);
    const result = await client.callTool({
      name: "workspace.read", arguments: { path: "sample.txt" },
      _meta: { "openai/session": "expected" },
    });
    expect(JSON.stringify(getPayload(result))).toContain("primary project");
    expect(result.content[0].text).toContain('"absolute_path"');
  });
});
