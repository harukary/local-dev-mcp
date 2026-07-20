import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppContext } from "../../src/mcp/server.js";
import { buildToolDefinitions, TOOL_SCHEMA_VERSION } from "../../src/mcp/tool-definitions.js";
import {
  handleTodoCreate,
  handleTodoDecompose,
  handleTodoList,
  handleTodoSetCompleted,
} from "../../src/mcp/tools/todo.js";
import type { ProjectConfig } from "../../src/types.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

function project(hostRoot: string): ProjectConfig {
  return {
    projectId: "haruclaw",
    displayName: "haruclaw",
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths: [],
    redactionProfile: "default",
  };
}

function context(root: string): AppContext {
  const p = project(root);
  return {
    registry: {
      get: (id: string) => id === "haruclaw" ? p : undefined,
      has: (id: string) => id === "haruclaw",
      getAll: () => [p],
    },
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? "null");
}

function installFakeCli(root: string): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  const script = `#!/usr/bin/env python3
import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
state_path = os.path.join(root, "state.json")
log_path = os.path.join(root, "calls.jsonl")
args = sys.argv[1:]
with open(log_path, "a") as f: f.write(json.dumps(args) + "\\n")
try:
    state = json.load(open(state_path))
except Exception:
    state = {"next": 1, "items": {"parent-1": {"id":"parent-1","projectId":"recipie","parentId":None,"title":"Parent","note":"","completedAt":None}}}
if args and args[-1] == "--json": args = args[:-1]
if not args or args[0] != "todo":
    print("bad command", file=sys.stderr); sys.exit(2)
cmd = args[1]
rest = args[2:]
def save():
    json.dump(state, open(state_path, "w"))
def item(i):
    if i not in state["items"]: print("not found", file=sys.stderr); sys.exit(2)
    return state["items"][i]
if cmd == "projects":
    out = [{"id":"inbox","name":"Inbox"},{"id":"recipie","name":"recipie"}]
elif cmd == "list":
    out = list(state["items"].values())
elif cmd == "show":
    out = item(rest[0])
elif cmd == "add":
    project_id = rest[rest.index("--project") + 1]
    parent_id = rest[rest.index("--parent") + 1] if "--parent" in rest else None
    title = rest[-1]
    i = "item-" + str(state["next"]); state["next"] += 1
    out = {"id":i,"projectId":project_id,"parentId":parent_id,"title":title,"note":"","completedAt":None}
    state["items"][i] = out; save()
elif cmd == "note":
    out = item(rest[0]); out["note"] = " ".join(rest[1:]); save()
elif cmd == "edit":
    out = item(rest[0]); out["title"] = rest[rest.index("--title") + 1]; save()
elif cmd == "done":
    out = [item(rest[0])]; out[0]["completedAt"] = "now"; save()
elif cmd == "reopen":
    out = [item(rest[0])]; out[0]["completedAt"] = None; save()
elif cmd == "delete":
    out = [state["items"].pop(rest[0])]; save()
elif cmd == "move":
    out = [item(rest[0])]
elif cmd == "discord":
    out = {"discordUrl":"https://discord.test/thread"}
else:
    print("unsupported " + cmd, file=sys.stderr); sys.exit(2)
print(json.dumps(out))
`;
  const executable = join(root, "bin", "haruclaw");
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
}

describe("haruclaw Todo MCP tools", () => {
  it("publishes the dedicated Todo tool surface", () => {
    const names = buildToolDefinitions().map((tool) => tool.name);
    expect(TOOL_SCHEMA_VERSION).toBe("2026-07-20.2");
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
      "todo.discord",
    ]));
    expect(names.indexOf("todo.projects")).toBeLessThan(10);
    const deletion = buildToolDefinitions().find((tool) => tool.name === "todo.delete");
    expect(deletion?.annotations).toMatchObject({ destructiveHint: true });
  });

  it("creates a Todo with a note through the haruclaw CLI", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-todo-"));
    installFakeCli(tmpRoot);
    const ctx = context(tmpRoot);

    const result = payload(await handleTodoCreate(ctx, "chat-a", {
      project: "recipie",
      title: "取り込みを改善する",
      note: "完了条件",
    }));

    expect(result).toMatchObject({ projectId: "recipie", title: "取り込みを改善する", note: "完了条件" });
    expect(ctx.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ tool: "todo.create", event: "todo_created" }));
  });

  it("decomposes a parent into one-level child Todos", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-todo-"));
    installFakeCli(tmpRoot);
    const ctx = context(tmpRoot);

    const result = payload(await handleTodoDecompose(ctx, "chat-a", {
      todo_id: "parent-1",
      children: [
        { title: "URL抽出を改善する" },
        { title: "材料解析を改善する", note: "評価データを使う" },
      ],
    }));

    expect(result.parent.id).toBe("parent-1");
    expect(result.children).toHaveLength(2);
    expect(result.children[0]).toMatchObject({ parentId: "parent-1", projectId: "recipie" });
    expect(result.children[1].note).toBe("評価データを使う");
  });

  it("lists and completes Todos", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-todo-"));
    installFakeCli(tmpRoot);
    const ctx = context(tmpRoot);

    expect(payload(await handleTodoList(ctx, { project: "recipie" }))).toHaveLength(1);
    const completed = payload(await handleTodoSetCompleted(ctx, "chat-a", { todo_id: "parent-1", completed: true }));
    expect(completed[0].completedAt).toBe("now");

    const calls = readFileSync(join(tmpRoot, "calls.jsonl"), "utf8");
    expect(calls).toContain('"done"');
  });
});
