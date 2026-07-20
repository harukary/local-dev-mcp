import { randomUUID, timingSafeEqual } from "node:crypto";
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
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { ProjectRegistry } from "../project/registry.js";
import type { ChatContextStore } from "../project/context-store.js";
import type { ShellRunner } from "../shell/runner.js";
import type { AuditLogger } from "../audit/audit-log.js";
import { handleProjectList } from "./tools/project-list.js";
import { handleProjectSelect } from "./tools/project-select.js";
import { handleProjectCurrent } from "./tools/project-current.js";
import { handleShellRun } from "./tools/shell-run.js";
import { getCachedImage, handleImageRead } from "./tools/image-read.js";
import { handleShellApprove, handleShellReject } from "./tools/shell-approval.js";
import { handleShellStatus } from "./tools/shell-status.js";
import { handleShellCancel } from "./tools/shell-cancel.js";
import { listPendingRequests } from "../shell/approval.js";
import { getActiveJobs } from "../shell/job-manager.js";
import { personalOAuthProvider, tokenStore, AUTH_PASSPHRASE } from "./oauth-provider.js";
import { handleProjectReload } from "./tools/project-reload.js";
import { handleSkillsList, handleSkillsRead } from "./tools/skills.js";
import { buildToolDefinitions, buildToolSchemaSnapshot } from "./tool-definitions.js";
import { imageViewerMeta, imageViewerResource, imageViewerResourceUri } from "./resources/image-viewer.js";
import { handleProjectInspect } from "./tools/dev/project-inspect.js";
import { handleWorkspaceRead } from "./tools/dev/workspace-read.js";
import { handleWorkspaceList } from "./tools/dev/workspace-list.js";
import { handleWorkspaceSearch } from "./tools/dev/workspace-search.js";
import { handleWorkspacePatch } from "./tools/dev/workspace-patch.js";
import { handleGitStatus, handleGitDiff } from "./tools/dev/git.js";
import { handleNotesCreate, handleNotesGuidelines, handleNotesValidate } from "./tools/notes/index.js";
import { handlePrivateNotesCreate, handlePrivateNotesGuidelines, handlePrivateNotesValidate } from "./tools/private-notes/index.js";
import { handleBrowserStatus, handleBrowserStart, handleBrowserSessions, handleBrowserStop, handleBrowserScreenshot, handleBrowserOpen, handleBrowserTabs, handleBrowserDom, handleBrowserSelectors, handleBrowserClick, handleBrowserType, handleBrowserWait, handleBrowserEval, handleBrowserPress, handleBrowserReload, handleBrowserBack, handleBrowserForward } from "./tools/browser.js";
import { handleMobileStatus, handleMobileListDevices, handleMobileScreenshot, handleMobileBoot, handleMobileOpenUrl, handleMobileTap, handleMobileType } from "./tools/mobile.js";
import { handleTodoProjects, handleTodoList, handleTodoGet, handleTodoCreate, handleTodoUpdate, handleTodoDecompose, handleTodoSetCompleted, handleTodoMove, handleTodoDelete, handleTodoDiscord } from "./tools/todo.js";

export interface AppContext {
  configPath: string;
  registry: ProjectRegistry;
  contextStore: ChatContextStore;
  shellRunner: ShellRunner;
  auditLogger: AuditLogger;
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
      if (key.toLowerCase() === "passphrase") {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.replace(/([?&]passphrase=)[^&]*/gi, "$1[REDACTED]");
  }
}

async function createAppContext(configPath: string): Promise<AppContext> {
  const { ProjectRegistry } = await import("../project/registry.js");
  const { ChatContextStore } = await import("../project/context-store.js");
  const { ShellRunner } = await import("../shell/runner.js");
  const { AuditLogger } = await import("../audit/audit-log.js");

  const registry = await ProjectRegistry.load(configPath);
  const contextStore = new ChatContextStore();
  const shellRunner = new ShellRunner();
  const auditLogger = new AuditLogger("./logs/audit.jsonl");

  return { configPath, registry, contextStore, shellRunner, auditLogger };
}

