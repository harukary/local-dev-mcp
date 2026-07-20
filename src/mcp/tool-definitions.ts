import { imageViewerMeta } from "./resources/image-viewer.js";
import { buildDevToolDefinitions } from "./dev-tool-definitions.js";
import { buildBrowserToolDefinitions } from "./browser-tool-definitions.js";
import { buildMobileToolDefinitions } from "./mobile-tool-definitions.js";
import { buildTodoToolDefinitions } from "./todo-tool-definitions.js";

export const TOOL_SCHEMA_VERSION = "2026-07-20.2";

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
        "List readable Codex/Haru skill files for ChatGPT. Optional path selects the project cwd whose .agents/skills should be included; common and system skills are always included.",
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
        "Read a SKILL.md file returned by skills.list so ChatGPT can apply the skill contract before acting.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Exact absolute SKILL.md path returned by skills.list.",
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
      description: "Run a shell command in the currently selected project's sandbox cwd.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command executed via bash -lc in the selected project sandbox.",
          },
          timeout_seconds: {
            type: "integer",
            description: "Timeout in seconds (default: project default, max: project max).",
            minimum: 1,
            maximum: 300,
          },
          purpose: {
            type: "string",
            description: "Short explanation of why this command is being run.",
          },
          async: {
            type: "boolean",
            description: "If true, run as background job and return job_id immediately. Use shell.status to check progress.",
          },
        },
        required: ["command"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "shell.status",
      description: "Return the status and output of a running or completed background job.",
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
            description: "The job ID to cancel.",
          },
        },
        required: ["job_id"],
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
        "Read an image file from the selected project and return image content plus metadata. Path must stay inside the project root.",
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
