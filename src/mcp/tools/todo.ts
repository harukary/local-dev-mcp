import type { AppContext } from "../server.js";
import { jsonError, jsonResult } from "./dev/common.js";
import { operationSignal } from "../request-context.js";

type TodoItem = {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  note: string;
  completedAt: string | null;
  [key: string]: unknown;
};

type ChildInput = { title?: string; note?: string };

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function baseUrl(): string {
  return (process.env.TODO_SERVICE_URL?.trim() || "http://127.0.0.1:3457").replace(/\/+$/, "");
}

async function requestTodo(path: string, init: RequestInit = {}): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: init.signal ?? operationSignal(30_000),
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(`Todo service unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = await response.text();
  let payload: any = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(`Todo service returned invalid JSON (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Todo service request failed (HTTP ${response.status}).`);
  }
  return payload;
}

async function resolveProject(value: string, includeArchived = true): Promise<{ id: string; name: string }> {
  const data = await requestTodo(`/api/todos/projects?includeArchived=${includeArchived ? "true" : "false"}`);
  const normalized = value.trim().toLocaleLowerCase("ja");
  const matches = (data.projects as Array<{ id: string; name: string }>).filter(
    (project) => project.id === value || project.name.toLocaleLowerCase("ja") === normalized,
  );
  if (matches.length === 0) throw new Error(`Todo project not found: ${value}`);
  if (matches.length > 1) throw new Error(`Todo project name is ambiguous: ${value}`);
  return matches[0] as { id: string; name: string };
}

async function audit(ctx: AppContext, chatContextId: string, tool: string, event: string): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool,
    event,
  });
}

export async function handleTodoProjects(_ctx: AppContext, args: { include_archived?: boolean }) {
  const data = await requestTodo(`/api/todos/projects?includeArchived=${args.include_archived ? "true" : "false"}`);
  return jsonResult(data.projects);
}

export async function handleTodoList(_ctx: AppContext, args: { project?: string; completed?: boolean }) {
  if (args.completed && !args.project) {
    return jsonError("PROJECT_REQUIRED", "todo.list with completed=true requires project.");
  }
  if (args.completed) {
    const project = await resolveProject(required(args.project, "project"));
    const data = await requestTodo(`/api/todos/completed?projectId=${encodeURIComponent(project.id)}&limit=500`);
    return jsonResult(data.items);
  }
  const data = await requestTodo("/api/todos/bootstrap");
  if (!args.project) return jsonResult(data.items);
  const project = await resolveProject(required(args.project, "project"));
  return jsonResult((data.items as TodoItem[]).filter((item) => item.projectId === project.id));
}

export async function handleTodoGet(_ctx: AppContext, args: { todo_id?: string }) {
  const data = await requestTodo(`/api/todos/items/${encodeURIComponent(required(args.todo_id, "todo_id"))}`);
  return jsonResult(data.item);
}

export async function handleTodoCreate(
  ctx: AppContext,
  chatContextId: string,
  args: { project?: string; title?: string; note?: string; parent_id?: string },
) {
  const project = await resolveProject(required(args.project, "project"));
  const title = required(args.title, "title");
  const data = await requestTodo("/api/todos/items", {
    method: "POST",
    body: JSON.stringify({
      projectId: project.id,
      title,
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.parent_id ? { parentId: required(args.parent_id, "parent_id") } : {}),
    }),
  });
  await audit(ctx, chatContextId, "todo.create", "todo_created");
  return jsonResult(data.item);
}

export async function handleTodoUpdate(
  ctx: AppContext,
  chatContextId: string,
  args: { todo_id?: string; title?: string; note?: string },
) {
  const id = required(args.todo_id, "todo_id");
  if (args.title === undefined && args.note === undefined) {
    return jsonError("NO_CHANGES", "Provide title and/or note.");
  }
  const data = await requestTodo(`/api/todos/items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(args.title !== undefined ? { title: required(args.title, "title") } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    }),
  });
  await audit(ctx, chatContextId, "todo.update", "todo_updated");
  return jsonResult(data.item);
}