function createMcpServer(ctx: AppContext): Server {
  const server = new Server(
    { name: "local-dev-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const chatContextId = resolveChatContextId(request.params._meta as CallToolMeta | undefined);

    try {
      debugMcpLog(`[CallTool] ${name} chatContextId=${chatContextId} store=${ctx.contextStore.getAll().size}ctxs`);
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
          return await handleWorkspaceList(ctx, chatContextId, args as { path?: string; depth?: number; glob?: string; include_hidden?: boolean });

        case "workspace.search":
          return await handleWorkspaceSearch(ctx, chatContextId, args as { query?: string; glob?: string; context_lines?: number; max_results?: number });

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

        case "git.status":
          return await handleGitStatus(ctx, chatContextId, args as { include_untracked?: boolean });

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

        case "browser.dom":
          return await handleBrowserDom(ctx, chatContextId, args as { session_id?: string; selector?: string });

        case "browser.selectors":
          return await handleBrowserSelectors(ctx, chatContextId, args as { session_id?: string; limit?: number; query?: string });

        case "browser.click":
          return await handleBrowserClick(ctx, chatContextId, args as { session_id?: string; selector?: string; observe?: "none" | "after"; wait_ms?: number });

        case "browser.type":
          return await handleBrowserType(ctx, chatContextId, args as { session_id?: string; selector?: string; text?: string; submit?: boolean; observe?: "none" | "after"; wait_ms?: number });

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
          return await handleBrowserOpen(ctx, chatContextId, args as { url?: string; session_id?: string; observe?: "none" | "after"; wait_ms?: number });

        case "mobile.status":
          return await handleMobileStatus(ctx, chatContextId);

        case "mobile.list_devices":
          return await handleMobileListDevices(ctx, chatContextId);

        case "mobile.screenshot":
          return await handleMobileScreenshot(ctx, chatContextId, args as { device?: string });

        case "mobile.boot":
          return await handleMobileBoot(ctx, chatContextId, args as { device?: string });

        case "mobile.open_url":
          return await handleMobileOpenUrl(ctx, chatContextId, args as { device?: string; url?: string; observe?: "none" | "after" });

        case "mobile.tap":
          return await handleMobileTap(ctx, chatContextId, args as { device?: string; x?: number; y?: number; observe?: "none" | "after" });

        case "mobile.type":
          return await handleMobileType(ctx, chatContextId, args as { device?: string; text?: string; observe?: "none" | "after" });

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
            args as { command: string; timeout_seconds?: number; purpose?: string; async?: boolean }
          );

        case "shell.status":
          return await handleShellStatus(args as { job_id: string });

        case "shell.cancel":
          return await handleShellCancel(args as { job_id: string });

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
          return await handleImageRead(ctx, chatContextId, args as { path?: string });

        case "tool.schema":
          return {
            content: [{ type: "text", text: JSON.stringify(buildToolSchemaSnapshot(), null, 2) }],
          };

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
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
    const resources = [
      {
        uri: imageViewerResourceUri(),
        name: "Image Viewer",
        mimeType: "text/html+skybridge",
      },
    ];
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
    resourceTemplates: [
      {
        uriTemplate: imageViewerResourceUri(),
        name: "Image Viewer",
        description: "Image viewer widget markup for image.read results",
        mimeType: "text/html+skybridge",
        _meta: imageViewerMeta(),
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === imageViewerResourceUri()) {
      return { contents: [imageViewerResource()] };
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
  await server.connect(transport);
}

export function getPublicOrigin(req: express.Request): string {
  const configured = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to request-derived origin
    }
  }

  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "127.0.0.1:3456";
  return `${proto}://${host}`;
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

export function getAllowedHttpHosts(): string[] {
  const hosts = new Set<string>(LOCAL_HOSTS);
  const publicOrigin = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN?.trim();
  if (publicOrigin) {
    const host = normalizeHttpHost(publicOrigin);
    if (host) hosts.add(host);
  }

  const configuredHosts = process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS?.split(",") ?? [];
  for (const configured of configuredHosts) {
    const host = normalizeHttpHost(configured.trim());
    if (host) hosts.add(host);
  }

  return Array.from(hosts).sort();
}

export function hasExplicitHttpHostAllowlist(): boolean {
  return Boolean(
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN?.trim() ||
    process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS?.trim()
  );
}

export function isAllowedHttpHost(hostHeader: string | string[] | undefined): boolean {
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const host = normalizeHttpHost(hostValue);
  if (!host) return false;
  if (!hasExplicitHttpHostAllowlist()) return true;
  return getAllowedHttpHosts().includes(host);
}

function requireAllowedHost(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host;
  if (isAllowedHttpHost(host)) {
    next();
    return;
  }

  debugMcpLog(`[HTTP] forbidden_host host=${normalizeHttpHost(Array.isArray(host) ? host[0] : host) || "unknown"} allowed=${getAllowedHttpHosts().join(",")}`);
  res.status(403).json({
    error: "forbidden_host",
    message: "Request host is not allowed by LOCAL_DEV_MCP_PUBLIC_ORIGIN or LOCAL_DEV_MCP_ALLOWED_HOSTS.",
  });
}

export function isAllowedRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);

    if (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    ) {
      return true;
    }

    if (
      url.protocol === "https:" &&
      (url.origin === "https://chatgpt.com" || url.origin === "https://chat.openai.com") &&
      url.pathname.startsWith("/connector/oauth/")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function isRegisteredRedirectUri(
  redirectUri: string,
  client: { redirect_uris?: string[] }
): boolean {
  return (client.redirect_uris ?? []).some((registered) => redirectUriMatches(redirectUri, registered));
}

function requireBearerAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    sendUnauthorized(req, res, "Missing Authorization header");
    return;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer" || !parts[1]) {
    sendUnauthorized(req, res, "Invalid Authorization header format, expected 'Bearer TOKEN'");
    return;
  }

  personalOAuthProvider
    .verifyAccessToken(parts[1])
    .then((authInfo) => {
      (req as unknown as Record<string, unknown>).auth = authInfo;
      next();
    })
    .catch((err: unknown) => {
      if (err instanceof InvalidTokenError) {
        sendUnauthorized(req, res, err.message);
      } else {
        res.status(500).json({ error: "server_error", message: "Internal Server Error" });
      }
    });
}

function customAuthorizationHandler(provider: typeof personalOAuthProvider) {
  return async (req: express.Request, res: express.Response) => {
    const q = req.method === "POST" ? req.body : req.query;
    const client_id = q.client_id as string;
    const redirect_uri = q.redirect_uri as string | undefined;
    const response_type = q.response_type as string;
    const code_challenge = q.code_challenge as string;
    const code_challenge_method = q.code_challenge_method as string;
    const state = q.state as string | undefined;
    const scope = q.scope as string | undefined;
    let redirectUriToUse = redirect_uri;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type", error_description: "Only code response type is supported" });
      return;
    }
    if (!code_challenge || code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "PKCE S256 is required" });
      return;
    }

    const client = await provider.clientsStore.getClient(client_id);
    if (!client) {
      res.status(400).json({ error: "invalid_client", error_description: "Unknown client_id" });
      return;
    }

    if (!redirectUriToUse) {
      if (client.redirect_uris.length === 1) {
        redirectUriToUse = client.redirect_uris[0];
      } else {
        res.status(400).json({ error: "invalid_request", error_description: "redirect_uri is required" });
        return;
      }
    }
    if (!isAllowedRedirectUri(redirectUriToUse)) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "redirect_uri must be a localhost or ChatGPT connector callback URL",
      });
      return;
    }
    if (!redirectUriToUse || !isRegisteredRedirectUri(redirectUriToUse, client)) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "redirect_uri must match a registered client redirect_uri",
      });
      return;
    }

    const requestedScopes = scope ? scope.split(" ") : [];

    await provider.authorize(client, {
      state,
      scopes: requestedScopes,
      redirectUri: redirectUriToUse,
      codeChallenge: code_challenge,
    }, res);
  };
}

