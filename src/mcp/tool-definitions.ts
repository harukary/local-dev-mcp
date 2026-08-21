import { imageViewerMeta } from "./resources/image-viewer.js";
import { buildDevToolDefinitions } from "./dev-tool-definitions.js";
import { buildBrowserToolDefinitions } from "./browser-tool-definitions.js";
import { buildMobileToolDefinitions } from "./mobile-tool-definitions.js";
import { buildTodoToolDefinitions } from "./todo-tool-definitions.js";

export const TOOL_SCHEMA_VERSION = "2026-08-21.1";

export function buildToolDefinitions() {
  return [
    {
      name: "project.list",
      description: "List available local development projects.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "project.select",
      description:
        "Select the current project for this chat context. Subsequent shell.run calls will use this project's sandbox.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: {
            type: "string",
            description: "Project identifier from project.list",
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
        "List readable Codex skill files for ChatGPT. Optional path selects the project cwd whose .agents/skills should be included; CODEX_HOME runtime user and system Skills are always included. Results include source origin (common, private_user, project, system, or unmanaged).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional project cwd/path inside a registered project. Defaults to the selected project cwd, or the server cwd.",
          },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "skills.read",
      description:
        "Read a real, non-symlink SKILL.md path inside a registered project Skill root or CODEX_HOME/skills. Results include runtime scope and source origin.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute real, non-symlink SKILL.md path inside a registered project Skill root or CODEX_HOME/skills. Prefer a path returned by skills.list.",
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
        "Run a shell command in the currently selected project's sandbox cwd. For builds, deploys, installs, uploads, full test suites, Gradle/Xcode/Docker/EAS work, or any command that may take more than about 30 seconds or has uncertain duration, MUST use async=true and omit timeout_seconds. Do not wait synchronously near the plugin request deadline; poll shell.status instead.",
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "shell.status",
      description: "Return the status and output of a background job. Poll this after shell.run(async=true) until the job is no longer running.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "The job ID returned by shell.run with async=true.",
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
        "Read an image file from the selected project for model inspection and return image content plus metadata without rendering the custom image viewer to the user. Path must stay inside the project root.",
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
          display_url: { type: "string" },
          display_expires_at: { type: "string" },
          markdown: { type: "string" },
        },
        required: ["project_id", "path", "absolute_path", "mime_type", "size_bytes", "display_url", "display_expires_at", "markdown"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "image.show",
      description:
        "Display an image to the user with the inline image viewer while also returning image content plus metadata to the model. Use this only when the image should be visibly shown in chat; use image.read for model-only inspection.",
      _meta: imageViewerMeta(),
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
          display_url: { type: "string" },
          display_expires_at: { type: "string" },
          markdown: { type: "string" },
        },
        required: ["project_id", "path", "absolute_path", "mime_type", "size_bytes", "display_url", "display_expires_at", "markdown"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "download.link",
      description:
        "Create a temporary authenticated download URL for a local file inside the selected project root. Opening the URL in a browser shows a passphrase authentication screen; MCP clients can use the same Bearer authentication as the MCP connection. The URL expires automatically and serves the file as an attachment.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path, or an absolute path inside the selected project root.",
          },
          ttl_seconds: {
            type: "integer",
            description: "Link lifetime in seconds. Defaults to 600 and is capped at 86400.",
            minimum: 1,
            maximum: 86400,
          },
          filename: {
            type: "string",
            description: "Optional download filename. Path separators are ignored.",
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
          size_bytes: { type: "number" },
          download_url: { type: "string" },
          expires_at: { type: "string" },
          ttl_seconds: { type: "number" },
          filename: { type: "string" },
          markdown: { type: "string" },
        },
        required: ["project_id", "path", "absolute_path", "size_bytes", "download_url", "expires_at", "ttl_seconds", "filename", "markdown"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "tool.schema",
      description: "Return the current runtime tool schema and schema version for debugging ChatGPT tool cache.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}

export function buildToolSchemaSnapshot() {
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    tools: buildToolDefinitions(),
  };
}
