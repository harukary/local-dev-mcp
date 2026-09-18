import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChatContext, ProjectId } from "../types.js";

export interface ContextStoreData {
  chatContexts: Record<string, ChatContext>;
}

export class ChatContextStore {
  private contexts: Map<string, ChatContext> = new Map();
  private scopedContexts = new AsyncLocalStorage<Map<string, ChatContext>>();
  private persistencePath: string | null = null;
  private pendingSave: Promise<void> = Promise.resolve();

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
    if (this.scopedContexts.getStore()) return;
    if (!this.persistencePath) return;
    const data: ContextStoreData = {
      chatContexts: Object.fromEntries(this.contexts),
    };
    const path = this.persistencePath;
    const content = JSON.stringify(data);
    const operation = this.pendingSave.catch(() => undefined).then(async () => {
      const temp = `${path}.tmp-${randomUUID()}`;
      try {
        await writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.pendingSave = operation;
    await operation;
  }

  async withTemporaryContext<T>(
    chatContextId: string,
    seed: Partial<ChatContext>,
    operation: () => Promise<T>
  ): Promise<T> {
    const scoped = new Map<string, ChatContext>();
    scoped.set(chatContextId, { ...seed, chatContextId });
    return await this.scopedContexts.run(scoped, operation);
  }

  private activeContexts(): Map<string, ChatContext> {
    return this.scopedContexts.getStore() ?? this.contexts;
  }

  getOrCreate(chatContextId: string): ChatContext {
    const contexts = this.activeContexts();
    let ctx = contexts.get(chatContextId);
    if (!ctx) {
      ctx = { chatContextId };
      contexts.set(chatContextId, ctx);
    }
    return ctx;
  }

  get(chatContextId: string): ChatContext | undefined {
    return this.activeContexts().get(chatContextId);
  }

  setCurrentProject(chatContextId: string, projectId: ProjectId, selectedBy: string = "user"): ChatContext {
    const ctx = this.getOrCreate(chatContextId);
    if (ctx.currentProjectId !== projectId) {
      delete ctx.workingDirectory;
    }
    ctx.currentProjectId = projectId;
    ctx.selectedAt = new Date().toISOString();
    ctx.selectedBy = selectedBy;
    return ctx;
  }

  setWorkingDirectory(chatContextId: string, workingDirectory: string | undefined, selectedBy: string = "user"): ChatContext {
    const ctx = this.getOrCreate(chatContextId);
    const normalized = workingDirectory?.trim();
    if (!normalized || normalized === ".") delete ctx.workingDirectory;
    else ctx.workingDirectory = normalized;
    ctx.selectedAt = new Date().toISOString();
    ctx.selectedBy = selectedBy;
    return ctx;
  }

  getWorkingDirectory(chatContextId: string): string | undefined {
    return this.activeContexts().get(chatContextId)?.workingDirectory;
  }

  clearCurrentProject(chatContextId: string): void {
    const ctx = this.activeContexts().get(chatContextId);
    if (!ctx) return;
    delete ctx.currentProjectId;
    delete ctx.workingDirectory;
    delete ctx.selectedAt;
    delete ctx.selectedBy;
  }

  getCurrentProject(chatContextId: string): ProjectId | undefined {
    return this.activeContexts().get(chatContextId)?.currentProjectId;
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
