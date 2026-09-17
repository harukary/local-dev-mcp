import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createMcpServer, type AppContext } from "../../src/mcp/server.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { ToolUsageMetrics } from "../../src/metrics/tool-usage.js";
import type { ProjectConfig } from "../../src/types.js";
import { hashOpenAiSubject } from "../../src/mcp/auth.js";

it("enforces the ChatGPT subject allowlist through the actual dispatcher", async () => {
  const root = join(dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!), "subject-auth-protocol");
  await mkdir(root);
  await writeFile(join(root, "sample.txt"), "owner-only\n");
  const project: ProjectConfig = { projectId: "fixture", displayName: "Fixture", hostRoot: root, sandboxRoot: root, sandboxType: "host", defaultShell: "/bin/bash", defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, networkPolicy: "ask", writePolicy: "allow", approvalMode: "never", deniedPaths: [], redactionProfile: "default" };
  const contextStore = new ChatContextStore();
  const allowedSubject = "synthetic-owner";
  const rejectedSubject = "synthetic-rejected";
  contextStore.setCurrentProject(`chatgpt-user:${hashOpenAiSubject(allowedSubject)}`, "fixture");
  const metrics = new ToolUsageMetrics(join(root, "usage.json"), { flush_every: 1 });
  const auditLog = vi.fn();
  const server = createMcpServer({ registry: { has: () => true, get: () => project, getAll: () => [project] }, contextStore, shellRunner: new ShellRunner(), auditLogger: { log: auditLog }, toolUsageMetrics: metrics, allowedOpenAiSubject: allowedSubject } as unknown as AppContext);
  const client = new Client({ name: "local-subject-auth-regression", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);

    const denied = await client.callTool({ name: "project.list", arguments: {}, _meta: { "openai/subject": rejectedSubject } });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("not authorized") })]));

    const missing = await client.callTool({ name: "project.list", arguments: {} });
    expect(missing.isError).toBe(true);

    const allowed = await client.callTool({ name: "project.list", arguments: {}, _meta: { "openai/subject": allowedSubject } });
    expect(allowed.isError).toBeUndefined();

    const link = await client.callTool({ name: "artifact.link", arguments: { path: "sample.txt" }, _meta: { "openai/subject": allowedSubject } });
    expect(link.isError).toBeUndefined();
    await expect(client.readResource({ uri: "local-dev-artifact://fixture/sample.txt", _meta: { "openai/subject": rejectedSubject } })).rejects.toThrow("not authorized");
    const allowedResource = await client.readResource({ uri: "local-dev-artifact://fixture/sample.txt", _meta: { "openai/subject": allowedSubject } });
    expect(allowedResource.contents[0]).toMatchObject({ uri: "local-dev-artifact://fixture/sample.txt" });

    const entries = auditLog.mock.calls.map(([entry]) => entry);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "openai_subject_authorization", openAiSubjectHash: hashOpenAiSubject(allowedSubject), openAiSubjectPresent: true, openAiSubjectAuthorized: true }),
      expect.objectContaining({ event: "openai_subject_authorization", openAiSubjectHash: hashOpenAiSubject(rejectedSubject), openAiSubjectPresent: true, openAiSubjectAuthorized: false }),
      expect.objectContaining({ event: "openai_subject_authorization", openAiSubjectPresent: false, openAiSubjectAuthorized: false }),
    ]));
    expect(JSON.stringify(entries)).not.toContain(allowedSubject);
    expect(JSON.stringify(entries)).not.toContain(rejectedSubject);
  } finally { await client.close(); await server.close(); metrics.flush(); }
});

