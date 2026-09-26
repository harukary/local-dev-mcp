import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { ProjectRegistry } from "../project/registry.js";
import type { ChatContextStore } from "../project/context-store.js";
import type { ShellRunner } from "../shell/runner.js";
import type { AuditLogger } from "../audit/audit-log.js";
import type { ToolUsageMetrics } from "../metrics/tool-usage.js";
import { handleProjectList } from "./tools/project-list.js";
import { handleProjectSelect } from "./tools/project-select.js";
import { handleProjectCurrent } from "./tools/project-current.js";
import { handleShellRun } from "./tools/shell-run.js";
import { handleImageRead } from "./tools/image-read.js";
import { handleArtifactLink, handleArtifactRead, handleArtifactResourceRead } from "./tools/artifact-read.js";
import { handleArtifactReceive, type OpenAiProvidedFile } from "./tools/artifact-receive.js";
import { handleShellApprove, handleShellReject } from "./tools/shell-approval.js";
import { handleShellStatus } from "./tools/shell-status.js";
import { handleShellCancel } from "./tools/shell-cancel.js";
import { listPendingRequests } from "../shell/approval.js";
import { getActiveJobs } from "../shell/job-manager.js";
import { handleProjectReload } from "./tools/project-reload.js";
import { handleSkillsList, handleSkillsRead } from "./tools/skills.js";
import { buildToolDefinitions, buildToolSchemaSnapshot, supportsExplicitProjectScope } from "./tool-definitions.js";
import { handleProjectInspect } from "./tools/dev/project-inspect.js";
import { handleWorkspaceRead } from "./tools/dev/workspace-read.js";
import { handleWorkspaceList } from "./tools/dev/workspace-list.js";
import { handleWorkspaceSearch } from "./tools/dev/workspace-search.js";
import { handleWorkspacePatch } from "./tools/dev/workspace-patch.js";
import { handleWorkspaceBatch, type ReadBatchItem } from "./tools/dev/batch.js";
import { runMobileToolOperation } from "./tools/mobile.js";
import { validateToolInput } from "./input-validation.js";
import { withRequestSignal } from "./request-context.js";
import { structuredTextFallback } from "./output.js";
import { jsonError } from "./tools/dev/common.js";
import { handleBrowserInteract } from "./tools/browser.js";
import { handleGitInspect, handleGitStatus, handleGitLog, handleGitShow, handleGitDiff, handleGitCommit, handleGitPush } from "./tools/dev/git.js";
import { beginBrowserOperationDrain, createBrowserLifecycleService, runBrowserToolOperation, handleBrowserStatus, handleBrowserStart, handleBrowserSessions, handleBrowserStop, handleBrowserScreenshot, handleBrowserOpen, handleBrowserTabs, handleBrowserTabOpen, handleBrowserTabUse, handleBrowserTabClose, handleBrowserDom, handleBrowserSelectors, handleBrowserClick, handleBrowserType, handleBrowserWait, handleBrowserEval, handleBrowserPress, handleBrowserReload, handleBrowserBack, handleBrowserForward } from "./tools/browser.js";
import { handleMobileStatus, handleMobileListDevices, handleMobileScreenshot, handleMobileSnapshot, handleMobileCurrentApp, handleMobileLogs, handleMobileStopApp, handleMobileRestartApp, handleMobileBoot, handleMobileLaunchApp, handleMobileOpenUrl, handleMobileTap, handleMobileTapElement, handleMobileType, handleMobileSwipe, handleMobilePress, handleMobileWait } from "./tools/mobile.js";
import { handleTodoProjects, handleTodoList, handleTodoGet, handleTodoCreate, handleTodoUpdate, handleTodoDecompose, handleTodoSetCompleted, handleTodoMove, handleTodoDelete } from "./tools/todo.js";
import { hashOpenAiSubject, OPENAI_TUNNEL_HEADER_NAME, resolveOpenAiSubjectAuthConfig, resolveOpenAiSubjectPolicy, resolveOpenAiTunnelAuthConfig, verifyOpenAiSubject, verifyOpenAiTunnelToken, type OpenAiSubjectPolicy, type OpenAiTunnelAuthConfig } from "./auth.js";
import { resolveWorkingDirectory } from "../project/working-directory.js";

export interface AppContext {
  configPath: string;
  registry: ProjectRegistry;
  contextStore: ChatContextStore;
  shellRunner: ShellRunner;
  auditLogger: AuditLogger;
  toolUsageMetrics: ToolUsageMetrics;
  allowedOpenAiSubject?: string;
  openAiSubjectPolicy?: OpenAiSubjectPolicy;
}

type CallToolMeta = Record<string, unknown> & {
  "openai/session"?: unknown;
  "openai/subject"?: unknown;
};

const SAFE_REQUEST_META_KEY_PATTERN = /^[A-Za-z0-9._/-]{1,128}$/;
const SCHEDULED_TASK_META_KEYS = [
  "openai/locale",
  "openai/userAgent",
  "openai/userLocation",
  "timezone",
] as const;

type OpenAiAuthorizationBasis = "owner_subject" | "scheduled_task_meta" | "tunnel_only" | "rejected";

function summarizeRequestMetaKeys(meta: CallToolMeta | undefined): {
  requestMetaKeys: string[];
  requestMetaUnknownKeyCount: number;
} {
  if (!meta || typeof meta !== "object") {
    return { requestMetaKeys: [], requestMetaUnknownKeyCount: 0 };
  }
  const keys = Object.keys(meta);
  const requestMetaKeys = keys.filter((key) => SAFE_REQUEST_META_KEY_PATTERN.test(key)).sort();
  return {
    requestMetaKeys,
    requestMetaUnknownKeyCount: keys.length - requestMetaKeys.length,
  };
}

