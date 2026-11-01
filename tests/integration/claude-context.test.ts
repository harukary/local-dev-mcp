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
const getTextPayload = (r: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(r.content.find((c) => c.type === "text")?.text ?? "{}") as Record<string, any>;

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
    const initial = await client.callTool({ name: "project.list", arguments: {} });
    expect(getPayload(initial).projects.every((p: { current: boolean }) => !p.current)).toBe(true);

    const first = await client.callTool({ name: "project.select", arguments: { project_id: "primary" } });
    expect(first.isError).toBeUndefined();
    const a = getPayload(first).context_id as string;
    expect(a).toMatch(/^ctx_[a-zA-Z0-9_-]{43}$/);
    expect(getTextPayload(first).context_id).toBe(a);

    const second = await client.callTool({ name: "project.select", arguments: { project_id: "secondary" } });
    const b = getPayload(second).context_id as string;
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
    expect(JSON.stringify(getPayload(firstRead))).toContain("primary project");
    expect(JSON.stringify(getPayload(secondRead))).toContain("secondary project");

    const batch = await client.callTool({
      name: "workspace.batch", arguments: {
        context_id: b,
        requests: [{ tool: "workspace.read", arguments: { path: "sample.txt" } }],
      },
    });
    expect(getPayload(batch).results[0].result.lines[0].text).toContain("secondary project");
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
    expect(getPayload(resumed).context_id).toBe(a);
    expect(getPayload(resumed).changed).toBe(true);
    const after = await client.callTool({ name: "workspace.read", arguments: { context_id: a, path: "sample.txt" } });
    expect(JSON.stringify(getPayload(after))).toContain("secondary project");
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

  it("prevents a different verified Cloudflare user from using a valid context handle", async () => {
    const f = fixture();
    const owner = await connect(f, "claude", "owner");
    const other = await connect(f, "claude", "other");
    const context = getPayload(await owner.callTool({ name: "project.select", arguments: { project_id: "primary" } })).context_id;
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
  });
});
