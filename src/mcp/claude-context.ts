import { createHash, randomBytes } from "node:crypto";
import type { ChatContextStore } from "../project/context-store.js";
import type { AppContext } from "./server.js";
import { resolveWorkingDirectory } from "../project/working-directory.js";
import { handleProjectSelect } from "./tools/project-select.js";
import { jsonError } from "./tools/dev/common.js";

const HANDLE_PATTERN = /^ctx_[A-Za-z0-9_-]{43}$/;

export function hashClaudeOwner(verifiedSubject: string): string {
  return createHash("sha256").update("cloudflare-access-sub:v1\0").update(verifiedSubject).digest("hex");
}

function internalContextId(handle: string): string {
  const hash = createHash("sha256").update("claude-work-context:v1\0").update(handle).digest("hex");
  return `claude-context:${hash}`;
}

export function createClaudeContext(store: ChatContextStore, ownerHash: string): {
  context_id: string;
  chatContextId: string;
} {
  if (!ownerHash) throw new Error("Verified Claude owner identity is required.");
  const context_id = `ctx_${randomBytes(32).toString("base64url")}`;
  const chatContextId = internalContextId(context_id);
  const context = store.getOrCreate(chatContextId);
  context.claudeOwnerHash = ownerHash;
  return { context_id, chatContextId };
}

export function resolveClaudeContext(
  store: ChatContextStore,
  ownerHash: string | undefined,
  handle: unknown
): string | undefined {
  if (!ownerHash || typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) return undefined;
  const id = internalContextId(handle);
  const entry = store.get(id);
  return entry?.claudeOwnerHash === ownerHash ? id : undefined;
}

export async function handleClaudeProjectSelect(
  ctx: AppContext,
  ownerHash: string | undefined,
  args: { project_id: string; working_dir?: string; context_id?: string }
) {
  if (!ownerHash) return jsonError("CONTEXT_NOT_FOUND", "A verified Claude user identity is required.");
  if (typeof args.project_id !== "string" || !args.project_id) {
    return jsonError("PROJECT_ID_REQUIRED", "Missing required argument: project_id");
  }
  let identity: { context_id: string; chatContextId: string };
  if (args.context_id !== undefined) {
    const resolved = resolveClaudeContext(ctx.contextStore, ownerHash, args.context_id);
    if (!resolved) return jsonError("CONTEXT_NOT_FOUND", "The requested work context is unavailable.");
    identity = { context_id: args.context_id, chatContextId: resolved };
  } else {
    // Validate the complete project selection before persisting any new work context.
    const project = ctx.registry.get(args.project_id);
    if (!project) return jsonError("PROJECT_NOT_FOUND", "Unknown project.", {
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
    const working = resolveWorkingDirectory(project, args.working_dir);
    if (!working.ok) return jsonError(working.code, working.message);
    identity = createClaudeContext(ctx.contextStore, ownerHash);
  }

  const result = await handleProjectSelect(ctx, identity.chatContextId, {
    project_id: args.project_id,
    working_dir: args.working_dir,
  });
  if ("isError" in result && result.isError) return result;
  const structuredContent = { ...result.structuredContent, context_id: identity.context_id };
  // Preserve the bounded existing text fallback (agent instructions are not duplicated).
  const originalText = JSON.parse(result.content[0].text) as Record<string, unknown>;
  return {
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify({ ...originalText, context_id: identity.context_id }) }],
  };
}
