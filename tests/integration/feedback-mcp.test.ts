import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { FeedbackStore } from "../../src/feedback/store.js";
import { createMcpServer, type AppContext } from "../../src/mcp/server.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { ToolUsageMetrics } from "../../src/metrics/tool-usage.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("shares project-free reporting and updates across ChatGPT, Claude and Muse MCP clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "feedback-mcp-"));
  roots.push(root);
  const store = await FeedbackStore.open(join(root, "feedback.json"));
  const contextStore = new ChatContextStore();
  const metrics = new ToolUsageMetrics(join(root, "metrics.json"), { flush_every: 1 });
  const clients: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];
  const call = async (profile: "chatgpt" | "claude" | "muse", name: string, args: Record<string, unknown>) => {
    const context: AppContext = {
      configPath: "", registry: { has: (id: string) => id === "fixture", get: () => undefined, getAll: () => [] } as unknown as AppContext["registry"],
      contextStore, shellRunner: new ShellRunner(), auditLogger: { log: vi.fn() } as unknown as AppContext["auditLogger"],
      toolUsageMetrics: metrics, feedbackStore: store,
      turnLeaseManager: { check: () => undefined } as unknown as AppContext["turnLeaseManager"],
      clientProfile: profile,
    };
    const server = createMcpServer(context);
    const client = new Client({ name: `feedback-${profile}`, version: "1.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    clients.push({ client, server });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["feedback.report", "feedback.list", "feedback.update"]));
    return await client.callTool({ name, arguments: args });
  };
  try {
    const first = await call("chatgpt", "feedback.report", {
      kind: "bug", title: "Unexpected retry", description: "MCP call returns a persistent tool-specific failure.",
      related_tool: "workspace.batch",
    });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toMatchObject({ created: true, item: { status: "open", sources: ["chatgpt"] } });
    const id = (first.structuredContent as any).item.id as string;

    const second = await call("claude", "feedback.report", {
      kind: "bug", title: "Unexpected retry", description: "Same observed behavior.", related_tool: "workspace.batch",
    });
    expect(second.structuredContent).toMatchObject({ created: false, item: { id, occurrences: 2, sources: ["chatgpt", "claude"] } });

    const fetched = await call("muse", "feedback.list", {});
    expect(fetched.structuredContent).toMatchObject({ total: 1, items: [{ id, occurrences: 2 }] });

    const closed = await call("muse", "feedback.update", { id, status: "resolved", resolution: "Fixed and verified." });
    expect(closed.structuredContent).toMatchObject({ item: { id, status: "resolved" } });

    const reopened = await call("chatgpt", "feedback.report", {
      kind: "bug", title: "Unexpected retry", description: "Same failure has returned.",
      related_tool: "workspace.batch",
    });
    expect(reopened.structuredContent).toMatchObject({ created: false, reopened: true, item: { id, occurrences: 3, reopened: 1 } });
    const invalid = await call("muse", "feedback.report", {
      kind: "bug", title: "  ", description: "Whitespace-only title",
    });
    expect(invalid).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
    await expect((await FeedbackStore.open(join(root, "feedback.json"))).list({ status: "active" })).resolves.toMatchObject({ total: 1 });
  } finally {
    await Promise.all(clients.map(async ({ client, server }) => { await client.close(); await server.close(); }));
    metrics.flush();
  }
});
