import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import cors from "cors";
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
import { handleArtifactRead } from "./tools/artifact-read.js";
import { handleArtifactReceive, type OpenAiProvidedFile } from "./tools/artifact-receive.js";
import { handleShellApprove, handleShellReject } from "./tools/shell-approval.js";
import { handleShellStatus } from "./tools/shell-status.js";
import { handleShellCancel } from "./tools/shell-cancel.js";
import { listPendingRequests } from "../shell/approval.js";
import { getActiveJobs } from "../shell/job-manager.js";
import { handleProjectReload } from "./tools/project-reload.js";
import { handleSkillsList, handleSkillsRead } from "./tools/skills.js";
import { buildToolDefinitions, buildToolSchemaSnapshot } from "./tool-definitions.js";
import { handleProjectInspect } from "./tools/dev/project-inspect.js";
import { handleWorkspaceRead } from "./tools/dev/workspace-read.js";
import { handleWorkspaceList } from "./tools/dev/workspace-list.js";
import { handleWorkspaceSearch } from "./tools/dev/workspace-search.js";
import { handleWorkspacePatch } from "./tools/dev/workspace-patch.js";
import { handleGitInspect, handleGitStatus, handleGitLog, handleGitShow, handleGitDiff } from "./tools/dev/git.js";
import { handleNotesCreate, handleNotesGuidelines, handleNotesValidate } from "./tools/notes/index.js";
import { handlePrivateNotesCreate, handlePrivateNotesGuidelines, handlePrivateNotesValidate } from "./tools/private-notes/index.js";
import { beginBrowserOperationDrain, createBrowserLifecycleService, runBrowserToolOperation, handleBrowserStatus, handleBrowserStart, handleBrowserSessions, handleBrowserStop, handleBrowserScreenshot, handleBrowserOpen, handleBrowserTabs, handleBrowserTabOpen, handleBrowserTabUse, handleBrowserTabClose, handleBrowserDom, handleBrowserSelectors, handleBrowserClick, handleBrowserType, handleBrowserWait, handleBrowserEval, handleBrowserPress, handleBrowserReload, handleBrowserBack, handleBrowserForward } from "./tools/browser.js";
import { handleMobileStatus, handleMobileListDevices, handleMobileScreenshot, handleMobileSnapshot, handleMobileCurrentApp, handleMobileLogs, handleMobileStopApp, handleMobileRestartApp, handleMobileBoot, handleMobileLaunchApp, handleMobileOpenUrl, handleMobileTap, handleMobileTapElement, handleMobileType, handleMobileSwipe, handleMobilePress, handleMobileWait } from "./tools/mobile.js";
import { handleTodoProjects, handleTodoList, handleTodoGet, handleTodoCreate, handleTodoUpdate, handleTodoDecompose, handleTodoSetCompleted, handleTodoMove, handleTodoDelete, handleTodoDiscord } from "./tools/todo.js";
import { OPENAI_TUNNEL_HEADER_NAME, resolveOpenAiTunnelAuthConfig, verifyOpenAiTunnelToken, type OpenAiTunnelAuthConfig } from "./auth.js";

export interface AppContext {
  configPath: string;
  registry: ProjectRegistry;
  contextStore: ChatContextStore;
  shellRunner: ShellRunner;
  auditLogger: AuditLogger;
  toolUsageMetrics: ToolUsageMetrics;
}

type CallToolMeta = {
  "openai/session"?: unknown;
  "openai/subject"?: unknown;
};

