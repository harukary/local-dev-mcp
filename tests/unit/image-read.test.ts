import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { getCachedImage, handleImageRead } from "../../src/mcp/tools/image-read.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

let tmpRoot = "";
let previousPublicOrigin: string | undefined;

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
  if (previousPublicOrigin === undefined) {
    delete process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
  } else {
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = previousPublicOrigin;
  }
});

function createPng(width = 1, height = 1): Buffer {
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082",
    "hex"
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

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

describe("handleImageRead", () => {
  it("returns image content and metadata for a project image", async () => {
    previousPublicOrigin = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = "https://public.example.test/base";
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    writeFileSync(join(tmpRoot, "assets", "sample.png"), createPng(2, 3));
    const project = createProject(tmpRoot);
    const { ctx } = createContext(project);

    const result = await handleImageRead(ctx, "chat-a", { path: "assets/sample.png" });
    const metadata = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(metadata).toMatchObject({
      project_id: "alpha",
      path: "assets/sample.png",
      mime_type: "image/png",
      width: 2,
      height: 3,
      returned_image_mode: "full",
      returned_image_mime_type: "image/png",
      returned_image_size_bytes: createPng(2, 3).length,
      returned_image_width: 2,
      returned_image_height: 3,
    });
    expect(metadata.display_url).toMatch(/^https:\/\/public\.example\.test\/image-cache\//);
    expect(metadata.markdown).toBe(`![assets/sample.png](${metadata.display_url})`);
    expect(result.structuredContent).toMatchObject({
      display_url: metadata.display_url,
      path: "assets/sample.png",
    });
    expect(result._meta).toMatchObject({
      "openai/outputTemplate": "ui://local-dev-mcp/image-viewer.html",
      "openai/widgetAccessible": true,
      display_url: metadata.display_url,
      path: "assets/sample.png",
    });
    const cacheId = metadata.display_url.split("/").at(-1);
    expect(getCachedImage(cacheId)?.mimeType).toBe("image/png");
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(result.content[1].data).toBe(createPng(2, 3).toString("base64"));
  });

  it("can return metadata without inline image bytes", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    writeFileSync(join(tmpRoot, "assets", "sample.png"), createPng(2, 3));
    const project = createProject(tmpRoot);
    const { ctx } = createContext(project);

    const result = await handleImageRead(ctx, "chat-a", { path: "assets/sample.png", mode: "metadata" });
    const metadata = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(metadata).toMatchObject({
      path: "assets/sample.png",
      returned_image_mode: "metadata",
    });
    expect(result.content).toHaveLength(1);
  });

  it("can explicitly return the full original image", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    writeFileSync(join(tmpRoot, "assets", "sample.png"), createPng(2, 3));
    const project = createProject(tmpRoot);
    const { ctx } = createContext(project);

    const result = await handleImageRead(ctx, "chat-a", { path: "assets/sample.png", mode: "full" });
    const metadata = JSON.parse(result.content[0].text);

    expect(metadata.returned_image_mode).toBe("full");
    expect(result.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(result.content[1].data).toBe(createPng(2, 3).toString("base64"));
  });

  it("rejects paths outside the selected project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    const project = createProject(tmpRoot);
    const { ctx } = createContext(project);

    const result = await handleImageRead(ctx, "chat-a", { path: "../outside.png" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("PATH_OUTSIDE_PROJECT");
  });

  it("rejects denied image paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    writeFileSync(join(tmpRoot, ".env.png"), createPng());
    const project = createProject(tmpRoot, [".env*"]);
    const { ctx } = createContext(project);

    const result = await handleImageRead(ctx, "chat-a", { path: ".env.png" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("DENIED_PATH");
  });
});

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
