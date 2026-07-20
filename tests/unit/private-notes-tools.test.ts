import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handlePrivateNotesCreate, handlePrivateNotesGuidelines, handlePrivateNotesValidate } from "../../src/mcp/tools/private-notes/index.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function createProject(hostRoot: string, projectId = "private-notes"): ProjectConfig {
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
    deniedPaths: [".env", ".env.*", ".wrangler", "secrets"],
    redactionProfile: "default",
  };
}

function createContext(project: ProjectConfig, selectedProjectId = project.projectId) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", selectedProjectId);
  return {
    registry: {
      has: (projectId: string) => projectId === project.projectId || projectId === selectedProjectId,
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

function scaffoldPrivateNotes(root: string) {
  mkdirSync(join(root, "public", "notes"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "private-notes" }));
  writeFileSync(join(root, "wrangler.toml"), "name = \"private-notes\"\n");
  writeFileSync(join(root, "public", "index.html"), "<!doctype html><html></html>\n");
  writeFileSync(join(root, "public", "styles.css"), "body { font-family: sans-serif; }\n");
}

describe("private notes tools", () => {
  it("returns private-notes operating guidelines", async () => {
    const result = await handlePrivateNotesGuidelines();
    const body = payload(result);

    expect(body.title).toBe("Private Notes operating guidelines");
    expect(body.text).toContain("private_notes.guidelines");
    expect(body.text).toContain("Cloudflare Access");
  });

  it("creates an HTML note and regenerates the index", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-private-notes-"));
    scaffoldPrivateNotes(tmpRoot);
    const ctx = createContext(createProject(tmpRoot), "some-other-project");

    const result = await handlePrivateNotesCreate(ctx, "chat-a", {
      title: "Shared Context",
      body_html: "        <p>ChatGPT と人間で共有する情報。</p>",
      date: "2026-06-28",
      slug: "shared-context",
      project: "alpha",
    });
    const body = payload(result);

    expect(body.created).toBe(true);
    expect(body.path).toBe("public/notes/alpha/2026-06-28-shared-context.html");
    expect(existsSync(join(tmpRoot, body.path))).toBe(true);
    const noteHtml = readFileSync(join(tmpRoot, body.path), "utf8");
    const indexHtml = readFileSync(join(tmpRoot, "public", "index.html"), "utf8");
    expect(noteHtml).toContain("<h1>Shared Context</h1>");
    expect(noteHtml).toContain('name="private-notes"');
    expect(noteHtml).toContain('data-project="alpha"');
    expect(indexHtml).toContain("/notes/alpha/2026-06-28-shared-context.html");
    expect(indexHtml).toContain('class="explorer"');
    expect(readFileSync(join(tmpRoot, "public", "databases", "alpha.html"), "utf8")).toContain("alpha Database");
    expect(readFileSync(join(tmpRoot, "public", "databases", "alpha.html"), "utf8")).toContain('class="database"');
    expect(readFileSync(join(tmpRoot, "public", "databases", "all.html"), "utf8")).toContain("All Notes");
  });

  it("validates the private-notes project shape and note index", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-private-notes-"));
    scaffoldPrivateNotes(tmpRoot);
    const ctx = createContext(createProject(tmpRoot), "some-other-project");
    await handlePrivateNotesCreate(ctx, "chat-a", {
      title: "Validation",
      body_html: "        <p>本文。</p>",
      date: "2026-06-28",
    });

    const result = await handlePrivateNotesValidate(ctx, "chat-a", {});
    const body = payload(result);

    expect(body.valid).toBe(true);
    expect(body.total_notes).toBe(1);
    expect(body.notes[0].type).toBe("note");
    expect(body.notes[0].status).toBe("draft");
    expect(body.notes[0].project).toBe("general");
    expect(body.privacy.cloudflare_access_verified).toBe(false);
  });

  it("rejects non private-notes projects", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-private-notes-"));
    mkdirSync(join(tmpRoot, "public", "notes"), { recursive: true });
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ name: "other-project" }));
    writeFileSync(join(tmpRoot, "wrangler.toml"), "name = \"other\"\n");
    const ctx = createContext(createProject(tmpRoot, "other-project"));

    const result = await handlePrivateNotesValidate(ctx, "chat-a", {});
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("PRIVATE_NOTES_PROJECT_NOT_FOUND");
  });
});
