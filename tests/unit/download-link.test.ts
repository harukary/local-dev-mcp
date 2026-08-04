import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDownloadLink, getCachedDownload, clearDownloadCacheForTests } from "../../src/mcp/tools/download-link.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

let tmpRoot = "";
let tmpOutside = "";
let previousPublicOrigin: string | undefined;

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  if (tmpOutside) rmSync(tmpOutside, { recursive: true, force: true });
  tmpRoot = "";
  tmpOutside = "";
  clearDownloadCacheForTests();
  if (previousPublicOrigin === undefined) {
    delete process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
  } else {
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = previousPublicOrigin;
  }
});

describe("handleDownloadLink", () => {
  it("creates a temporary download URL for a project file", async () => {
    previousPublicOrigin = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = "https://public.example.test/base";
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-download-"));
    mkdirSync(join(tmpRoot, "dist"));
    writeFileSync(join(tmpRoot, "dist", "report.txt"), "hello");
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleDownloadLink(ctx, "chat-a", { path: "dist/report.txt", ttl_seconds: 30 });
    const metadata = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(metadata).toMatchObject({
      project_id: "alpha",
      path: "dist/report.txt",
      size_bytes: 5,
      ttl_seconds: 30,
      filename: "report.txt",
    });
    expect(metadata.download_url).toMatch(/^https:\/\/public\.example\.test\/download\//);
    expect(metadata.markdown).toBe(`[report.txt](${metadata.download_url})`);
    const id = metadata.download_url.split("/").at(-1);
    expect(getCachedDownload(id)).toMatchObject({
      relativePath: "dist/report.txt",
      fileName: "report.txt",
      sizeBytes: 5,
    });
  });

  it("rejects paths outside the selected project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-download-"));
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleDownloadLink(ctx, "chat-a", { path: "../outside.txt" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("PATH_OUTSIDE_PROJECT");
  });

  it("allows an explicit 24-hour maximum TTL", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-download-"));
    writeFileSync(join(tmpRoot, "report.txt"), "hello");
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleDownloadLink(ctx, "chat-a", { path: "report.txt", ttl_seconds: 24 * 60 * 60 });
    const metadata = JSON.parse(result.content[0].text);

    expect(metadata.ttl_seconds).toBe(24 * 60 * 60);
  });

  it("rejects denied paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-download-"));
    writeFileSync(join(tmpRoot, ".env"), "SECRET=1");
    const { ctx } = createContext(createProject(tmpRoot, [".env*"]));

    const result = await handleDownloadLink(ctx, "chat-a", { path: ".env" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("DENIED_PATH");
  });

  it("rejects symlinks that resolve outside the selected project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-download-"));
    tmpOutside = mkdtempSync(join(tmpdir(), "local-dev-mcp-download-outside-"));
    writeFileSync(join(tmpOutside, "secret.txt"), "secret");
    symlinkSync(join(tmpOutside, "secret.txt"), join(tmpRoot, "link.txt"));
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleDownloadLink(ctx, "chat-a", { path: "link.txt" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("PATH_OUTSIDE_PROJECT");
  });
});

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);

  return {
    ctx: {
      registry: {
        has: (projectId: string) => projectId === project.projectId,
        get: (projectId: string) => (projectId === project.projectId ? project : undefined),
        getAll: () => [project],
      },
      contextStore,
      auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AppContext,
  };
}

function createProject(hostRoot: string, deniedPaths: string[] = []): ProjectConfig {
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "confirm",
    approvalMode: "catastrophic_only",
    deniedPaths,
    redactionProfile: "default",
  };
}