export function resolveChatContextId(meta: CallToolMeta | undefined): string {
  const session = meta?.["openai/session"];
  if (typeof session === "string" && session.length > 0) {
    return `chatgpt-session:${session}`;
  }

  const subject = meta?.["openai/subject"];
  if (typeof subject === "string" && subject.length > 0) {
    return `chatgpt-user:${subject}`;
  }

  return "default";
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

async function createAppContext(configPath: string): Promise<AppContext> {
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

  return { configPath, registry, contextStore, shellRunner, auditLogger, toolUsageMetrics };
}

export const SERVER_INSTRUCTIONS = `
For substantive work on a project:
1. Ensure the target project is selected before using project-scoped tools.
2. Call skills.list once for the selected project near the start of the work.
3. Inspect the returned skill names and descriptions.
4. If a skill is relevant to the task, call skills.read for that exact SKILL.md before applying its workflow.
5. Do not read unrelated skills.
6. Do not call skills.list again unless the selected project changes, the Skills runtime is reloaded, or the available Skills may otherwise have changed.
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const chatContextId = resolveChatContextId(request.params._meta as CallToolMeta | undefined);
    const usageStartedAt = performance.now();

    try {
      debugMcpLog(`[CallTool] ${name} chatContextId=${chatContextId} store=${ctx.contextStore.getAll().size}ctxs`);
      const invokeTool = async () => {
        switch (name) {
        case "project.list":
          return await handleProjectList(ctx, chatContextId);

        case "project.select":
          return await handleProjectSelect(ctx, chatContextId, args as { project_id: string });

        case "project.current":
          return await handleProjectCurrent(ctx, chatContextId);

        case "project.reload":
          return await handleProjectReload(ctx, reloadProjectRegistry);

        case "skills.list":
          return await handleSkillsList(ctx, chatContextId, args as { path?: string });

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


        case "notes.guidelines":
          return await handleNotesGuidelines();

        case "notes.create":
          return await handleNotesCreate(ctx, chatContextId, args as { title?: string; description?: string; tags?: string[]; source_urls?: string[]; body?: string; slug?: string; overwrite?: boolean });

        case "notes.validate":
          return await handleNotesValidate(ctx, chatContextId, args as { path?: string });

        case "private_notes.guidelines":
          return await handlePrivateNotesGuidelines();

        case "private_notes.create":
          return await handlePrivateNotesCreate(ctx, chatContextId, args as { title?: string; body_html?: string; slug?: string; date?: string; overwrite?: boolean });

        case "private_notes.validate":
          return await handlePrivateNotesValidate(ctx, chatContextId, args as { path?: string });

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

        case "todo.discord":
          return await handleTodoDiscord(ctx, chatContextId, args as { todo_id?: string });

        case "shell.run":
          return await handleShellRun(
            ctx,
            chatContextId,
            args as { command: string; timeout_seconds?: number; purpose?: string; async?: boolean; long_running?: boolean }
          );

        case "shell.status":
          return await handleShellStatus(args as { job_id: string; cursor?: string; wait_ms?: number });

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

        case "artifact.read":
          return await handleArtifactRead(ctx, chatContextId, args as { path?: string; max_bytes?: number });

        case "artifact.receive":
          return await handleArtifactReceive(
            ctx,
            chatContextId,
            args as { file?: OpenAiProvidedFile; destination?: string; max_bytes?: number }
          );

        case "tool.usage": {
          const usage = ctx.toolUsageMetrics.snapshot();
          return {
            structuredContent: usage,
            content: [{ type: "text", text: JSON.stringify(usage, null, 2) }],
          };
        }

        case "tool.schema":
          await server.sendToolListChanged().catch(() => undefined);
          return {
            structuredContent: buildToolSchemaSnapshot(),
            content: [{ type: "text", text: JSON.stringify(buildToolSchemaSnapshot(), null, 2) }],
          };

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
        }
      };
      const result: any = name.startsWith("browser.")
        ? await runBrowserToolOperation(chatContextId, invokeTool)
        : await invokeTool();
      ctx.toolUsageMetrics.record({
        tool: name,
        project_id: ctx.contextStore.getCurrentProject(chatContextId),
        duration_ms: performance.now() - usageStartedAt,
        failed: result?.isError === true,
      });
      return result;
    } catch (err) {
      ctx.toolUsageMetrics.record({
        tool: name,
        project_id: ctx.contextStore.getCurrentProject(chatContextId),
        duration_ms: performance.now() - usageStartedAt,
        failed: true,
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
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
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
    const uri = request.params.uri;
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
    })().catch((error) => console.error("[BrowserLifecycle] shutdown drain failed", error)).finally(() => process.exit(0));
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
  const requireHttpAuth = buildHttpAuthMiddleware(httpAuthConfig);
  const ctx = await createAppContext(configPath);
  const browserLifecycle = await createBrowserLifecycleService();
  const rateLimitMap = new Map<string, { count: number; reset: number }>();

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

  const __dirname = dirname(fileURLToPath(import.meta.url));
  app.use("/ui", (req, res, next) => {
    if (!isLocalhostRequest(req)) {
      return res.status(403).json({ error: "forbidden", message: "UI only accessible from localhost" });
    }
    express.static(join(__dirname, "../ui/public"))(req, res, next);
  });

  app.get("/debug/tools", requireHttpAuth, (_req, res) => {
    res.json(buildToolSchemaSnapshot());
  });


  app.use(cors({
    origin: [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
    credentials: false,
  }));

  function simpleRateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (entry && entry.count >= 100 && now - entry.reset < 60 * 1000) {
      res.status(429).json({ error: "too_many_requests", message: "Rate limit exceeded." });
      return;
    }
    if (!entry || now - entry.reset >= 60 * 1000) {
      rateLimitMap.set(ip, { count: 1, reset: now });
    } else {
      entry.count++;
    }
    next();
  }
  app.use(simpleRateLimit);


  app.post("/mcp", requireHttpAuth, express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    handleMcpRequest(req, res, ctx).catch((err) => {
      console.error("MCP POST handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: String(err) });
      }
    });
  });

  app.get("/mcp", requireHttpAuth, (_req, res) => {
    sendStatelessMcpMethodNotAllowed(res);
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send("local-dev-mcp MCP server running via OpenAI Secure MCP Tunnel.");
  });

  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(buildHealthStatus());
  });

  app.post("/", requireHttpAuth, express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    handleMcpRequest(req, res, ctx).catch((err) => {
      console.error("MCP POST (root) error:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal_error", message: String(err) });
    });
  });

  app.post("/reload", requireHttpAuth, async (_req, res) => {
    try {
      const projectIds = await reloadProjectRegistry(ctx);
      console.error(`[Registry] Reloaded: ${projectIds.join(", ")}`);
      res.json({ ok: true, projects: projectIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  console.error(`[OpenAI Tunnel] Local MCP authentication enabled via ${OPENAI_TUNNEL_HEADER_NAME}.`);

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
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await browserOperationsIdle;
        return await browserLifecycle.drain();
      })(), 55_000);
    })().then((result) => {
      if (result === "timeout") console.error("[BrowserLifecycle] shutdown drain timed out");
      else console.error("[BrowserLifecycle] shutdown drain", result);
    }).catch((error) => console.error("[BrowserLifecycle] shutdown drain failed", error)).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
  const parsed = req.method === "POST" ? parseRawBody(req) : undefined;
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