function requirePassphrase(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const body = req.body as Record<string, unknown> | undefined;
  const bodyPassphrase = typeof body?.passphrase === "string" ? body.passphrase : undefined;
  const provided = req.method === "POST" ? bodyPassphrase : undefined;
  if (provided) {
    const a = Buffer.from(provided);
    const b = Buffer.from(AUTH_PASSPHRASE);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      next();
      return;
    }
  }

  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const params = new URLSearchParams(q);

  res.type("html").send(renderPassphrasePage(params));
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderPassphrasePage(params: URLSearchParams): string {
  const hiddenFields = Array.from(params.entries())
    .filter(([k]) => k !== "passphrase")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtmlAttribute(k)}" value="${escapeHtmlAttribute(v)}">`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>Authorize local-dev-mcp</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f7}
.card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:400px;width:90%}
h1{font-size:1.3rem;font-weight:600;margin:0 0 8px;color:#1d1d1f}
p{font-size:.9rem;color:#6e6e73;margin:0 0 24px}
input{width:100%;padding:12px 16px;border:1px solid #d2d2d7;border-radius:10px;font-size:1rem;box-sizing:border-box;outline:none}
input:focus{border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,.2)}
button{margin-top:16px;width:100%;padding:12px;border:none;border-radius:10px;background:#0071e3;color:#fff;font-size:1rem;font-weight:500;cursor:pointer}
button:hover{background:#0077ed}
</style></head>
<body><div class="card">
<h1>local-dev-mcp に認可</h1>
<p>ChatGPT App からの接続を許可するには<br>パスフレーズを入力してください</p>
<form method="POST" action="/authorize">
${hiddenFields}
<input type="password" name="passphrase" placeholder="パスフレーズ" autofocus>
<button type="submit">認可する</button>
</form>
</div></body>
</html>`;
}

function sendUnauthorized(req: express.Request, res: express.Response, description: string): void {
  const baseUrl = getPublicOrigin(req);
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;

  res.set(
    "WWW-Authenticate",
    `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl}"`
  );
  res.status(401).json({ error: "invalid_token", message: description });
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
  const ctx = await createAppContext(configPath);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const rateLimitMap = new Map<string, { count: number; reset: number }>();

  const app = express();
  app.set("trust proxy", 1);
  app.use(requireAllowedHost);
  app.use((req, _res, next) => {
    const method = req.method;
    const sanitizedUrl = sanitizeRequestUrlForLog(req.url);
    const url = sanitizedUrl.length > 80 ? sanitizedUrl.slice(0, 80) + "..." : sanitizedUrl;
    const auth = req.headers.authorization ? " (has auth)" : "";
    const session = req.headers["mcp-session-id"] ? ` (session=${(req.headers["mcp-session-id"] as string).slice(0, 8)}...)` : "";
    debugMcpLog(`[HTTP] ${method} ${url}${auth}${session}`);
    next();
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  app.use("/ui", (req, res, next) => {
    if (!isLocalhostRequest(req)) {
      return res.status(403).json({ error: "forbidden", message: "UI only accessible from localhost" });
    }
    express.static(join(__dirname, "../ui/public"))(req, res, next);
  });

  app.get("/debug/tools", requireBearerAuth, (_req, res) => {
    res.json(buildToolSchemaSnapshot());
  });

  app.get("/image-cache/:id", (req, res) => {
    const cached = getCachedImage(req.params.id);
    if (!cached) {
      res.status(404).json({ error: "not_found", message: "Image cache entry not found or expired." });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("Content-Disposition", `inline; filename="${cached.fileName.replace(/"/g, "")}"`);
    res.type(cached.mimeType).send(cached.bytes);
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

  app.use("/authorize", express.urlencoded({ extended: false, limit: "10kb" }));
  app.use("/authorize", requirePassphrase);
  app.use("/authorize", customAuthorizationHandler(personalOAuthProvider));
  app.use("/token", tokenHandler({ provider: personalOAuthProvider, rateLimit: false }));
  app.use("/revoke", revocationHandler({ provider: personalOAuthProvider, rateLimit: false }));
  app.use("/register", clientRegistrationHandler({
    clientsStore: personalOAuthProvider.clientsStore,
    rateLimit: false,
  }));

  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const baseUrl = getPublicOrigin(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      revocation_endpoint: `${baseUrl}/revoke`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported: ["all"],
    });
  });

  app.get("/.well-known/openid-configuration", (req, res) => {
    const baseUrl = getPublicOrigin(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported: ["all"],
    });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
    const baseUrl = getPublicOrigin(req);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ["all"],
      bearer_methods_supported: ["header"],
    });
  });

  app.post("/mcp", requireBearerAuth, express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    handleMcpRequest(req, res, ctx, transports).catch((err) => {
      console.error("MCP POST handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: String(err) });
      }
    });
  });

  app.get("/mcp", requireBearerAuth, (req, res) => {
    handleMcpGetRequest(req, res, ctx, transports).catch((err) => {
      console.error("MCP GET handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: String(err) });
      }
    });
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send("local-dev-mcp MCP server running.");
  });

  app.post("/", requireBearerAuth, express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    handleMcpRequest(req, res, ctx, transports).catch((err) => {
      console.error("MCP POST (root) error:", err);
      if (!res.headersSent) res.status(500).json({ error: "internal_error", message: String(err) });
    });
  });

  app.post("/reload", requireBearerAuth, async (_req, res) => {
    try {
      const projectIds = await reloadProjectRegistry(ctx);
      console.error(`[Registry] Reloaded: ${projectIds.join(", ")}`);
      res.json({ ok: true, projects: projectIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  console.error("[OAuth] Authorization endpoint ready; passphrase protection enabled.");

  await new Promise<void>((resolve, reject) => {
    app.listen(port, "127.0.0.1", (err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
  console.error(`MCP HTTP server listening on http://127.0.0.1:${port}/mcp (OAuth 2.1)`);

  const shutdown = () => {
    console.error("\n[Server] Shutting down...");
    tokenStore.shutdown().catch(() => {}).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleMcpRequest(
  req: express.Request,
  res: express.Response,
  ctx: AppContext,
  transports: Map<string, StreamableHTTPServerTransport>
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const parsed = parseRawBody(req);
  const isInit = isInitializeRequest(parsed);

  debugMcpLog(`[MCP] sessionId=${sessionId ?? "(none)"} isInit=${isInit} transports=${transports.size}`);

  if (!sessionId && isInit) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
        debugMcpLog(`[MCP] session created: ${newSessionId.slice(0, 8)}...`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    const mcpServer = createMcpServer(ctx);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsed);
    return;
  }

  if (sessionId) {
    const transport = transports.get(sessionId);
    if (transport) {
      debugMcpLog(`[MCP] session reused: ${sessionId.slice(0, 8)}...`);
      await transport.handleRequest(req, res, parsed);
      return;
    }
    debugMcpLog(`[MCP] session NOT FOUND: ${sessionId.slice(0, 8)}...`);
  }

  res.status(400).json({ error: "No valid session" });
}

async function handleMcpGetRequest(
  req: express.Request,
  res: express.Response,
  ctx: AppContext,
  transports: Map<string, StreamableHTTPServerTransport>
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) {
    const transport = transports.get(sessionId);
    if (transport) {
      await transport.handleRequest(req, res);
      return;
    }
  }
  res.status(400).json({ error: "No valid session" });
}

async function reloadProjectRegistry(ctx: AppContext): Promise<string[]> {
  const projectIds = await ctx.registry.reload();
  ctx.contextStore.pruneMissingCurrentProjects((projectId) => ctx.registry.has(projectId));
  ctx.shellRunner.clearCache();
  return projectIds;
}