export function resolveChatContextId(meta: CallToolMeta | undefined): string {
  const session = meta?.["openai/session"];
  if (typeof session === "string" && session.length > 0) {
    return `chatgpt-session:${session}`;
  }

  const subject = meta?.["openai/subject"];
  const subjectHash = hashOpenAiSubject(subject);
  if (subjectHash) {
    return `chatgpt-user:${subjectHash}`;
  }

  return "default";
}

export function isAuthorizedOpenAiSubject(meta: CallToolMeta | undefined, expectedSubject: string | undefined): boolean {
  if (!expectedSubject) return true;
  return verifyOpenAiSubject(meta?.["openai/subject"], expectedSubject);
}

export function isObservedScheduledTaskMeta(meta: CallToolMeta | undefined): boolean {
  if (!meta || typeof meta !== "object") return false;
  const keys = Object.keys(meta).sort();
  if (keys.length !== SCHEDULED_TASK_META_KEYS.length) return false;
  return SCHEDULED_TASK_META_KEYS.every((key, index) => keys[index] === key);
}

export function resolveRequestContextId(meta: CallToolMeta | undefined): string {
  return isObservedScheduledTaskMeta(meta) ? "chatgpt-scheduled-task:stateless" : resolveChatContextId(meta);
}

function resolveExplicitProjectScope(ctx: AppContext, name: string, args: Record<string, unknown>) {
  if (!supportsExplicitProjectScope(name)) return { ok: true as const, projectId: undefined, seed: undefined };

  const projectId = args.project_id;
  const workingDir = args.working_dir;
  if (projectId === undefined) {
    if (workingDir !== undefined) {
      return { ok: false as const, result: jsonError("PROJECT_ID_REQUIRED", "working_dir requires project_id for explicit project scope.") };
    }
    return { ok: true as const, projectId: undefined, seed: undefined };
  }

  const project = ctx.registry.get(projectId as string);
  if (!project) {
    return {
      ok: false as const,
      result: jsonError("PROJECT_NOT_FOUND", `Unknown project: "${String(projectId)}".`, {
        available_projects: ctx.registry.getAll().map((candidate) => candidate.projectId),
      }),
    };
  }

  const working = resolveWorkingDirectory(project, workingDir as string | undefined);
  if (!working.ok) return { ok: false as const, result: jsonError(working.code, working.message) };

  return {
    ok: true as const,
    projectId: project.projectId,
    seed: {
      currentProjectId: project.projectId,
      ...(working.relativePath === "." ? {} : { workingDirectory: working.relativePath }),
      selectedAt: new Date().toISOString(),
      selectedBy: "request",
    },
  };
}

export function resolveOpenAiAuthorization(
  meta: CallToolMeta | undefined,
  expectedSubject: string | undefined
): { authorized: boolean; basis: OpenAiAuthorizationBasis } {
  if (!expectedSubject) return { authorized: true, basis: "tunnel_only" };
  if (verifyOpenAiSubject(meta?.["openai/subject"], expectedSubject)) {
    return { authorized: true, basis: "owner_subject" };
  }
  if (isObservedScheduledTaskMeta(meta)) {
    return { authorized: true, basis: "scheduled_task_meta" };
  }
  return { authorized: false, basis: "rejected" };
}

async function requireAuthorizedOpenAiSubject(
  ctx: AppContext,
  meta: CallToolMeta | undefined,
  target: string
): Promise<void> {
  const authorization = resolveOpenAiAuthorization(meta, ctx.allowedOpenAiSubject);
  if (ctx.openAiSubjectPolicy || ctx.allowedOpenAiSubject) {
    const subjectHash = hashOpenAiSubject(meta?.["openai/subject"]);
    const metaKeySummary = summarizeRequestMetaKeys(meta);
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId: resolveRequestContextId(meta),
      tool: target,
      event: "openai_subject_authorization",
      enforcement: authorization.authorized ? "audit_only" : "blocked",
      openAiSubjectPresent: subjectHash !== undefined,
      ...(subjectHash ? { openAiSubjectHash: subjectHash } : {}),
      openAiSubjectAuthorized: authorization.authorized,
      openAiAuthorizationBasis: authorization.basis,
      ...metaKeySummary,
    });
  }
  if (authorization.authorized) return;
  throw new Error("Forbidden: this ChatGPT user is not authorized to use local-dev.");
}

export function isMcpDebugEnabled(): boolean {
  return process.env.LOCAL_DEV_MCP_DEBUG === "1";
}

const SERVER_INSTANCE_ID = randomUUID();
const SERVER_STARTED_AT = new Date().toISOString();

export function buildHealthStatus(): {
  ok: true;
  instance_id: string;
  started_at: string;
  uptime_seconds: number;
} {
  return {
    ok: true,
    instance_id: SERVER_INSTANCE_ID,
    started_at: SERVER_STARTED_AT,
    uptime_seconds: Math.floor(process.uptime()),
  };
}

export function sendStatelessMcpMethodNotAllowed(res: express.Response): void {
  res.set("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This stateless MCP endpoint accepts POST requests only.",
    },
    id: null,
  });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const MCP_HTTP_MAX_REQUEST_BYTES = 9 * 1024 * 1024;
