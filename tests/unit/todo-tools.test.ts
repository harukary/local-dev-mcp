import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../../src/mcp/server.js";
import { buildToolDefinitions, TOOL_SCHEMA_VERSION } from "../../src/mcp/tool-definitions.js";
import {
  handleTodoCreate,
  handleTodoDecompose,
  handleTodoList,
  handleTodoSetCompleted,
} from "../../src/mcp/tools/todo.js";

type Item = {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  note: string;
  completedAt: string | null;
};

const projects = [
  { id: "inbox", name: "Inbox" },
  { id: "recipie-project", name: "recipie" },
];
let items: Record<string, Item>;
let nextId = 1;
let calls: Array<{ url: string; method: string; body: any }>;

function context(): AppContext {
  return {
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? "null");
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  items = {
    "parent-1": {
      id: "parent-1",
      projectId: "recipie-project",
      parentId: null,
      title: "Parent",
      note: "",
      completedAt: null,
    },
  };
  nextId = 1;
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: url.pathname + url.search, method, body });

    if (url.pathname === "/api/todos/projects") return response(200, { projects });
    if (url.pathname === "/api/todos/bootstrap") return response(200, { projects, items: Object.values(items), completedCounts: {} });
    if (url.pathname === "/api/todos/items" && method === "POST") {
      const id = `item-${nextId++}`;
      const item: Item = {
        id,
        projectId: body.projectId,
        parentId: body.parentId ?? null,
        title: body.title,
        note: body.note ?? "",
        completedAt: null,
      };
      items[id] = item;
      return response(201, { item });
    }
    const itemMatch = url.pathname.match(/^\/api\/todos\/items\/([^/]+)$/);
    if (itemMatch && method === "GET") {
      const item = items[decodeURIComponent(itemMatch[1]!)];
      return item ? response(200, { item }) : response(404, { error: "todo_item_not_found" });
    }
    if (itemMatch && method === "DELETE") {
      const id = decodeURIComponent(itemMatch[1]!);
      const item = items[id];
      if (!item) return response(404, { error: "todo_item_not_found" });
      delete items[id];
      return response(200, { items: [item] });
    }
    const completeMatch = url.pathname.match(/^\/api\/todos\/items\/([^/]+)\/(complete|reopen)$/);
    if (completeMatch && method === "POST") {
      const item = items[decodeURIComponent(completeMatch[1]!)];
      if (!item) return response(404, { error: "todo_item_not_found" });
      item.completedAt = completeMatch[2] === "complete" ? "now" : null;
      return response(200, { items: [item] });
    }
    return response(404, { error: "not_found" });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared Todo MCP tools", () => {
  it("validates every child before issuing a write", async () => {
    await expect(handleTodoDecompose(context(), "chat-a", { todo_id: "parent-1", children: [{ title: "valid" }, { title: "" }] })).rejects.toThrow("child.title");
    expect(calls).toHaveLength(0);
  });

  it("reports created children after a mid-request failure without deleting or replaying them", async () => {
    const original = globalThis.fetch;
    let writes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST" && ++writes === 2) throw new Error("connection lost");
      return original(input, init);
    }));
    const result = payload(await handleTodoDecompose(context(), "chat-a", { todo_id: "parent-1", children: [{ title: "first" }, { title: "second" }] }));
    expect(result.error).toMatchObject({ code: "TODO_DECOMPOSE_PARTIAL", details: { created_ids: ["item-1"], next_child_index: 1, failed_child_outcome: "unknown", retry_entire_request: false } });
    expect(items["item-1"]).toBeDefined();
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
  });
  it("publishes the Todo surface without Discord coupling", () => {
    const names = buildToolDefinitions().map((tool) => tool.name);
    expect(TOOL_SCHEMA_VERSION).toBe("2026-09-25.1");
    expect(names).toEqual(expect.arrayContaining([
      "todo.projects",
      "todo.list",
      "todo.get",
      "todo.create",
      "todo.update",
      "todo.decompose",
      "todo.set_completed",
      "todo.move",
      "todo.delete",
    ]));
    expect(names).not.toContain("todo.discord");
    expect(names.indexOf("todo.projects")).toBeLessThan(10);
    const deletion = buildToolDefinitions().find((tool) => tool.name === "todo.delete");
    expect(deletion?.annotations).toMatchObject({ destructiveHint: true });
  });

  it("creates a Todo with a note through the shared service", async () => {
    const ctx = context();
    const result = payload(await handleTodoCreate(ctx, "chat-a", {
      project: "recipie",
      title: "取り込みを改善する",
      note: "完了条件",
    }));
    expect(result).toMatchObject({ projectId: "recipie-project", title: "取り込みを改善する", note: "完了条件" });
    expect(calls.some((call) => call.url === "/api/todos/items" && call.method === "POST")).toBe(true);
    expect(ctx.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ tool: "todo.create", event: "todo_created" }));
  });

  it("decomposes a parent into one-level child Todos", async () => {
    const ctx = context();
    const result = payload(await handleTodoDecompose(ctx, "chat-a", {
      todo_id: "parent-1",
      children: [
        { title: "URL抽出を改善する" },
        { title: "材料解析を改善する", note: "評価データを使う" },
      ],
    }));
    expect(result.parent.id).toBe("parent-1");
    expect(result.children).toHaveLength(2);
    expect(result.children[0]).toMatchObject({ parentId: "parent-1", projectId: "recipie-project" });
    expect(result.children[1].note).toBe("評価データを使う");
  });

  it("lists and completes Todos", async () => {
    const ctx = context();
    expect(payload(await handleTodoList(ctx, { project: "recipie" }))).toHaveLength(1);
    const completed = payload(await handleTodoSetCompleted(ctx, "chat-a", { todo_id: "parent-1", completed: true }));
    expect(completed[0].completedAt).toBe("now");
    expect(calls.some((call) => call.url === "/api/todos/items/parent-1/complete")).toBe(true);
  });
});
