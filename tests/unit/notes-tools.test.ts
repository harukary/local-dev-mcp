import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleNotesCreateDraft, handleNotesGuidelines, handleNotesValidate } from "../../src/mcp/tools/notes/index.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function createProject(hostRoot: string, projectId = "homepage"): ProjectConfig {
  return {
    projectId,
    displayName: projectId,
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths: [".env", ".env.*", "secrets"],
    redactionProfile: "default",
  };
}

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);
  return {
    registry: {
      has: (projectId: string) => projectId === project.projectId,
      get: (projectId: string) => (projectId === project.projectId ? project : undefined),
      getAll: () => [project],
    },
    contextStore,
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("notes tools", () => {
  it("returns compact reusable notes writing guidelines", async () => {
    const result = await handleNotesGuidelines();
    const body = payload(result);

    expect(body.title).toBe("Notes writing guidelines");
    expect(body.text).toContain("Notes は、あとで再利用するための情報の圧縮。");
    expect(body.text).toContain("共有していない文脈を前提にしない");
    expect(body.text).toContain("対象・事実・差分・条件・制約・参照");
    expect(body.guidelines).toContain("一文に圧縮:");
  });

  it("creates a draft note under src/content/notes", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-notes-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleNotesCreateDraft(ctx, "chat-a", {
      title: "Astro Notes CMS",
      question: "How should notes be stored?",
      description: "A note about storing technical notes in Astro.",
      tags: ["astro", "notes"],
      source_urls: ["https://docs.astro.build/en/guides/content-collections/"],
      body: "## 結論\n\nContent Collections を使う。",
    });
    const body = payload(result);

    expect(body.created).toBe(true);
    expect(body.path).toBe("src/content/notes/astro-notes-cms.md");
    expect(body.preview_path).toBe("/notes/astro-notes-cms");
    expect(existsSync(join(tmpRoot, body.path))).toBe(true);
    const text = readFileSync(join(tmpRoot, body.path), "utf8");
    expect(text).toContain('title: "Astro Notes CMS"');
    expect(text).toContain('sourceUrls: ["https://docs.astro.build/en/guides/content-collections/"]');
    expect(text).toContain("draft: true");
  });

  it("generates a stable fallback slug for Japanese titles", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-notes-"));
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleNotesCreateDraft(ctx, "chat-a", { title: "技術ノートの作り方" });
    const body = payload(result);

    expect(body.slug).toMatch(/^note-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(body.path).toBe(`src/content/notes/${body.slug}.md`);
  });

  it("validates required note frontmatter", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-notes-"));
    const ctx = createContext(createProject(tmpRoot));
    await handleNotesCreateDraft(ctx, "chat-a", { title: "Validation Note", slug: "validation-note" });

    const result = await handleNotesValidate(ctx, "chat-a", {});
    const body = payload(result);

    expect(body.valid).toBe(true);
    expect(body.total_notes).toBe(1);
    expect(body.notes[0]).toMatchObject({
      path: "src/content/notes/validation-note.md",
      title: "Validation Note",
      confidence: "draft",
    });
  });

  it("is restricted to the homepage project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-notes-"));
    const ctx = createContext(createProject(tmpRoot, "alpha"));

    const result = await handleNotesCreateDraft(ctx, "chat-a", { title: "Nope" });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("NOT_HOMEPAGE_PROJECT");
  });
});