export const MCP_TOOL_RESPONSE_MAX_BYTES = 9 * 1024 * 1024;

export function buildMcpRequestTooLargeError(contentLength?: number, maxBytes = MCP_HTTP_MAX_REQUEST_BYTES) {
  return {
    jsonrpc: "2.0" as const,
    error: {
      code: -32001,
      message: `MCP request body exceeds the local ${maxBytes}-byte safety limit.`,
      data: {
        code: "MCP_REQUEST_TOO_LARGE",
        max_bytes: maxBytes,
        ...(contentLength === undefined ? {} : { content_length: contentLength }),
      },
    },
    id: null,
  };
}

export function limitMcpToolResponse(result: any, maxBytes = MCP_TOOL_RESPONSE_MAX_BYTES): {
  result: any;
  attemptedResponseBytes: number;
  limited: boolean;
} {
  const attemptedResponseBytes = Buffer.byteLength(JSON.stringify(result));
  if (attemptedResponseBytes <= maxBytes) return { result, attemptedResponseBytes, limited: false };
  return {
    result: jsonError(
      "MCP_RESPONSE_TOO_LARGE",
      `Tool response would be ${attemptedResponseBytes} bytes, above the ${maxBytes}-byte Secure Tunnel safety limit. Reduce max_bytes/detail, use a bounded preview, or use a non-inline artifact workflow.`,
      { response_bytes: attemptedResponseBytes, max_bytes: maxBytes }
    ),
    attemptedResponseBytes,
    limited: true,
  };
}

