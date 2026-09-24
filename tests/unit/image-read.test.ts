import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleImageRead } from "../../src/mcp/tools/image-read.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

let tmpRoot = "";
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

function createPng(width = 1, height = 1): Buffer {
  const bytes = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63600000020001e221bc330000000049454e44ae426082", "hex");
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
  it("returns inline image content and metadata without public URLs or viewer metadata", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    const png = createPng(2, 3);
    writeFileSync(join(tmpRoot, "assets", "sample.png"), png);
    const { ctx } = createContext(createProject(tmpRoot));

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
      returned_image_size_bytes: png.length,
      returned_image_width: 2,
      returned_image_height: 3,
    });
    expect(metadata.display_url).toBeUndefined();
    expect(metadata.display_expires_at).toBeUndefined();
    expect(metadata.markdown).toBeUndefined();
    expect(result._meta).toBeUndefined();
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
  });

  it("can return metadata without inline image bytes", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    writeFileSync(join(tmpRoot, "assets", "sample.png"), createPng(2, 3));
    const { ctx } = createContext(createProject(tmpRoot));
    const result = await handleImageRead(ctx, "chat-a", { path: "assets/sample.png", mode: "metadata" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ path: "assets/sample.png", returned_image_mode: "metadata" });
    expect(result.content).toHaveLength(1);
  });

  it("can explicitly return the full original image", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    const png = createPng(2, 3);
    writeFileSync(join(tmpRoot, "assets", "sample.png"), png);
    const { ctx } = createContext(createProject(tmpRoot));
    const result = await handleImageRead(ctx, "chat-a", { path: "assets/sample.png", mode: "full" });
    expect(JSON.parse(result.content[0].text).returned_image_mode).toBe("full");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
  });

  it("rejects full inline images that would approach the Secure Tunnel response limit", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    mkdirSync(join(tmpRoot, "assets"));
    const png = Buffer.alloc(6 * 1024 * 1024 + 1);
    createPng(2, 3).copy(png, 0);
    writeFileSync(join(tmpRoot, "assets", "large.png"), png);
    const { ctx } = createContext(createProject(tmpRoot));
    const result = await handleImageRead(ctx, "chat-a", { path: "assets/large.png", mode: "full" });
    expect(JSON.parse(result.content[0].text).error.code).toBe("IMAGE_FULL_TOO_LARGE");
    expect(result.isError).toBe(true);
  });

  it("rejects paths outside the selected project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    const { ctx } = createContext(createProject(tmpRoot));
    const result = await handleImageRead(ctx, "chat-a", { path: "../outside.png" });
    expect(JSON.parse(result.content[0].text).error.code).toBe("PATH_OUTSIDE_PROJECT");
    expect(result.isError).toBe(true);
  });

  it("rejects denied image paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-image-"));
    writeFileSync(join(tmpRoot, "blocked.png"), createPng());
    const { ctx } = createContext(createProject(tmpRoot, ["blocked.*"]));
    const result = await handleImageRead(ctx, "chat-a", { path: "blocked.png" });
    expect(JSON.parse(result.content[0].text).error.code).toBe("DENIED_PATH");
    expect(result.isError).toBe(true);
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
