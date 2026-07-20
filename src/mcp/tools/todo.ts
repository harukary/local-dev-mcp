import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AppContext } from "../server.js";
import { jsonError, jsonResult } from "./dev/common.js";

const execFileAsync = promisify(execFile);

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

function resolveHaruclaw(ctx: AppContext) {
  const project = ctx.registry.get("haruclaw");
  if (!project) {
    throw new Error("The haruclaw project is not registered in local-dev-mcp.");
  }
  const executable = join(project.hostRoot, "bin", "haruclaw");
  if (!existsSync(executable)) {
    throw new Error(`haruclaw CLI not found: ${executable}`);
  }
  return { project, executable };
}

export async function runTodoCli(ctx: AppContext, args: string[]): Promise<any> {
  const { project, executable } = resolveHaruclaw(ctx);
  try {
    const result = await execFileAsync(executable, ["todo", ...args, "--json"], {
      cwd: project.hostRoot,
      env: process.env,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    const raw = result.stdout.trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    const stderr = failure.stderr?.trim();
    const stdout = failure.stdout?.trim();
    throw new Error(stderr || stdout || failure.message || "haruclaw todo command failed");
  }
}

async function audit(ctx: AppContext, chatContextId: string, tool: string, event: string): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool,
    event,
    projectId: "haruclaw",
  });
}

export async function handleTodoProjects(ctx: AppContext, args: { include_archived?: boolean }) {
  return jsonResult(await runTodoCli(ctx, ["projects", ...(args.include_archived ? ["--all"] : [])]));
}

export async function handleTodoList(ctx: AppContext, args: { project?: string; completed?: boolean }) {
  if (args.completed && !args.project) {
    return jsonError("PROJECT_REQUIRED", "todo.list with completed=true requires project.");
  }
  const cliArgs = ["list"];
  if (args.project) cliArgs.push("--project", required(args.project, "project"));
  if (args.completed) cliArgs.push("--completed");
  return jsonResult(await runTodoCli(ctx, cliArgs));
}

export async function handleTodoGet(ctx: AppContext, args: { todo_id?: string }) {
  return jsonResult(await runTodoCli(ctx, ["show", required(args.todo_id, "todo_id")]));
}

export async function handleTodoCreate(
  ctx: AppContext,
  chatContextId: string,
  args: { project?: string; title?: string; note?: string; parent_id?: string },
) {
  const project = required(args.project, "project");
  const title = required(args.title, "title");
  const cliArgs = ["add", "--project", project];
  if (args.parent_id) cliArgs.push("--parent", required(args.parent_id, "parent_id"));
  cliArgs.push(title);
  const created = (await runTodoCli(ctx, cliArgs)) as TodoItem;
  try {
    const result = args.note !== undefined
      ? await runTodoCli(ctx, ["note", created.id, args.note])
      : created;
    await audit(ctx, chatContextId, "todo.create", "todo_created");
    return jsonResult(result);
  } catch (error) {
    await runTodoCli(ctx, ["delete", created.id]).catch(() => undefined);
    throw error;
  }
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
  const before = (await runTodoCli(ctx, ["show", id])) as TodoItem;
  try {
    if (args.title !== undefined) await runTodoCli(ctx, ["edit", id, "--title", required(args.title, "title")]);
    const result = args.note !== undefined
      ? await runTodoCli(ctx, ["note", id, args.note])
      : await runTodoCli(ctx, ["show", id]);
    await audit(ctx, chatContextId, "todo.update", "todo_updated");
    return jsonResult(result);
  } catch (error) {
    if (args.title !== undefined) await runTodoCli(ctx, ["edit", id, "--title", before.title]).catch(() => undefined);
    if (args.note !== undefined) await runTodoCli(ctx, ["note", id, before.note]).catch(() => undefined);
    throw error;
  }
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
  const parent = (await runTodoCli(ctx, ["show", parentId])) as TodoItem;
  if (parent.parentId) {
    return jsonError("PARENT_MUST_BE_TOP_LEVEL", "A child Todo cannot be decomposed further.");
  }
  const created: TodoItem[] = [];
  try {
    for (const child of args.children) {
      const title = required(child.title, "child.title");
      let item = (await runTodoCli(ctx, [
        "add", "--project", parent.projectId, "--parent", parentId, title,
      ])) as TodoItem;
      created.push(item);
      if (child.note !== undefined) {
        item = (await runTodoCli(ctx, ["note", item.id, child.note])) as TodoItem;
        created[created.length - 1] = item;
      }
    }
    await audit(ctx, chatContextId, "todo.decompose", "todo_decomposed");
    return jsonResult({ parent, children: created });
  } catch (error) {
    for (const item of [...created].reverse()) {
      await runTodoCli(ctx, ["delete", item.id]).catch(() => undefined);
    }
    throw error;
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
  const result = await runTodoCli(ctx, [args.completed ? "done" : "reopen", id]);
  await audit(ctx, chatContextId, "todo.set_completed", args.completed ? "todo_completed" : "todo_reopened");
  return jsonResult(result);
}

export async function handleTodoMove(
  ctx: AppContext,
  chatContextId: string,
  args: { todo_id?: string; project?: string; parent_id?: string; index?: number },
) {
  const cliArgs = [
    "move",
    required(args.todo_id, "todo_id"),
    "--project",
    required(args.project, "project"),
  ];
  if (args.parent_id) cliArgs.push("--parent", required(args.parent_id, "parent_id"));
  if (args.index !== undefined) {
    if (!Number.isInteger(args.index) || args.index < 0) return jsonError("INVALID_INDEX", "index must be a non-negative integer.");
    cliArgs.push("--index", String(args.index));
  }
  const result = await runTodoCli(ctx, cliArgs);
  await audit(ctx, chatContextId, "todo.move", "todo_moved");
  return jsonResult(result);
}

export async function handleTodoDelete(ctx: AppContext, chatContextId: string, args: { todo_id?: string }) {
  const result = await runTodoCli(ctx, ["delete", required(args.todo_id, "todo_id")]);
  await audit(ctx, chatContextId, "todo.delete", "todo_deleted");
  return jsonResult(result);
}

export async function handleTodoDiscord(ctx: AppContext, chatContextId: string, args: { todo_id?: string }) {
  const result = await runTodoCli(ctx, ["discord", required(args.todo_id, "todo_id")]);
  await audit(ctx, chatContextId, "todo.discord", "todo_discord_thread_ensured");
  return jsonResult(result);
}
