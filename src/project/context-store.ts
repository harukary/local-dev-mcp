import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ChatContext, ProjectId } from "../types.js";

export interface ContextStoreData {
  chatContexts: Record<string, ChatContext>;
}

export class ChatContextStore {
  private contexts: Map<string, ChatContext> = new Map();
  private persistencePath: string | null = null;

  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath ?? null;
  }

  async load(): Promise<void> {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    try {
      const raw = await readFile(this.persistencePath, "utf-8");
      const data: ContextStoreData = JSON.parse(raw);
      for (const [id, ctx] of Object.entries(data.chatContexts)) {
        this.contexts.set(id, ctx);
      }
    } catch {
      // ignore corrupt persistence file
    }
  }

  async save(): Promise<void> {
    if (!this.persistencePath) return;
    const data: ContextStoreData = {
      chatContexts: Object.fromEntries(this.contexts),
    };
    await writeFile(this.persistencePath, JSON.stringify(data, null, 2), "utf-8");
  }

  getOrCreate(chatContextId: string): ChatContext {
    let ctx = this.contexts.get(chatContextId);
    if (!ctx) {
      ctx = { chatContextId };
      this.contexts.set(chatContextId, ctx);
    }
    return ctx;
  }

  get(chatContextId: string): ChatContext | undefined {
    return this.contexts.get(chatContextId);
  }

  setCurrentProject(chatContextId: string, projectId: ProjectId, selectedBy: string = "user"): ChatContext {
    const ctx = this.getOrCreate(chatContextId);
    ctx.currentProjectId = projectId;
    ctx.selectedAt = new Date().toISOString();
    ctx.selectedBy = selectedBy;
    return ctx;
  }

  clearCurrentProject(chatContextId: string): void {
    const ctx = this.contexts.get(chatContextId);
    if (!ctx) return;
    delete ctx.currentProjectId;
    delete ctx.selectedAt;
    delete ctx.selectedBy;
  }

  getCurrentProject(chatContextId: string): ProjectId | undefined {
    return this.contexts.get(chatContextId)?.currentProjectId;
  }

  getActiveProject(chatContextId: string, isAvailable: (projectId: ProjectId) => boolean): ProjectId | undefined {
    const projectId = this.getCurrentProject(chatContextId);
    if (!projectId) {
      return undefined;
    }
    if (!isAvailable(projectId)) {
      this.clearCurrentProject(chatContextId);
      return undefined;
    }
    return projectId;
  }

  pruneMissingCurrentProjects(isAvailable: (projectId: ProjectId) => boolean): string[] {
    const cleared: string[] = [];
    for (const ctx of this.contexts.values()) {
      if (ctx.currentProjectId && !isAvailable(ctx.currentProjectId)) {
        this.clearCurrentProject(ctx.chatContextId);
        cleared.push(ctx.chatContextId);
      }
    }
    return cleared;
  }

  recordShellRun(chatContextId: string): void {
    const ctx = this.getOrCreate(chatContextId);
    ctx.lastShellRunAt = new Date().toISOString();
  }

  getAll(): Map<string, ChatContext> {
    return this.contexts;
  }
}