export async function handleTodoDecompose(
  ctx: AppContext,
  chatContextId: string,
  args: { todo_id?: string; children?: ChildInput[] },
) {
  const parentId = required(args.todo_id, "todo_id");
  if (!Array.isArray(args.children) || args.children.length === 0) {
    return jsonError("CHILDREN_REQUIRED", "Provide at least one child Todo.");
  }
  if (args.children.length > 50) {
    return jsonError("TOO_MANY_CHILDREN", "At most 50 children can be created at once.");
  }
  const children = args.children.map(child => ({ title: required(child.title, "child.title"), note: child.note }));
  const parentData = await requestTodo(`/api/todos/items/${encodeURIComponent(parentId)}`);
  const parent = parentData.item as TodoItem;
  if (parent.parentId) {
    return jsonError("PARENT_MUST_BE_TOP_LEVEL", "A child Todo cannot be decomposed further.");
  }
  const created: TodoItem[] = [];
  try {
    for (const child of children) {
      const data = await requestTodo("/api/todos/items", {
        method: "POST",
        body: JSON.stringify({
          projectId: parent.projectId,
          parentId,
          title: required(child.title, "child.title"),
          ...(child.note !== undefined ? { note: child.note } : {}),
        }),
      });
      created.push(data.item as TodoItem);
    }
    await audit(ctx, chatContextId, "todo.decompose", "todo_decomposed");
    return jsonResult({ parent, children: created });
  } catch (error) {
    return jsonError("TODO_DECOMPOSE_PARTIAL", error instanceof Error ? error.message : String(error), {
      parent_id: parentId, created_ids: created.map(item => item.id),
      next_child_index: created.length, failed_child_outcome: "unknown", retry_entire_request: false,
    });
  }
}

export async function handleTodoSetCompleted(
  ctx: AppContext,
  chatContextId: string,
  args: { todo_id?: string; completed?: boolean },
) {
  const id = required(args.todo_id, "todo_id");
  if (typeof args.completed !== "boolean") {
    return jsonError("COMPLETED_REQUIRED", "completed must be a boolean.");
  }
  const data = await requestTodo(`/api/todos/items/${encodeURIComponent(id)}/${args.completed ? "complete" : "reopen"}`, {
    method: "POST",
    body: "{}",
  });
  await audit(ctx, chatContextId, "todo.set_completed", args.completed ? "todo_completed" : "todo_reopened");
  return jsonResult(data.items);
}

export async function handleTodoMove(
  ctx: AppContext,
  chatContextId: string,
  args: { todo_id?: string; project?: string; parent_id?: string; index?: number },
) {
  const id = required(args.todo_id, "todo_id");
  const project = await resolveProject(required(args.project, "project"));
  if (args.index !== undefined && (!Number.isInteger(args.index) || args.index < 0)) {
    return jsonError("INVALID_INDEX", "index must be a non-negative integer.");
  }
  const data = await requestTodo(`/api/todos/items/${encodeURIComponent(id)}/move`, {
    method: "POST",
    body: JSON.stringify({
      projectId: project.id,
      ...(args.parent_id ? { parentId: required(args.parent_id, "parent_id") } : { parentId: null }),
      targetIndex: args.index ?? 999999,
    }),
  });
  await audit(ctx, chatContextId, "todo.move", "todo_moved");
  return jsonResult(data.items);
}

export async function handleTodoDelete(ctx: AppContext, chatContextId: string, args: { todo_id?: string }) {
  const data = await requestTodo(`/api/todos/items/${encodeURIComponent(required(args.todo_id, "todo_id"))}`, { method: "DELETE" });
  await audit(ctx, chatContextId, "todo.delete", "todo_deleted");
  return jsonResult(data.items);
}
