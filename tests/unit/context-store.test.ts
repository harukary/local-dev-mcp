import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

describe("ChatContextStore", () => {
  it("restores the selected project for the same ChatGPT conversation", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-context-"));
    const persistencePath = join(tmpRoot, "chat-contexts.json");
    const first = new ChatContextStore(persistencePath);
    first.setCurrentProject("chatgpt-session:conv_123", "alpha");
    await first.save();

    const restored = new ChatContextStore(persistencePath);
    await restored.load();

    expect(restored.getCurrentProject("chatgpt-session:conv_123")).toBe("alpha");
  });

  it("creates a new context on getOrCreate", () => {
    const store = new ChatContextStore();
    const ctx = store.getOrCreate("chat_1");
    expect(ctx.chatContextId).toBe("chat_1");
    expect(ctx.currentProjectId).toBeUndefined();
  });

  it("returns existing context on getOrCreate", () => {
    const store = new ChatContextStore();
    const ctx1 = store.getOrCreate("chat_1");
    const ctx2 = store.getOrCreate("chat_1");
    expect(ctx1).toBe(ctx2);
  });

  it("sets current project", () => {
    const store = new ChatContextStore();
    store.setCurrentProject("chat_1", "frontend");
    expect(store.getCurrentProject("chat_1")).toBe("frontend");
  });

  it("returns undefined for unknown chat", () => {
    const store = new ChatContextStore();
    expect(store.getCurrentProject("nonexistent")).toBeUndefined();
  });

  it("records shell run timestamp", () => {
    const store = new ChatContextStore();
    store.setCurrentProject("chat_1", "frontend");
    store.recordShellRun("chat_1");
    const ctx = store.get("chat_1");
    expect(ctx?.lastShellRunAt).toBeDefined();
  });

  it("returns undefined for get on unknown chat", () => {
    const store = new ChatContextStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("clears stale current projects when the registry no longer has them", () => {
    const store = new ChatContextStore();
    store.setCurrentProject("chat_1", "frontend");
    store.setCurrentProject("chat_2", "backend");

    const cleared = store.pruneMissingCurrentProjects((projectId) => projectId !== "backend");

    expect(cleared).toEqual(["chat_2"]);
    expect(store.getCurrentProject("chat_1")).toBe("frontend");
    expect(store.getCurrentProject("chat_2")).toBeUndefined();
  });
});
