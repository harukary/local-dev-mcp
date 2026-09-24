import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { createMcpServer, SERVER_INSTRUCTIONS, type AppContext } from "../../src/mcp/server.js";

const closeables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close().catch(() => undefined)));
});

describe("MCP server instructions", () => {
  it("advertises the project Skill discovery workflow during initialization", async () => {
    const ctx = {
      registry: {
        getAll: () => [],
        get: () => undefined,
        has: () => false,
      },
      contextStore: new ChatContextStore(),
      shellRunner: {},
      auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
      toolUsageMetrics: {
        record: vi.fn(),
        snapshot: () => ({ version: 1, totals: { calls: 0 }, tools: {}, projects: {}, ratios: { shell_run_share: 0 } }),
      },
    } as unknown as AppContext;

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const server = createMcpServer(ctx);
    closeables.push(client, server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getInstructions()).toContain("ChatGPT Scheduled Tasks");
    expect(client.getInstructions()).toContain("pass project_id and optional working_dir directly");
    expect(client.getInstructions()).toContain("Call skills.list once for the selected or explicitly scoped project");
    expect(client.getInstructions()).toContain("call skills.read for that exact SKILL.md");
    expect(client.getInstructions()).toContain("Do not read unrelated skills");
    expect(client.getInstructions()).toContain("Do not call skills.list again unless the project changes");
    expect(client.getInstructions()).toContain("Use git.inspect/status/diff/log/show for read-only Git inspection");
    expect(client.getInstructions()).toContain("wait_ms=30000 and output=none");
    expect(client.getInstructions()).toContain("For model-only inspection of a project image, try image.read first");
    expect(client.getInstructions()).toContain("IMAGE_TOO_LARGE");
    expect(client.getInstructions()).toContain("preview_unavailable");
    expect(client.getInstructions()).toContain("artifact.link/resource materialization is a fallback");
  });
});
