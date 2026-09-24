import { buildDevToolDefinitions } from "./dev-tool-definitions.js";
import { buildBrowserToolDefinitions } from "./browser-tool-definitions.js";
import { buildMobileToolDefinitions } from "./mobile-tool-definitions.js";
import { buildTodoToolDefinitions } from "./todo-tool-definitions.js";

export const TOOL_SCHEMA_VERSION = "2026-09-24.1";

const EXPLICIT_PROJECT_SCOPE_TOOLS = new Set([
  "skills.list",
  "project.inspect",
  "workspace.batch",
  "workspace.read",
  "workspace.list",
  "workspace.search",
  "workspace.patch",
  "git.inspect",
  "git.status",
  "git.log",
  "git.show",
  "git.diff",
  "shell.run",
  "image.read",
  "artifact.link",
  "artifact.read",
  "artifact.receive",
  "mobile.screenshot",
  "mobile.snapshot",
  "mobile.current_app",
  "mobile.logs",
  "mobile.stop_app",
  "mobile.restart_app",
  "mobile.boot",
  "mobile.launch_app",
  "mobile.open_url",
  "mobile.tap",
  "mobile.tap_element",
  "mobile.type",
  "mobile.swipe",
  "mobile.press",
  "mobile.wait",
]);

export function supportsExplicitProjectScope(name: string): boolean {
  return EXPLICIT_PROJECT_SCOPE_TOOLS.has(name);
}

function addExplicitProjectScope<T extends { name: string; inputSchema: Record<string, any> }>(tool: T): T {
  if (!supportsExplicitProjectScope(tool.name)) return tool;
  const properties = tool.inputSchema.properties ?? {};
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        project_id: {
          type: "string",
          description: "Optional explicit project scope for this call. ChatGPT Scheduled Tasks must pass project_id on every project-scoped call instead of relying on project.select.",
        },
        working_dir: {
          type: "string",
          description: "Optional project-relative working directory used with project_id. Must resolve inside the project root.",
        },
      },
    },
  };
}