it("negotiates MCP, discovers tools, validates calls, and runs a bounded batch through the actual dispatcher", async () => {
  const root = join(dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!), "protocol");
  await mkdir(root);
  await writeFile(join(root, "sample.txt"), "alpha\nbeta\n");
  const project: ProjectConfig = { projectId: "fixture", displayName: "Fixture", hostRoot: root, sandboxRoot: root, sandboxType: "host", defaultShell: "/bin/bash", defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, networkPolicy: "ask", writePolicy: "allow", approvalMode: "never", deniedPaths: [], redactionProfile: "default" };
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("default", "fixture");
  const metrics = new ToolUsageMetrics(join(root, "usage.json"), { flush_every: 1 });
  const server = createMcpServer({ registry: { has: () => true, get: () => project, getAll: () => [project] }, contextStore, shellRunner: new ShellRunner(), auditLogger: { log: vi.fn() }, toolUsageMetrics: metrics } as unknown as AppContext);
  const client = new Client({ name: "local-protocol-regression", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const tools = (await client.listTools()).tools;
    expect(tools.some(tool => tool.name === "workspace.batch")).toBe(true);
    expect(tools.some(tool => tool.name === "artifact.link")).toBe(true);
    const invalid = await client.callTool({ name: "workspace.read", arguments: { path: 17 } });
    expect(invalid.isError).toBe(true);
    const result = await client.callTool({ name: "workspace.batch", arguments: { requests: [{ tool: "workspace.read", arguments: { path: "sample.txt", max_bytes: 5 } }, { tool: "workspace.list", arguments: {} }] } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ results: [{ tool: "workspace.read", result: { path: "sample.txt", lines: [{ line: 1, text: "alpha" }], truncated: true } }, { tool: "workspace.list" }] });
    const batch = result.structuredContent as { results: Array<{ result: Record<string, unknown> }> };
    expect(batch.results[0].result).not.toHaveProperty("project_id");
    expect(batch.results[0].result).not.toHaveProperty("absolute_path");
    expect(batch.results[1].result).not.toHaveProperty("project_id");

    const link = await client.callTool({ name: "artifact.link", arguments: { path: "sample.txt" } });
    expect(link.isError).toBeUndefined();
    const linkContent = link.content.find((item) => item.type === "resource_link");
    expect(linkContent).toMatchObject({
      type: "resource_link",
      uri: "local-dev-artifact://fixture/sample.txt",
      name: "sample.txt",
      mimeType: "text/plain; charset=utf-8",
    });
    expect(JSON.stringify(link)).not.toContain(Buffer.from("alpha\nbeta\n").toString("base64"));

    const resource = await client.readResource({ uri: "local-dev-artifact://fixture/sample.txt" });
    expect(resource.contents[0]).toMatchObject({
      uri: "local-dev-artifact://fixture/sample.txt",
      mimeType: "text/plain; charset=utf-8",
    });
    const blob = "blob" in resource.contents[0] ? resource.contents[0].blob : "";
    expect(Buffer.from(blob, "base64").toString("utf8")).toBe("alpha\nbeta\n");
    expect(metrics.snapshot().totals.measurements?.calls).toBe(3);
  } finally { await client.close(); await server.close(); metrics.flush(); }
});

it("audits HTTP subjects without changing an intentional tunnel-token-only policy", async () => {
  const root = join(dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!), "subject-audit-only-protocol");
  await mkdir(root);
  const project: ProjectConfig = { projectId: "fixture", displayName: "Fixture", hostRoot: root, sandboxRoot: root, sandboxType: "host", defaultShell: "/bin/bash", defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, networkPolicy: "ask", writePolicy: "allow", approvalMode: "never", deniedPaths: [], redactionProfile: "default" };
  const metrics = new ToolUsageMetrics(join(root, "usage.json"), { flush_every: 1 });
  const auditLog = vi.fn();
  const server = createMcpServer({ registry: { has: () => true, get: () => project, getAll: () => [project] }, contextStore: new ChatContextStore(), shellRunner: new ShellRunner(), auditLogger: { log: auditLog }, toolUsageMetrics: metrics, openAiSubjectPolicy: "tunnel_only" } as unknown as AppContext);
  const client = new Client({ name: "local-subject-audit-only-regression", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const subject = "synthetic-tunnel-user";
    const result = await client.callTool({ name: "project.list", arguments: {}, _meta: { "openai/subject": subject } });
    expect(result.isError).toBeUndefined();
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "openai_subject_authorization",
      openAiSubjectHash: hashOpenAiSubject(subject),
      openAiSubjectAuthorized: true,
    }));
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(subject);
  } finally { await client.close(); await server.close(); metrics.flush(); }
});
