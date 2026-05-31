import { describe, it, expect } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";

describe("ChatContextStore", () => {
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
