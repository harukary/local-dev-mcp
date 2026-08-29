import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleArtifactReceive } from "../../src/mcp/tools/artifact-receive.js";
import { buildToolDefinitions } from "../../src/mcp/tool-definitions.js";
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

describe("artifact.receive", () => {
  it("publishes the ChatGPT file parameter extension with the provided-file schema", () => {
    const tool = buildToolDefinitions().find((candidate) => candidate.name === "artifact.receive");
    expect(tool).toBeDefined();
    expect(tool?._meta).toEqual({ "openai/fileParams": ["file"] });
    expect(tool?.inputSchema).toMatchObject({
      properties: {
        file: {
          type: "object",
          properties: {
            download_url: { type: "string" },
            file_id: { type: "string" },
            mime_type: { type: "string" },
            file_name: { type: "string" },
          },
          required: ["download_url", "file_id"],
          additionalProperties: false,
        },
      },
      required: ["file"],
    });
  });

  it("streams a provided ChatGPT file into the selected project in one call", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    const bytes = Buffer.from("hello from chatgpt\n");
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.length),
        "content-type": "text/plain; charset=utf-8",
      },
    })) as unknown as typeof fetch;
    const { ctx, auditLog } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://files.example.test/download/input.txt",
        file_id: "file_123",
        mime_type: "text/plain",
        file_name: "input.txt",
      },
      destination: "generated/uploads/input.txt",
    }, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.10"],
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      project_id: "alpha",
      path: "generated/uploads/input.txt",
      filename: "input.txt",
      file_id: "file_123",
      mime_type: "text/plain",
      size_bytes: bytes.length,
      source: "openai_file_param",
    });
    expect(result.structuredContent.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(tmpRoot, "generated/uploads/input.txt"))).toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "artifact.receive",
      command: "file_123 -> generated/uploads/input.txt",
    }));
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain("files.example.test");
  });

  it("generates a unique destination when none is supplied", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    const fetchImpl = vi.fn(async () => new Response("abc", { status: 200 })) as unknown as typeof fetch;
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://files.example.test/download/report.pdf",
        file_id: "file_456",
        file_name: "report.pdf",
      },
    }, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.11"],
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.path).toMatch(/^generated\/uploads\/\d+-[0-9a-f]{8}-report\.pdf$/);
    expect(readFileSync(join(tmpRoot, result.structuredContent.path), "utf8")).toBe("abc");
  });

  it("rejects local-network download URLs before fetching", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://127.0.0.1/input.bin",
        file_id: "file_local",
        file_name: "input.bin",
      },
    }, {
      fetchImpl,
      resolveHost: async () => ["127.0.0.1"],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("UNSAFE_DOWNLOAD_URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("revalidates redirect targets and blocks a redirect to a local address", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/redirected.bin" },
    })) as unknown as typeof fetch;
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://files.example.test/start",
        file_id: "file_redirect",
        file_name: "input.bin",
      },
    }, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.12"],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("UNSAFE_DOWNLOAD_URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized downloads before writing the body", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    const fetchImpl = vi.fn(async () => new Response("0123456789", {
      status: 200,
      headers: { "content-length": "10" },
    })) as unknown as typeof fetch;
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://files.example.test/large.bin",
        file_id: "file_large",
        file_name: "large.bin",
      },
      destination: "generated/uploads/large.bin",
      max_bytes: 5,
    }, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.13"],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("ARTIFACT_TOO_LARGE");
    expect(() => readFileSync(join(tmpRoot, "generated/uploads/large.bin"))).toThrow();
  });

  it("does not overwrite an existing destination", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    mkdirSync(join(tmpRoot, "generated/uploads"), { recursive: true });
    writeFileSync(join(tmpRoot, "generated/uploads/input.txt"), "existing");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://files.example.test/input.txt",
        file_id: "file_exists",
        file_name: "input.txt",
      },
      destination: "generated/uploads/input.txt",
    }, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.14"],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("FILE_EXISTS");
    expect(readFileSync(join(tmpRoot, "generated/uploads/input.txt"), "utf8")).toBe("existing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a destination parent that traverses a symlink", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-"));
    tmpOutside = mkdtempSync(join(tmpdir(), "local-dev-mcp-receive-outside-"));
    mkdirSync(join(tmpRoot, "generated"), { recursive: true });
    symlinkSync(tmpOutside, join(tmpRoot, "generated/uploads"));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { ctx } = createContext(createProject(tmpRoot));

    const result = await handleArtifactReceive(ctx, "chat-a", {
      file: {
        download_url: "https://files.example.test/input.txt",
        file_id: "file_symlink",
        file_name: "input.txt",
      },
      destination: "generated/uploads/input.txt",
    }, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.15"],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("SYMLINK_DESTINATION");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);
  const auditLog = vi.fn().mockResolvedValue(undefined);
  return {
    auditLog,
    ctx: {
      registry: {
        has: (projectId: string) => projectId === project.projectId,
        get: (projectId: string) => (projectId === project.projectId ? project : undefined),
        getAll: () => [project],
      },
      contextStore,
      auditLogger: { log: auditLog },
    } as unknown as AppContext,
  };
}

function createProject(hostRoot: string): ProjectConfig {
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
    deniedPaths: ["blocked/**"],
    redactionProfile: "default",
  };
}
