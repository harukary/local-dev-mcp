import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";
import { resolveWorkingDirectory } from "../../project/working-directory.js";

const MAX_AGENT_INSTRUCTIONS_BYTES = 64 * 1024;

type AgentInstructionSource = {
  scope: "global" | "project";
  path: string;
  content: string;
  truncated: boolean;
};

async function readInstructionFile(
  path: string,
  displayPath: string,
  scope: AgentInstructionSource["scope"]
): Promise<AgentInstructionSource | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;

    const bytesToRead = Math.min(info.size, MAX_AGENT_INSTRUCTIONS_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const file = await open(path, "r");
    try {
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
      return {
        scope,
        path: displayPath,
        content: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: info.size > MAX_AGENT_INSTRUCTIONS_BYTES,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function readProjectAgentInstructions(projectRoot: string, workingRoot: string) {
  const candidates = workingRoot === projectRoot
    ? [join(projectRoot, "AGENTS.md")]
    : [join(workingRoot, "AGENTS.md"), join(projectRoot, "AGENTS.md")];

  for (const path of candidates) {
    const source = await readInstructionFile(
      path,
      relative(projectRoot, path).replace(/\\/g, "/") || "AGENTS.md",
      "project"
    );
    if (source) return source;
  }

  return null;
}

async function readAgentInstructions(projectRoot: string, workingRoot: string) {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".haru", ".codex");
  const [globalInstructions, projectInstructions] = await Promise.all([
    readInstructionFile(join(codexHome, "AGENTS.md"), "$CODEX_HOME/AGENTS.md", "global"),
    readProjectAgentInstructions(projectRoot, workingRoot),
  ]);
  const sources = [globalInstructions, projectInstructions].filter(
    (source): source is AgentInstructionSource => source !== null
  );
  if (sources.length === 0) return null;

  const primary = projectInstructions ?? globalInstructions!;
  const content = sources.length === 1
    ? sources[0].content
    : `${sources.map((source) => source.content.replace(/\n+$/u, "")).join("\n\n")}\n`;

  return {
    path: primary.path,
    content,
    truncated: sources.some((source) => source.truncated),
    sources: sources.map(({ scope, path, truncated }) => ({ scope, path, truncated })),
  };
}

function jsonResult(value: Record<string, unknown>) {
  const agentInstructions = value.agent_instructions;
  const textValue = agentInstructions && typeof agentInstructions === "object"
    ? {
        ...value,
        agent_instructions: {
          path: (agentInstructions as { path?: unknown }).path,
          truncated: (agentInstructions as { truncated?: unknown }).truncated,
          sources: (agentInstructions as { sources?: unknown }).sources,
          content: "[available in structuredContent]",
        },
      }
    : value;

  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(textValue, null, 2) }],
  };
}

function jsonError(code: string, message: string, details?: Record<string, unknown>) {
  const value = { error: { code, message, ...(details ? { details } : {}) } };
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError: true,
  };
}

export async function handleProjectSelect(
  ctx: AppContext,
  chatContextId: string,
  args: { project_id: string; working_dir?: string }
) {
  const projectId = args?.project_id;
  if (!projectId) return jsonError("PROJECT_ID_REQUIRED", "Missing required argument: project_id");

  const project = ctx.registry.get(projectId);
  if (!project) {
    return jsonError("PROJECT_NOT_FOUND", `Unknown project: "${projectId}".`, {
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const working = resolveWorkingDirectory(project, args.working_dir);
  if (!working.ok) return jsonError(working.code, working.message);

  const previousProjectId = ctx.contextStore.getCurrentProject(chatContextId);
  const previousWorkingDir = ctx.contextStore.getWorkingDirectory?.(chatContextId);
  const nextWorkingDir = working.relativePath === "." ? undefined : working.relativePath;
  const changed = previousProjectId !== projectId || previousWorkingDir !== nextWorkingDir;
  if (changed) {
    ctx.contextStore.setCurrentProject(chatContextId, projectId);
    ctx.contextStore.setWorkingDirectory?.(chatContextId, nextWorkingDir);
    await ctx.contextStore.save();

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "project.select",
      projectId,
      cwd: working.hostRoot,
    };
    await ctx.auditLogger.log(entry);
  }

  const agentInstructions = await readAgentInstructions(project.hostRoot, working.hostRoot);

  return jsonResult({
    selected: true,
    changed,
    project_id: project.projectId,
    display_name: project.displayName,
    project_root: project.hostRoot,
    working_dir: working.relativePath,
    cwd: working.hostRoot,
    sandbox_type: project.sandboxType,
    agent_instructions: agentInstructions,
  });
}