function isLocalhostRequest(req: express.Request): boolean {
  const host = req.hostname || req.ip;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function debugMcpLog(message: string): void {
  if (isMcpDebugEnabled()) {
    console.error(message);
  }
}

export function sanitizeRequestUrlForLog(url: string): string {
  try {
    const parsed = new URL(url, "http://local.invalid");
    for (const key of parsed.searchParams.keys()) {
      if (["token", "access_token", "api_key", "key", "secret"].includes(key.toLowerCase())) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.replace(/([?&](?:token|access_token|api_key|key|secret)=)[^&]*/gi, "$1[REDACTED]");
  }
}

async function createAppContext(
  configPath: string,
  allowedOpenAiSubject?: string,
  openAiSubjectPolicy?: OpenAiSubjectPolicy
): Promise<AppContext> {
  const { ProjectRegistry } = await import("../project/registry.js");
  const { ChatContextStore } = await import("../project/context-store.js");
  const { ShellRunner } = await import("../shell/runner.js");
  const { AuditLogger } = await import("../audit/audit-log.js");
  const { ToolUsageMetrics } = await import("../metrics/tool-usage.js");

  const registry = await ProjectRegistry.load(configPath);
  const runtimeDir = join(homedir(), ".local-dev-mcp", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const contextStore = new ChatContextStore(join(runtimeDir, "chat-contexts.json"));
  await contextStore.load();
  const shellRunner = new ShellRunner();
  const auditLogger = new AuditLogger("./logs/audit.jsonl");
  const toolUsageMetrics = new ToolUsageMetrics("./logs/tool-usage.json");

  return { configPath, registry, contextStore, shellRunner, auditLogger, toolUsageMetrics, allowedOpenAiSubject, openAiSubjectPolicy };
}

export const SERVER_INSTRUCTIONS = `
For substantive work on a project:
1. In interactive chats, select the target project before using project-scoped tools. In ChatGPT Scheduled Tasks, project.select is intentionally stateless: pass project_id and optional working_dir directly on every project-scoped tool call.
2. Call skills.list once for the selected or explicitly scoped project near the start of the work.
3. Inspect the returned skill names and descriptions.
4. If a skill is relevant to the task, call skills.read for that exact SKILL.md before applying its workflow.
5. Do not read unrelated skills.
6. Do not call skills.list again unless the project changes, the Skills runtime is reloaded, or the available Skills may otherwise have changed.
7. When two or more independent workspace.read, workspace.search, or workspace.list operations are needed, prefer one workspace.batch call.
8. Use git.inspect/status/diff/log/show for read-only Git inspection. Use git.commit for normal commits of an already-reviewed staged snapshot; provide expected_head and expected_staged_fingerprint from git.status/git.inspect. Use git.push for normal pushes of the current branch to its configured upstream; provide the expected local HEAD. Use shell.run only for other Git writes or operations not covered by typed Git tools.
9. For long shell jobs, reuse shell.status cursors. For normal completion polling use wait_ms=30000 and output=none; keep max_bytes small unless output is needed.
10. For model-only inspection of a project image, try image.read first instead of materializing preemptively. If image.read returns preview_unavailable without inline ImageContent, or the client cannot expose the inline image reliably, artifact.link/resource materialization is a fallback only when the file is within the resource materialization size limit. If image.read reports IMAGE_TOO_LARGE, create or request a smaller local preview instead of trying to send the oversized original through the Secure Tunnel. Also materialize/download when a downstream operation genuinely requires file bytes and the file fits the tunnel-safe limit.
`.trim();

export function createMcpServer(ctx: AppContext): Server {
  const server = new Server(
    { name: "local-dev-mcp", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => withRequestSignal(extra.signal, async () => {
    const { name, arguments: providedArgs } = request.params;
    const args = { ...(providedArgs ?? {}) };
    const meta = request.params._meta as CallToolMeta | undefined;
    const chatContextId = resolveRequestContextId(meta);
    const statelessScheduledTask = isObservedScheduledTaskMeta(meta);
    const usageStartedAt = performance.now();
    const requestBytes = Buffer.byteLength(JSON.stringify(providedArgs ?? {}));

    try {
      await requireAuthorizedOpenAiSubject(ctx, meta, name);
      debugMcpLog(`[CallTool] ${name} chatContextId=${chatContextId} store=${ctx.contextStore.getAll().size}ctxs`);
      const invokeTool = async () => {
        extra.signal.throwIfAborted();
        switch (name) {
        case "workspace.batch":
          return await handleWorkspaceBatch(ctx, chatContextId, args as { requests?: ReadBatchItem[]; max_bytes?: number; detail?: "compact" | "full" });
        case "project.list":
          return await handleProjectList(ctx, chatContextId);

        case "project.select":
          if (statelessScheduledTask) {
            return jsonError(
              "STATELESS_PROJECT_CONTEXT",
              "ChatGPT Scheduled Task calls do not have a stable chat session identity, so project.select cannot persist. Pass project_id and optional working_dir directly on each project-scoped tool call."
            );
          }
          return await handleProjectSelect(ctx, chatContextId, args as { project_id: string; working_dir?: string });

        case "project.current":
          return await handleProjectCurrent(ctx, chatContextId, { stateless: statelessScheduledTask });

        case "project.reload":
          return await handleProjectReload(ctx, reloadProjectRegistry);

        case "skills.list":
          return await handleSkillsList(ctx, chatContextId, args as { path?: string; query?: string; scope?: "project" | "user" | "system"; detail?: "summary" | "full" });

        case "skills.read":
          return await handleSkillsRead(ctx, args as { path?: string; max_bytes?: number });

        case "project.inspect":
          return await handleProjectInspect(ctx, chatContextId);

        case "workspace.read":
          return await handleWorkspaceRead(ctx, chatContextId, args as { path?: string; start_line?: number; end_line?: number; max_bytes?: number });

        case "workspace.list":
          return await handleWorkspaceList(ctx, chatContextId, args as { path?: string; depth?: number; glob?: string; include_hidden?: boolean; include_artifacts?: boolean; max_entries?: number });

        case "workspace.search":
          return await handleWorkspaceSearch(ctx, chatContextId, args as { query?: string; path?: string; glob?: string; context_lines?: number; max_results?: number; regex?: boolean; case_sensitive?: boolean; include_hidden?: boolean; include_artifacts?: boolean });

        case "workspace.patch":
          return await handleWorkspacePatch(ctx, chatContextId, args as { patches?: Array<{ path?: string; expected_sha256?: string; replacement?: string }>; dry_run?: boolean });


        case "git.inspect":
          return await handleGitInspect(ctx, chatContextId, args as { include_untracked?: boolean; recent_commits?: number; include_worktrees?: boolean; include_diff_stat?: boolean });

        case "git.status":
          return await handleGitStatus(ctx, chatContextId, args as { include_untracked?: boolean });

        case "git.log":
          return await handleGitLog(ctx, chatContextId, args as { ref?: string; path?: string; limit?: number });

        case "git.show":
          return await handleGitShow(ctx, chatContextId, args as { ref?: string; path?: string; mode?: "patch" | "stat" | "name-status"; max_bytes?: number });

        case "git.diff":
          return await handleGitDiff(ctx, chatContextId, args as { path?: string; staged?: boolean; stat?: boolean; max_bytes?: number });

        case "git.commit":
          return await handleGitCommit(ctx, chatContextId, args as { expected_head?: string; expected_staged_fingerprint?: string; message?: string });

        case "git.push":
          return await handleGitPush(ctx, chatContextId, args as { expected_head?: string });


        case "browser.status":
          return await handleBrowserStatus(ctx, chatContextId);

        case "browser.start":
          return await handleBrowserStart(ctx, chatContextId, args as { url?: string; session_id?: string });

        case "browser.sessions":
          return await handleBrowserSessions(ctx, chatContextId);

        case "browser.stop":
          return await handleBrowserStop(ctx, chatContextId, args as { session_id?: string });

        case "browser.tabs":
          return await handleBrowserTabs(ctx, chatContextId, args as { session_id?: string });

        case "browser.tab.open":
          return await handleBrowserTabOpen(ctx, chatContextId, args as { url?: string });

        case "browser.tab.use":
          return await handleBrowserTabUse(ctx, chatContextId, args as { target_id?: string });

        case "browser.tab.close":
          return await handleBrowserTabClose(ctx, chatContextId, args as { target_id?: string });

        case "browser.dom":
          return await handleBrowserDom(ctx, chatContextId, args as { session_id?: string; selector?: string });

        case "browser.selectors":
          return await handleBrowserSelectors(ctx, chatContextId, args as { session_id?: string; limit?: number; query?: string });

        case "browser.interact":
          return await handleBrowserInteract(ctx, chatContextId, args);
        case "browser.click":
          return await handleBrowserClick(ctx, chatContextId, args as { session_id?: string; selector?: string; observe?: "none" | "after"; wait_ms?: number; wait_for?: { selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number } });

        case "browser.type":
          return await handleBrowserType(ctx, chatContextId, args as { session_id?: string; selector?: string; text?: string; submit?: boolean; observe?: "none" | "after"; wait_ms?: number; wait_for?: { selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number } });

        case "browser.wait":
          return await handleBrowserWait(ctx, chatContextId, args as { session_id?: string; selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number });

        case "browser.eval":
          return await handleBrowserEval(ctx, chatContextId, args as { session_id?: string; expression?: string });

        case "browser.press":
          return await handleBrowserPress(ctx, chatContextId, args as { session_id?: string; key?: string; selector?: string; observe?: "none" | "after"; wait_ms?: number });

        case "browser.reload":
          return await handleBrowserReload(ctx, chatContextId, args as { session_id?: string; observe?: "none" | "after"; wait_ms?: number });

        case "browser.back":
          return await handleBrowserBack(ctx, chatContextId, args as { session_id?: string; observe?: "none" | "after"; wait_ms?: number });

        case "browser.forward":
          return await handleBrowserForward(ctx, chatContextId, args as { session_id?: string; observe?: "none" | "after"; wait_ms?: number });

        case "browser.screenshot":
          return await handleBrowserScreenshot(ctx, chatContextId, args as { session_id?: string });

        case "browser.open":
          return await handleBrowserOpen(ctx, chatContextId, args as { url?: string; session_id?: string; observe?: "none" | "after"; wait_ms?: number; wait_for?: { selector?: string; text?: string; url_contains?: string; title_contains?: string; timeout_ms?: number } });

        case "mobile.status":
          return await handleMobileStatus(ctx, chatContextId);

        case "mobile.list_devices":
          return await handleMobileListDevices(ctx, chatContextId);

        case "mobile.screenshot":
          return await handleMobileScreenshot(ctx, chatContextId, args as { device?: string });

        case "mobile.snapshot":
          return await handleMobileSnapshot(ctx, chatContextId, args as { device?: string; query?: string; limit?: number });

        case "mobile.current_app":
          return await handleMobileCurrentApp(ctx, chatContextId, args as { device?: string });

        case "mobile.logs":
          return await handleMobileLogs(ctx, chatContextId, args as { device?: string; package?: string; query?: string; lines?: number });

        case "mobile.stop_app":
          return await handleMobileStopApp(ctx, chatContextId, args as { device?: string; app?: string });

        case "mobile.restart_app":
          return await handleMobileRestartApp(ctx, chatContextId, args as { device?: string; app?: string; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.boot":
          return await handleMobileBoot(ctx, chatContextId, args as { device?: string });

        case "mobile.launch_app":
          return await handleMobileLaunchApp(ctx, chatContextId, args as { device?: string; app?: string; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.open_url":
          return await handleMobileOpenUrl(ctx, chatContextId, args as { device?: string; url?: string; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.tap":
          return await handleMobileTap(ctx, chatContextId, args as { device?: string; x?: number; y?: number; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.tap_element":
          return await handleMobileTapElement(ctx, chatContextId, args as { device?: string; target?: string; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.type":
          return await handleMobileType(ctx, chatContextId, args as { device?: string; text?: string; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.swipe":
          return await handleMobileSwipe(ctx, chatContextId, args as { device?: string; x1?: number; y1?: number; x2?: number; y2?: number; duration_ms?: number; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.press":
          return await handleMobilePress(ctx, chatContextId, args as { device?: string; key?: "home" | "back"; observe?: "none" | "after"; wait_for?: { target: string; timeout_ms?: number } });

        case "mobile.wait":
          return await handleMobileWait(ctx, chatContextId, args as { device?: string; target?: string; timeout_ms?: number });

        case "todo.projects":
          return await handleTodoProjects(ctx, args as { include_archived?: boolean });

        case "todo.list":
          return await handleTodoList(ctx, args as { project?: string; completed?: boolean });

        case "todo.get":
          return await handleTodoGet(ctx, args as { todo_id?: string });

        case "todo.create":
          return await handleTodoCreate(ctx, chatContextId, args as { project?: string; title?: string; note?: string; parent_id?: string });

        case "todo.update":
          return await handleTodoUpdate(ctx, chatContextId, args as { todo_id?: string; title?: string; note?: string });

        case "todo.decompose":
          return await handleTodoDecompose(ctx, chatContextId, args as { todo_id?: string; children?: Array<{ title?: string; note?: string }> });

        case "todo.set_completed":
          return await handleTodoSetCompleted(ctx, chatContextId, args as { todo_id?: string; completed?: boolean });

        case "todo.move":
          return await handleTodoMove(ctx, chatContextId, args as { todo_id?: string; project?: string; parent_id?: string; index?: number });

        case "todo.delete":
          return await handleTodoDelete(ctx, chatContextId, args as { todo_id?: string });

        case "shell.run":
          return await handleShellRun(
            ctx,
            chatContextId,
            args as { command: string; timeout_seconds?: number; purpose?: string; async?: boolean; long_running?: boolean }
          );

        case "shell.status":
          return await handleShellStatus(args as { job_id: string; cursor?: string; wait_ms?: number; max_bytes?: number; output?: "all" | "none" | "tail" });

        case "shell.cancel":
          return await handleShellCancel(args as { job_id?: string; pid?: number });

        case "shell.approve":
          return await handleShellApprove(ctx, chatContextId, args as { approval_request_id: string });

        case "shell.reject":
          return await handleShellReject(ctx, chatContextId, args as { approval_request_id: string });

        case "shell.pending":
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { pending_requests: listPendingRequests(chatContextId) },
                  null,
                  2
                ),
              },
            ],
          };

        case "image.read":
          return await handleImageRead(
            ctx,
            chatContextId,
            args as { path?: string; mode?: "preview" | "full" | "metadata"; max_preview_edge?: number }
          );

        case "artifact.link":
          return await handleArtifactLink(ctx, chatContextId, args as { path?: string });

        case "artifact.read":
          return await handleArtifactRead(ctx, chatContextId, args as { path?: string; max_bytes?: number });

        case "artifact.receive":
          return await handleArtifactReceive(
            ctx,
            chatContextId,
            args as { file?: OpenAiProvidedFile; destination?: string; max_bytes?: number }
          );

        case "tool.usage": {
          const usage = ctx.toolUsageMetrics.view(args as { detail?: "summary" | "full"; project_id?: string; prefix?: string; limit?: number; recent_days?: number });
          return {
            structuredContent: usage,
            content: [{ type: "text", text: structuredTextFallback(usage) }],
          };
        }

        case "tool.schema": {
          await server.sendToolListChanged().catch(() => undefined);
          const schema = buildToolSchemaSnapshot(args as { prefix?: string; detail?: "summary" | "full" });
          return {
            structuredContent: schema,
            content: [{ type: "text", text: structuredTextFallback(schema) }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
        }
      };
      const invalid = validateToolInput(name, args);
      const explicitScope = invalid ? undefined : resolveExplicitProjectScope(ctx, name, args);
      const scopeRequired = !invalid && statelessScheduledTask && supportsExplicitProjectScope(name) && explicitScope?.ok && !explicitScope.projectId;
      const executeTool = async () => name.startsWith("browser.")
        ? await runBrowserToolOperation(chatContextId, name, invokeTool)
        : name.startsWith("mobile.")
          ? await runMobileToolOperation(ctx, chatContextId, name, args, invokeTool)
          : await invokeTool();

      let result: any;
      if (invalid) {
        result = jsonError("INVALID_ARGUMENT", invalid);
      } else if (explicitScope && !explicitScope.ok) {
        result = explicitScope.result;
      } else if (scopeRequired) {
        result = jsonError(
          "PROJECT_SCOPE_REQUIRED",
          "This ChatGPT Scheduled Task call is stateless. Pass project_id and optional working_dir directly on every project-scoped tool call."
        );
      } else if (statelessScheduledTask || explicitScope?.seed) {
        result = await ctx.contextStore.withTemporaryContext(chatContextId, explicitScope?.seed ?? {}, executeTool);
      } else {
        result = await executeTool();
      }
      const limitedResponse = limitMcpToolResponse(result);
      if (limitedResponse.limited) {
        await ctx.auditLogger.log({
          timestamp: new Date().toISOString(),
          chatContextId,
          tool: name,
          event: "tool_response_too_large",
          error: `response_bytes=${limitedResponse.attemptedResponseBytes} max_bytes=${MCP_TOOL_RESPONSE_MAX_BYTES}`,
        });
        result = limitedResponse.result;
      }
      let payload = result?.structuredContent;
      if (!payload) {
        try { payload = JSON.parse(result?.content?.find((item: { type: string }) => item.type === "text")?.text ?? "null"); } catch { /* Text-only tools need no JSON result. */ }
      }
      const failedJob = name === "shell.status" && ["failed", "timeout", "interrupted"].includes(payload?.status);
      const failed = result?.isError === true || failedJob || (name === "shell.run" && payload?.exit_code !== undefined && payload.exit_code !== 0);
      const textResponseBytes = Array.isArray(result?.content)
        ? result.content.reduce((sum: number, item: { type?: string; text?: string }) => sum + (item?.type === "text" && typeof item.text === "string" ? Buffer.byteLength(item.text) : 0), 0)
        : 0;
      const structuredResponseBytes = result?.structuredContent ? Buffer.byteLength(JSON.stringify(result.structuredContent)) : 0;
      ctx.toolUsageMetrics.record({
        tool: name,
        project_id: explicitScope?.ok && explicitScope.projectId
          ? explicitScope.projectId
          : statelessScheduledTask
            ? undefined
            : ctx.contextStore.getCurrentProject(chatContextId),
        duration_ms: performance.now() - usageStartedAt,
        failed,
        response_bytes: Buffer.byteLength(JSON.stringify(result)),
        request_bytes: requestBytes,
        structured_response_bytes: structuredResponseBytes,
        text_response_bytes: textResponseBytes,
        error_code: failed ? payload?.error?.code ?? payload?.observation?.error?.code ?? (failedJob ? `JOB_${String(payload.status).toUpperCase()}` : name === "shell.run" ? "SHELL_EXIT_NONZERO" : "TOOL_FAILED") : undefined,
      });
      return result;
    } catch (err) {
      ctx.toolUsageMetrics.record({
        tool: name,
        project_id: statelessScheduledTask
          ? (supportsExplicitProjectScope(name) && typeof args.project_id === "string" ? args.project_id : undefined)
          : ctx.contextStore.getCurrentProject(chatContextId),
        duration_ms: performance.now() - usageStartedAt,
        failed: true,
        response_bytes: 0,
        request_bytes: requestBytes,
        structured_response_bytes: 0,
        text_response_bytes: 0,
        error_code: "UNHANDLED_EXCEPTION",
      });
      const message = err instanceof Error ? err.message : String(err);
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: name,
        error: message,
      });
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const meta = request.params?._meta as CallToolMeta | undefined;
    const authorized = resolveOpenAiAuthorization(meta, ctx.allowedOpenAiSubject).authorized;
    if (ctx.openAiSubjectPolicy || ctx.allowedOpenAiSubject) {
      try {
        await requireAuthorizedOpenAiSubject(ctx, meta, "resources/list");
      } catch {
        return { resources: [] };
      }
    }
    if (!authorized) return { resources: [] };
    const projects = ctx.registry.getAll();
    const resources: Array<{ uri: string; name: string; mimeType: string }> = [];
    for (const p of projects) {
      resources.push({
        uri: `project://${p.projectId}/status`,
        name: `${p.displayName} — Status`,
        mimeType: "application/json",
      });
      resources.push({
        uri: `project://${p.projectId}/config`,
        name: `${p.displayName} — Config`,
        mimeType: "application/json",
      });
    }
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const meta = request.params._meta as CallToolMeta | undefined;
    await requireAuthorizedOpenAiSubject(ctx, meta, "resources/read");
    const uri = request.params.uri;
    if (uri.startsWith("local-dev-artifact://")) {
      const chatContextId = resolveRequestContextId(request.params._meta as CallToolMeta | undefined);
      return await handleArtifactResourceRead(ctx, chatContextId, uri);
    }

    const match = uri.match(/^project:\/\/([^/]+)\/(status|config)$/);
    if (!match) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    const [, projectId, type] = match;
    const project = ctx.registry.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (type === "status") {
      const activeJobs = getActiveJobs().filter((j) => j.projectId === projectId);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            project_id: project.projectId,
            display_name: project.displayName,
            cwd: project.hostRoot,
            sandbox_type: project.sandboxType,
            network_policy: project.networkPolicy,
            write_policy: project.writePolicy,
            approval_mode: project.approvalMode,
            active_jobs: activeJobs.map((j) => ({
              id: j.id,
              command: j.command,
              status: j.status,
              started_at: j.startedAt,
            })),
          }, null, 2),
        }],
      };
    }

    // type === "config"
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          project_id: project.projectId,
          display_name: project.displayName,
          host_root: project.hostRoot,
          sandbox_root: project.sandboxRoot,
          sandbox_type: project.sandboxType,
          default_shell: project.defaultShell,
          default_timeout_seconds: project.defaultTimeoutSeconds,
          max_timeout_seconds: project.maxTimeoutSeconds,
          network_policy: project.networkPolicy,
          write_policy: project.writePolicy,
          approval_mode: project.approvalMode,
          denied_paths: project.deniedPaths,
          redaction_profile: project.redactionProfile,
        }, null, 2),
      }],
    };
  });

  return server;
}

export async function startMcpServer(configPath: string): Promise<void> {
  const ctx = await createAppContext(configPath);
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  const browserLifecycle = await createBrowserLifecycleService();
  await browserLifecycle.start();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    browserLifecycle.stopTimer();
    const browserOperationsIdle = beginBrowserOperationDrain();
    void (async () => {
      const result = await withShutdownTimeout((async () => {
        await Promise.allSettled([transport.close(), server.close()]);
        await browserOperationsIdle;
        return await browserLifecycle.drain();
      })(), 55_000);
      if (result === "timeout") console.error("[BrowserLifecycle] shutdown drain timed out");
      else console.error("[BrowserLifecycle] shutdown drain", result);
    })().catch((error) => console.error("[BrowserLifecycle] shutdown drain failed", error)).finally(() => {
      try { ctx.toolUsageMetrics.flush(); } finally { process.exit(0); }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function normalizeHttpHost(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  if (!first) return null;
  try {
    const withScheme = first.includes("://") ? first : `http://${first}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedHttpHost(hostHeader: string | string[] | undefined): boolean {
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const host = normalizeHttpHost(hostValue);
  return host !== null && LOCAL_HOSTS.has(host);
}

function requireLoopbackHost(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (isAllowedHttpHost(req.headers.host)) {
    next();
    return;
  }
  debugMcpLog(`[HTTP] forbidden_host host=${normalizeHttpHost(req.headers.host) || "unknown"}`);
  res.status(403).json({
    error: "forbidden_host",
    message: "The HTTP MCP server accepts loopback Host headers only.",
  });
}

function buildHttpAuthMiddleware(authConfig: OpenAiTunnelAuthConfig): express.RequestHandler {
  return (req, res, next) => {
    const headerValue = req.headers[OPENAI_TUNNEL_HEADER_NAME];
    if (verifyOpenAiTunnelToken(headerValue, authConfig.token)) {
      next();
      return;
    }

    debugMcpLog(`[HTTP] invalid_openai_tunnel_token path=${sanitizeRequestUrlForLog(req.url)}`);
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({
      error: "invalid_tunnel_token",
      message: "A valid OpenAI Secure MCP Tunnel token is required.",
    });
  };
}

function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).method === "initialize"
  );
}

function parseRawBody(req: express.Request): unknown | undefined {
  const raw = req.body instanceof Buffer ? req.body.toString("utf-8") : "";
  return raw ? JSON.parse(raw) : undefined;
}

export async function startHttpServer(configPath: string, port: number): Promise<void> {
  const httpAuthConfig = resolveOpenAiTunnelAuthConfig();
  const subjectPolicy = resolveOpenAiSubjectPolicy();
  const subjectAuthConfig = subjectPolicy === "enforce" ? resolveOpenAiSubjectAuthConfig() : undefined;
  const requireHttpAuth = buildHttpAuthMiddleware(httpAuthConfig);
  const ctx = await createAppContext(configPath, subjectAuthConfig?.subject, subjectPolicy);
  const browserLifecycle = await createBrowserLifecycleService();
  const app = express();
  app.use(requireLoopbackHost);
  app.use((req, _res, next) => {
    const method = req.method;
    const sanitizedUrl = sanitizeRequestUrlForLog(req.url);
    const url = sanitizedUrl.length > 80 ? sanitizedUrl.slice(0, 80) + "..." : sanitizedUrl;
    const session = req.headers["mcp-session-id"] ? ` (session=${(req.headers["mcp-session-id"] as string).slice(0, 8)}...)` : "";
    debugMcpLog(`[HTTP] ${method} ${url}${session}`);
    next();
  });

  let inFlight = 0;

  function parseAndLimitMcpRequest(req: express.Request, res: express.Response, next: express.NextFunction): void {
    let parsed: unknown;
    try { parsed = parseRawBody(req); }
    catch { res.status(400).json({ error: "invalid_json" }); return; }
    res.locals.mcpParsed = parsed;
    if (inFlight >= 64) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "concurrency_limit", message: "Too many in-flight MCP requests." });
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  }

  app.post("/mcp", requireHttpAuth, express.raw({ type: "*/*", limit: MCP_HTTP_MAX_REQUEST_BYTES }), parseAndLimitMcpRequest, (req, res) => {
    handleMcpRequest(req, res, ctx).catch((err) => {
      console.error("MCP POST handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: String(err) });
      }
    });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const candidate = err as { type?: string; status?: number; statusCode?: number } | undefined;
    if (candidate?.type !== "entity.too.large" && candidate?.status !== 413 && candidate?.statusCode !== 413) {
      next(err);
      return;
    }
    const rawContentLength = req.headers["content-length"];
    const parsedContentLength = typeof rawContentLength === "string" ? Number.parseInt(rawContentLength, 10) : undefined;
    const contentLength = parsedContentLength !== undefined && Number.isFinite(parsedContentLength) ? parsedContentLength : undefined;
    console.error(`[MCP] request rejected: body too large content_length=${contentLength ?? "unknown"} max_bytes=${MCP_HTTP_MAX_REQUEST_BYTES}`);
    res.setHeader("Cache-Control", "no-store");
    res.status(413).json(buildMcpRequestTooLargeError(contentLength));
  });

  app.get("/mcp", requireHttpAuth, (_req, res) => {
    sendStatelessMcpMethodNotAllowed(res);
  });


  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(buildHealthStatus());
  });


  console.error(`[OpenAI Tunnel] Local MCP authentication enabled via ${OPENAI_TUNNEL_HEADER_NAME}.`);
  if (subjectPolicy === "enforce") {
    console.error("[OpenAI Tunnel] ChatGPT subject allowlist enabled for HTTP MCP tool and resource access.");
  } else {
    console.error("[OpenAI Tunnel] ChatGPT subject auditing enabled; authorization remains tunnel-token-only.");
  }

  const startupResult = await browserLifecycle.start();
  if (startupResult.recoveredProfileKeys.length || startupResult.stoppedProfileKeys.length || startupResult.failedProfileKeys.length) {
    console.error("[BrowserLifecycle] startup reconcile", startupResult);
  }

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listeningServer = app.listen(port, "127.0.0.1");
    listeningServer.once("error", reject);
    listeningServer.once("listening", () => resolve(listeningServer));
  });
  console.error(`MCP HTTP server listening on http://127.0.0.1:${port}/mcp (secure-tunnel-only)`);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("\n[Server] Shutting down...");
    browserLifecycle.stopTimer();
    const browserOperationsIdle = beginBrowserOperationDrain();
    void (async () => {
      return await withShutdownTimeout((async () => {
        const httpCloseMode = await closeHttpServerForShutdown(httpServer);
        if (httpCloseMode === "forced") console.error("[Server] Forced active HTTP connections closed during shutdown.");
        await browserOperationsIdle;
        return await browserLifecycle.drain();
      })(), 55_000);
    })().then((result) => {
      if (result === "timeout") console.error("[BrowserLifecycle] shutdown drain timed out");
      else console.error("[BrowserLifecycle] shutdown drain", result);
    }).catch((error) => console.error("[BrowserLifecycle] shutdown drain failed", error)).finally(() => {
      try { ctx.toolUsageMetrics.flush(); } finally { process.exit(0); }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

type ShutdownHttpServer = {
  close(callback: () => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

export async function closeHttpServerForShutdown(
  server: ShutdownHttpServer,
  graceMs = 2_000,
): Promise<"closed" | "forced"> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  server.closeIdleConnections?.();
  if (await withShutdownTimeout(closed, graceMs) !== "timeout") return "closed";
  server.closeAllConnections?.();
  await withShutdownTimeout(closed, Math.min(graceMs, 1_000));
  return "forced";
}

async function withShutdownTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleMcpRequest(
  req: express.Request,
  res: express.Response,
  ctx: AppContext
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const parsed = req.method === "POST" ? res.locals.mcpParsed : undefined;
  debugMcpLog(`[MCP] stateless request sessionId=${sessionId ?? "(none)"} isInit=${isInitializeRequest(parsed)}`);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const mcpServer = createMcpServer(ctx);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  };

  res.on("close", close);
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } finally {
    if (!res.writableEnded) {
      res.once("finish", close);
    } else {
      close();
    }
  }
}

async function reloadProjectRegistry(ctx: AppContext): Promise<string[]> {
  const projectIds = await ctx.registry.reload();
  ctx.contextStore.pruneMissingCurrentProjects((projectId) => ctx.registry.has(projectId));
  ctx.shellRunner.clearCache();
  return projectIds;
}
