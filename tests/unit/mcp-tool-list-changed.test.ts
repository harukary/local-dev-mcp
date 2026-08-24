import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { createMcpServer, type AppContext } from "../../src/mcp/server.js";

const closeables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close().catch(() => undefined)));
});

describe("MCP tool list changes", () => {
  it("advertises listChanged and refreshes tools when tool.schema is called", async () => {
    const contextStore = new ChatContextStore();
    const ctx = {
      registry: {
        getAll: () => [],
        get: () => undefined,
        has: () => false,
      },
      contextStore,
      shellRunner: {},
      auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
      toolUsageMetrics: {
        record: vi.fn(),
        snapshot: () => ({ version: 1, totals: { calls: 0 }, tools: {}, projects: {}, ratios: { shell_run_share: 0 } }),
      },
    } as unknown as AppContext;

    let refreshedTools: Array<{ name: string }> | null = null;
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      {
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (error, tools) => {
              expect(error).toBeNull();
              refreshedTools = tools?.map((tool) => ({ name: tool.name })) ?? null;
            },
          },
        },
      }
    );
    const server = createMcpServer(ctx);
    closeables.push(client, server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    await client.callTool({ name: "tool.schema", arguments: {} });

    await vi.waitFor(() => {
      expect(refreshedTools?.some((tool) => tool.name === "git.inspect")).toBe(true);
      expect(refreshedTools?.some((tool) => tool.name === "mobile.logs")).toBe(true);
      expect(refreshedTools?.some((tool) => tool.name === "tool.usage")).toBe(true);
    });
  });
});