export function buildToolDefinitions() {
  const tools = [
    {
      name: "project.list",
      description: "List available local development projects.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "project.select",
      description:
        "Select the current project and optional project-relative working directory for all project-scoped tools in an interactive chat context. Use working_dir for a git worktree (for example .worktree/feature-x) instead of wrapping typed tools in cd or pnpm worktree:run. The selection persists; call this again only when switching project or working directory. Do not use project.select in stateless Scheduled Tasks; pass project_id and optional working_dir on every project-scoped call instead.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Project identifier from project.list",
          },
          working_dir: {
            type: "string",
            description: "Optional project-relative working directory. Must resolve to a real directory inside the selected project root; use this for git worktrees.",
          },
        },
        required: ["project_id"],
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      name: "project.current",
      description: "Return the currently selected project for this chat context.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "project.reload",
      description: "Reload the project registry from the configured projects.yaml without restarting the process.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "skills.list",
      description:
        "List readable Codex skill files for ChatGPT. The default summary keeps name, description, path, scope, and origin; use detail=full only when extra metadata is needed. Optional query/scope filters reduce output for follow-up discovery.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional project cwd/path inside a registered project. Defaults to the selected project cwd, or the server cwd.",
          },
          query: {
            type: "string",
            description: "Optional case-insensitive filter over skill name and description.",
          },
          scope: {
            type: "string",
            enum: ["project", "user", "system"],
            description: "Optional scope filter.",
          },
          detail: {
            type: "string",
            enum: ["summary", "full"],
            description: "Summary is the compact default; full includes relative_path and enabled.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "skills.read",
      description:
        "Read SKILL.md or a text reference belonging to a Skill inside a registered project or CODEX_HOME/skills. Results include scope and origin.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute non-symlink SKILL.md or text reference path beneath an allowed Skill root. Prefer paths returned by skills.list or referenced by that Skill.",
          },
          max_bytes: {
            type: "integer",
            description: "Maximum bytes to read. Defaults to 524288.",
            minimum: 1,
            maximum: 1048576,
          },
        },
        required: ["path"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ...buildTodoToolDefinitions(),
    ...buildDevToolDefinitions(),
    ...buildBrowserToolDefinitions(),
    ...buildMobileToolDefinitions(),
    {
      name: "shell.run",
      description:
        "Fallback escape hatch for operations not covered by typed tools. Prefer workspace.*, git.*, browser.*, mobile.*, and todo.* when they support the task. Use git.inspect/status/diff/log/show for read-only Git inspection; reserve shell.run for Git writes or unsupported compound operations. For file edits, prefer workspace.patch over Python/Node/Ruby heredocs or text-replacement scripts. If work is in a git worktree, select it once with project.select working_dir in interactive chats, or pass project_id + working_dir directly in stateless Scheduled Tasks. Use shell.run for builds, tests, deploys, installs, custom scripts, or unsupported operations. For any command likely to exceed about 30 seconds, use async=true. For normal completion polling call shell.status with wait_ms=30000 and output=none; when output matters, reuse cursor. Do not create repeated sleep + ps polling commands.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command executed via bash -lc in the selected project sandbox.",
          },
          timeout_seconds: {
            type: "integer",
            description:
              "Command timeout in seconds (default: project default, max: project max). Synchronous runs above 240 seconds are rejected to leave margin below the plugin request deadline; use async=true instead. For long async jobs, omit this field so the job runs until completion or cancellation.",
            minimum: 1,
            maximum: 300,
          },
          purpose: {
            type: "string",
            description: "Short explanation of why this command is being run.",
          },
          credential_scope: {
            type: "string",
            enum: ["bitwarden"],
            description:
              "Inject the Bitwarden Secrets Manager access token from macOS Keychain into this command only. Approval follows the project normal risk policy; the scope alone does not force approval. The token is redacted from command output.",
          },
          async: {
            type: "boolean",
            description:
              "Run as a managed background job and return job_id and pid immediately. MUST be true for commands that may exceed about 30 seconds or whose duration is uncertain. Omit timeout_seconds for long-running work, then poll shell.status with the returned job_id.",
          },
          long_running: {
            type: "boolean",
            description: "For async jobs only. Explicitly disable the timeout even when timeout_seconds is supplied.",
          },
        },
        required: ["command"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "shell.status",
      description: "Return background-job status and optional bounded output. For normal completion polling, use wait_ms=30000 and output=none so one call long-polls instead of repeatedly checking. If output matters, reuse the returned cursor so later polls receive only new stdout/stderr; increase max_bytes only when needed.",
      inputSchema: {
        type: "object",
        properties: {
          max_bytes: { type: "integer", minimum: 4, maximum: 262144, description: "Combined output byte budget; defaults to 16384. Continue with cursor when has_more is true." },
          output: { type: "string", enum: ["all", "none", "tail"], description: "all returns bounded cursor output (default); none returns status only and is preferred for completion polling; tail returns retained output tail." },
          job_id: {
            type: "string",
            description: "The job ID returned by shell.run with async=true.",
          },
          cursor: {
            type: "string",
            description: "Opaque output cursor returned by the previous shell.status call. Omit on the first call.",
          },
          wait_ms: {
            type: "integer",
            minimum: 0,
            maximum: 30000,
            description: "Wait up to this many milliseconds for new output or a status change before returning.",
          },
        },
        required: ["job_id"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "shell.cancel",
      description: "Cancel a running background job.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The managed job ID to cancel.",
          },
          pid: {
            type: "integer",
            minimum: 1,
            description: "PID returned by shell.run. Only PIDs belonging to active managed jobs can be canceled.",
          },
        },
        anyOf: [{ required: ["job_id"] }, { required: ["pid"] }],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "shell.approve",
      description:
        "Approve and immediately execute a pending shell command request. Use the approval_request_id from a previous APPROVAL_REQUIRED response.",
      inputSchema: {
        type: "object",
        properties: {
          approval_request_id: {
            type: "string",
            description: "The approval request ID to approve and execute.",
          },
        },
        required: ["approval_request_id"],
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      name: "shell.reject",
      description: "Reject a pending shell command request.",
      inputSchema: {
        type: "object",
        properties: {
          approval_request_id: {
            type: "string",
            description: "The approval request ID to reject.",
          },
        },
        required: ["approval_request_id"],
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    {
      name: "shell.pending",
      description: "List all pending approval requests.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "image.read",
      description:
        "Preferred first path for model-only inspection of an image in the selected project. Use this directly whenever the model needs to view, understand, compare, or verify an image and the user did not ask to receive the file. The default preview mode keeps normal images lightweight by downscaling when needed. Do not materialize preemptively: first try image.read. If image.read returns IMAGE_TOO_LARGE, returns preview_unavailable without inline ImageContent, or the client cannot expose the inline image reliably, fall back to artifact.link/resource materialization for inspection. Returns inline MCP ImageContent plus metadata and does not create a user-visible chat attachment. If the user asks to receive, send, show, display, or attach the image in chat, call artifact.link with the same path; use artifact.read only as a compatibility fallback when an embedded resource is explicitly needed. Path must stay inside the project root.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative image path, or an absolute path inside the selected project root.",
          },
          mode: {
            type: "string",
            enum: ["preview", "full", "metadata"],
            description: "Inline image return mode. preview is the default and downscales large images to avoid oversized tool results.",
          },
          max_preview_edge: {
            type: "number",
            minimum: 240,
            maximum: 2000,
            description: "Maximum width or height for preview mode. Defaults to 900.",
          },
        },
        required: ["path"],
      },
      outputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path: { type: "string" },
          absolute_path: { type: "string" },
          mime_type: { type: "string" },
          size_bytes: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          returned_image_mode: { type: "string" },
          returned_image_mime_type: { type: "string" },
          returned_image_size_bytes: { type: "number" },
          returned_image_width: { type: "number" },
          returned_image_height: { type: "number" },
        },
        required: ["project_id", "path", "absolute_path", "mime_type", "size_bytes", "returned_image_mode"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "artifact.link",
      description:
        "User-facing file delivery: return a local project file as an MCP resource_link without embedding file bytes in the tool result. Use this when the user asks to receive, download, send, show, display, or attach a generated file or screenshot in chat. For model-only project-image inspection, call image.read first instead of materializing preemptively. artifact.link/resource materialization is a valid fallback when image.read reports IMAGE_TOO_LARGE, returns preview_unavailable without inline ImageContent, or the client cannot expose the inline image reliably. For model-only text inspection use workspace.read. The client can fetch the original later through resources/read when needed, keeping large base64 payloads out of normal tool-call history.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path, or an absolute path inside the selected project root." },
        },
        required: ["path"],
      },
      outputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path: { type: "string" },
          filename: { type: "string" },
          mime_type: { type: "string" },
          size_bytes: { type: "number" },
          transport: { type: "string" },
          uri: { type: "string" },
        },
        required: ["project_id", "path", "filename", "mime_type", "size_bytes", "transport", "uri"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "artifact.read",
      description:
        "Compatibility fallback that embeds a local project file directly in the MCP tool result as base64. Do not use this for model-only image inspection; call image.read directly. Avoid this for normal send/show/display/attach requests because embedded bytes remain in tool-call history; prefer artifact.link. Use only when the client cannot consume resource links or an embedded resource is explicitly required. Limited to 8 MiB per call.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative file path, or an absolute path inside the selected project root." },
          max_bytes: { type: "integer", description: "Maximum raw file size to embed. Defaults to and is capped at 8388608 bytes (8 MiB).", minimum: 1, maximum: 8388608 },
        },
        required: ["path"],
      },
      outputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path: { type: "string" },
          filename: { type: "string" },
          mime_type: { type: "string" },
          size_bytes: { type: "number" },
          sha256: { type: "string" },
          transport: { type: "string" },
          encoding: { type: "string" },
          uri: { type: "string" },
        },
        required: ["project_id", "path", "filename", "mime_type", "size_bytes", "sha256", "transport", "encoding", "uri"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "artifact.receive",
      description:
        "Receive a user-attached ChatGPT file into the selected project in one MCP call. ChatGPT supplies the top-level file input through openai/fileParams as a temporary authorized file reference. Do not ask the user to provide download_url or file_id manually. The server streams the file, validates redirects and destination paths, computes SHA-256, and never logs the temporary download URL.",
      _meta: {
        "openai/fileParams": ["file"],
      },
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "object",
            properties: {
              download_url: { type: "string", format: "uri" },
              file_id: { type: "string" },
              mime_type: { type: "string" },
              file_name: { type: "string" },
            },
            required: ["download_url", "file_id"],
            additionalProperties: false,
          },
          destination: {
            type: "string",
            description: "Optional project-relative destination file path. If omitted, a unique file is created under generated/uploads/. Existing files are never overwritten.",
          },
          max_bytes: {
            type: "integer",
            description: "Optional receive limit for this call. Defaults to LOCAL_DEV_MCP_ARTIFACT_RECEIVE_MAX_BYTES or 536870912 bytes (512 MiB), capped at 512 MiB.",
            minimum: 1,
            maximum: 536870912,
          },
        },
        required: ["file"],
      },
      outputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          path: { type: "string" },
          filename: { type: "string" },
          file_id: { type: "string" },
          mime_type: { type: "string" },
          size_bytes: { type: "number" },
          sha256: { type: "string" },
          source: { type: "string" },
        },
        required: ["project_id", "path", "filename", "file_id", "mime_type", "size_bytes", "sha256", "source"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: "tool.usage",
      description: "Return aggregated MCP tool usage metrics without recording tool arguments or outputs. Defaults to a compact top-30 lifetime summary; use recent_days (1-31 UTC calendar days), project_id, prefix, and limit for recent analysis, or detail=full for the complete aggregate.",
      inputSchema: { type: "object", properties: {
        detail: { type: "string", enum: ["summary", "full"], description: "Compact summary is the default; full returns the complete aggregate." },
        project_id: { type: "string", description: "Optional project filter for summary mode." },
        prefix: { type: "string", description: "Optional tool-name prefix filter for summary mode, e.g. workspace. or mobile." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum tools in summary mode. Defaults to 30." },
        recent_days: { type: "integer", minimum: 1, maximum: 31, description: "Aggregate only the most recent UTC calendar days, including today. Daily buckets are retained for up to 31 days." },
      }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "tool.schema",
      description: "Return the current runtime tool schema and schema version for debugging ChatGPT tool cache.",
      inputSchema: { type: "object", properties: {
        prefix: { type: "string", description: "Filter tools by name prefix, such as browser. or workspace.read." },
        detail: { type: "string", enum: ["summary", "full"], description: "Summary returns names and descriptions; full includes input schemas (default)." },
      } },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
  return tools.map(addExplicitProjectScope);
}

export function buildToolSchemaSnapshot(options: { prefix?: string; detail?: "summary" | "full" } = {}) {
  const tools = buildToolDefinitions().filter(tool => !options.prefix || tool.name.startsWith(options.prefix));
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    tools: options.detail === "summary" ? tools.map(tool => ({ name: tool.name, description: tool.description })) : tools,
  };
}
