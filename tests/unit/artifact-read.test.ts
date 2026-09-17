import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleArtifactLink, handleArtifactRead, handleArtifactResourceRead } from "../../src/mcp/tools/artifact-read.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

let tmpRoot = "";
let tmpOutside = "";

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  if (tmpOutside) rmSync(tmpOutside, { recursive: true, force: true });
  tmpRoot = "";
  tmpOutside = "";
});

describe("artifact.link", () => {
  it("returns a resource link without embedding file bytes in the tool result", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-link-"));
    mkdirSync(join(tmpRoot, "dist"));
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    writeFileSync(join(tmpRoot, "dist", "bundle.zip"), bytes);
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactLink(ctx, "chat-a", { path: "dist/bundle.zip" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      project_id: "alpha",
      path: "dist/bundle.zip",
      filename: "bundle.zip",
      mime_type: "application/zip",
      size_bytes: bytes.length,
      transport: "mcp_resource_link",
      uri: "local-dev-artifact://alpha/dist/bundle.zip",
    });
    expect(result.content[1]).toEqual(expect.objectContaining({
      type: "resource_link",
      uri: "local-dev-artifact://alpha/dist/bundle.zip",
      name: "bundle.zip",
      mimeType: "application/zip",
      size: bytes.length,
    }));
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("serves linked bytes only when the MCP client reads the resource URI", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-resource-"));
    const bytes = Buffer.from("resource-body");
    writeFileSync(join(tmpRoot, "artifact.bin"), bytes);
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactResourceRead(ctx, "chat-a", "local-dev-artifact://alpha/artifact.bin");

    expect(result.contents).toEqual([{
      uri: "local-dev-artifact://alpha/artifact.bin",
      mimeType: "application/octet-stream",
      blob: bytes.toString("base64"),
    }]);
  });
});

describe("artifact.read", () => {
  it("returns a binary file as an MCP embedded blob resource", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-"));
    mkdirSync(join(tmpRoot, "dist"));
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    writeFileSync(join(tmpRoot, "dist", "bundle.zip"), bytes);
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactRead(ctx, "chat-a", { path: "dist/bundle.zip" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      project_id: "alpha",
      path: "dist/bundle.zip",
      filename: "bundle.zip",
      mime_type: "application/zip",
      size_bytes: bytes.length,
      transport: "mcp_embedded_resource",
      encoding: "base64",
    });
    expect(result.structuredContent.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.structuredContent.uri).toBe("local-dev-artifact://alpha/dist/bundle.zip");
    expect(result.content[1]).toEqual(expect.objectContaining({
      type: "resource",
      resource: expect.objectContaining({
        uri: "local-dev-artifact://alpha/dist/bundle.zip",
        mimeType: "application/zip",
        blob: bytes.toString("base64"),
      }),
    }));
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("preserves an Office MIME type instead of treating docx as a generic zip", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-"));
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);
    writeFileSync(join(tmpRoot, "report.docx"), bytes);
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactRead(ctx, "chat-a", { path: "report.docx" });

    expect(result.structuredContent.mime_type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("rejects files above the MCP embedded-resource size limit", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-"));
    writeFileSync(join(tmpRoot, "large.bin"), Buffer.alloc(17));
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactRead(ctx, "chat-a", { path: "large.bin", max_bytes: 16 });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("ARTIFACT_TOO_LARGE");
  });

  it("rejects paths denied by project policy", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-"));
    writeFileSync(join(tmpRoot, "blocked.data"), "private-data");
    const { ctx } = createContext(createProject(tmpRoot, ["blocked.*"]));

    const result = await handleArtifactRead(ctx, "chat-a", { path: "blocked.data" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("DENIED_PATH");
  });

  it("rejects symlinks that resolve outside the selected project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-"));
    tmpOutside = mkdtempSync(join(tmpdir(), "local-dev-mcp-artifact-outside-"));
    writeFileSync(join(tmpOutside, "outside.bin"), "outside");
    symlinkSync(join(tmpOutside, "outside.bin"), join(tmpRoot, "link.bin"));
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactRead(ctx, "chat-a", { path: "link.bin" });
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
