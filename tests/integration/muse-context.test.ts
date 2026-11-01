import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createMcpServer, type AppContext } from "../../src/mcp/server.js";
import { museWorkContextId } from "../../src/mcp/auth-muse.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { ToolUsageMetrics } from "../../src/metrics/tool-usage.js";
import type { ProjectConfig } from "../../src/types.js";

it("isolates Muse project calls without chat IDs or persisted selection", async () => {
  const root = join(dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!), "muse-context");
  const alphaRoot = join(root, "alpha");
  const betaRoot = join(root, "beta");
  await mkdir(alphaRoot, { recursive: true });
  await mkdir(betaRoot, { recursive: true });
  await writeFile(join(alphaRoot, "sample.txt"), "alpha-only\n");
  await writeFile(join(betaRoot, "sample.txt"), "beta-only\n");
  await writeFile(join(alphaRoot, "AGENTS.md"), "Only modify project alpha.\n");
  const project = (id: string, dir: string): ProjectConfig => ({
    projectId: id, displayName: id, hostRoot: dir, sandboxRoot: dir, sandboxType: "host",
    defaultShell: "/bin/bash", defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30,
    networkPolicy: "ask", writePolicy: "allow", approvalMode: "never", deniedPaths: [], redactionProfile: "default",
  });
  const projects = [project("alpha", alphaRoot), project("beta", betaRoot)];
  const contextStore = new ChatContextStore();
  const metrics = new ToolUsageMetrics(join(root, "usage.json"), { flush_every: 1 });
  const ownerHash = "b".repeat(64);
  const server = createMcpServer({
    registry: { has: (id: string) => projects.some(p => p.projectId === id),
      get: (id: string) => projects.find(p => p.projectId === id), getAll: () => projects },
    contextStore, shellRunner: new ShellRunner(), auditLogger: { log: vi.fn() },
    toolUsageMetrics: metrics, clientProfile: "muse", museOwnerHash: ownerHash,
  } as unknown as AppContext);
  const client = new Client({ name: "muse-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const tools = (await client.listTools()).tools;
    const names = tools.map(t => t.name);
    expect(names).toContain("project.open");
    expect(names).not.toContain("project.select");
    expect(names).not.toContain("project.current");
    expect(names).not.toContain("artifact.link");
    expect(names).not.toContain("shell.approve");
    expect(names).not.toContain("project.reload");
    expect(tools.find(t => t.name === "workspace.read")?.inputSchema.required).toContain("project_id");
    expect(tools.find(t => t.name === "browser.open")?.inputSchema.required).toContain("project_id");
    expect(tools.find(t => t.name === "shell.status")?.inputSchema.required).toContain("project_id");

    const opened = await client.callTool({ name: "project.open", arguments: { project_id: "alpha" } });
    expect(opened.isError).toBeUndefined();
    expect(opened.structuredContent).toBeUndefined();
    expect(opened.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Only modify project alpha.") });
    expect(opened.content[0]).toMatchObject({ type: "text", text: expect.not.stringContaining("Context ID") });

    const missing = await client.callTool({ name: "workspace.read", arguments: { path: "sample.txt" } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ text: expect.stringContaining("project_id") });
    const wrong = await client.callTool({ name: "workspace.read", arguments: { path: "sample.txt", project_id: "not-registered" } });
    expect(wrong.isError).toBe(true);
    const [alpha, beta] = await Promise.all([
      client.callTool({ name: "workspace.read", arguments: { path: "sample.txt", project_id: "alpha" } }),
      client.callTool({ name: "workspace.read", arguments: { path: "sample.txt", project_id: "beta" } }),
    ]);
    expect(alpha.isError).toBeUndefined();
    expect(beta.isError).toBeUndefined();
    expect(alpha.content[0]).toMatchObject({ text: expect.stringContaining("alpha-only") });
    expect(beta.content[0]).toMatchObject({ text: expect.stringContaining("beta-only") });
    expect(alpha.structuredContent).toBeUndefined();

    const lostJob = await client.callTool({ name: "shell.status", arguments: { project_id: "alpha", job_id: "unknown" } });
    expect(lostJob.content[0]).toMatchObject({ text: expect.stringContaining("JOB_NOT_FOUND") });
    expect(contextStore.getAll().size).toBe(0);
    expect(contextStore.getCurrentProject(museWorkContextId(ownerHash, "alpha"))).toBeUndefined();
  } finally {
    await client.close(); await server.close(); metrics.flush();
  }
});
