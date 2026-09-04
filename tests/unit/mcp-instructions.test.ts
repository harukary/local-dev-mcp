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
    expect(client.getInstructions()).toContain("Ensure the target project is selected");
    expect(client.getInstructions()).toContain("Call skills.list once for the selected project");
    expect(client.getInstructions()).toContain("call skills.read for that exact SKILL.md");
    expect(client.getInstructions()).toContain("Do not read unrelated skills");
    expect(client.getInstructions()).toContain("Do not call skills.list again unless the selected project changes");
  });
});
