import type { ClientToolProfile } from "./tool-definitions.js";

// Project and tool execution own the canonical result. This adapter only changes
// the representation of a small, reviewed set of successful Claude responses.
type RecordValue = Record<string, unknown>;
type Result = {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function knownFields(value: RecordValue, names: readonly string[]): boolean {
  return Object.keys(value).every((name) => names.includes(name));
}

function textOnly(text: string): Result {
  return { content: [{ type: "text", text }] };
}

const READ_FIELDS = [
  "project_id", "path", "absolute_path", "start_line", "end_line",
  "total_lines", "has_more", "truncated", "next_start_line",
  "next_start_column", "returned_bytes", "size_bytes", "sha256", "lines",
] as const;

function readText(data: RecordValue): string | undefined {
  if (!knownFields(data, READ_FIELDS) || typeof data.path !== "string" ||
      typeof data.start_line !== "number" || typeof data.end_line !== "number" ||
      !Array.isArray(data.lines) || typeof data.has_more !== "boolean" ||
      typeof data.truncated !== "boolean") return undefined;
  if (data.total_lines !== null && typeof data.total_lines !== "number") return undefined;
  const lines: string[] = [];
  for (const value of data.lines) {
    const line = record(value);
    if (!line || !knownFields(line, ["line", "text"]) ||
        typeof line.line !== "number" || typeof line.text !== "string") return undefined;
    lines.push(String(line.line) + " | " + line.text);
  }
  const count = typeof data.total_lines === "number" ? String(data.total_lines) : "?";
  const header = data.path + " (lines " + data.start_line + "-" + data.end_line +
    " / " + count + (data.truncated ? "; truncated" : "") + ")";
  const parts = [header, ...lines];
  if (data.has_more) {
    if (typeof data.next_start_line !== "number" ||
        typeof data.next_start_column !== "number") return undefined;
    parts.push("next: start_line=" + data.next_start_line + " start_column=" + data.next_start_column);
  }
  return parts.join("\n");
}

const SEARCH_FIELDS = [
  "project_id", "query", "root", "matches", "truncated", "max_results",
  "offset", "next_offset", "line_preview_max_bytes", "context_preview_max_bytes",
] as const;

function searchText(data: RecordValue): string | undefined {
  if (!knownFields(data, SEARCH_FIELDS) || typeof data.root !== "string" ||
      !Array.isArray(data.matches) || typeof data.truncated !== "boolean") return undefined;
  const output = [String(data.matches.length) + " matches under " + data.root];
  let previousPath: string | undefined;
  for (const raw of data.matches) {
    const item = record(raw);
    if (!item || !knownFields(item, ["path", "line", "text", "before", "after"]) ||
        typeof item.path !== "string" || typeof item.line !== "number" ||
        typeof item.text !== "string") return undefined;
    const before = item.before === undefined ? [] : item.before;
    const after = item.after === undefined ? [] : item.after;
    if (!Array.isArray(before) || !Array.isArray(after) ||
        !before.every((x) => typeof x === "string") ||
        !after.every((x) => typeof x === "string")) return undefined;
    if (item.path !== previousPath) {
      output.push(item.path);
      previousPath = item.path;
    }
    before.forEach((text, index) => {
      output.push("  " + ((item.line as number) - before.length + index) + " | " + text);
    });
    output.push("  " + item.line + " | " + item.text);
    after.forEach((text, index) => {
      output.push("  " + ((item.line as number) + index + 1) + " | " + text);
    });
  }
  if (data.truncated) {
    output.push("truncated");
    if (typeof data.next_offset === "number") output.push("next_offset=" + data.next_offset);
  }
  return output.join("\n");
}

const LIST_FIELDS = ["project_id", "root", "entries", "truncated", "max_entries"] as const;

function listText(data: RecordValue): string | undefined {
  if (!knownFields(data, LIST_FIELDS) || typeof data.root !== "string" ||
      !Array.isArray(data.entries) || typeof data.truncated !== "boolean") return undefined;
  const lines = [data.root + " (" + data.entries.length + " entries)"];
  for (const value of data.entries) {
    const entry = record(value);
    if (!entry || !knownFields(entry, ["path", "type", "size"]) ||
        typeof entry.path !== "string" || typeof entry.type !== "string") return undefined;
    lines.push(entry.path + " [" + entry.type + "]");
  }
  if (data.truncated) lines.push("truncated; narrow the listing or increase max_entries");
  return lines.join("\n");
}

const SKILL_FIELDS = ["path", "scope", "origin", "name", "description", "sha256", "bytes", "content"] as const;

function skillText(data: RecordValue): string | undefined {
  if (!knownFields(data, SKILL_FIELDS) || typeof data.path !== "string" ||
      typeof data.content !== "string" || typeof data.scope !== "string" ||
      typeof data.origin !== "string" || typeof data.name !== "string") return undefined;
  return "Skill: " + data.name + "\nSource: " + data.path +
    "\nScope: " + data.scope + " (origin: " + data.origin + ")\n\n" + data.content;
}

const SELECT_FIELDS = [
  "selected", "changed", "project_id", "display_name", "project_root",
  "working_dir", "cwd", "sandbox_type", "agent_instructions", "context_id",
] as const;

function selectedText(data: RecordValue): string | undefined {
  if (!knownFields(data, SELECT_FIELDS) || data.selected !== true ||
      typeof data.context_id !== "string" || typeof data.project_id !== "string" ||
      typeof data.working_dir !== "string" || typeof data.cwd !== "string" ||
      typeof data.project_root !== "string" || typeof data.sandbox_type !== "string" ||
      typeof data.changed !== "boolean") return undefined;
  const lines = [
    "Selected: " + data.project_id,
    "Working directory: " + data.working_dir,
    "Project root: " + data.project_root,
    "CWD: " + data.cwd,
    "Sandbox: " + data.sandbox_type,
    "Changed: " + data.changed,
    "Context ID: " + data.context_id,
  ];
  if (data.agent_instructions === null) return [...lines, "", "Agent instructions: none"].join("\n");
  const agent = record(data.agent_instructions);
  if (!agent || !knownFields(agent, ["path", "content", "truncated", "sources"]) ||
      typeof agent.content !== "string" || !Array.isArray(agent.sources) ||
      typeof agent.truncated !== "boolean") return undefined;
  const sources: string[] = [];
  for (const value of agent.sources) {
    const source = record(value);
    if (!source || !knownFields(source, ["scope", "path", "truncated"]) ||
        typeof source.scope !== "string" || typeof source.path !== "string" ||
        typeof source.truncated !== "boolean") return undefined;
    sources.push(source.scope + ": " + source.path + (source.truncated ? " [truncated]" : ""));
  }
  lines.push("", "Agent instructions from:", ...sources, "", agent.content);
  if (agent.truncated) lines.push("[Agent instructions truncated at source]");
  return lines.join("\n");
}

function museProjectText(data: RecordValue): string | undefined {
  if (!knownFields(data, [
    "project_id", "display_name", "project_root", "working_dir", "cwd", "sandbox_type", "agent_instructions",
  ]) || typeof data.project_id !== "string" || typeof data.working_dir !== "string" ||
    typeof data.cwd !== "string") return undefined;
  const lines = [
    "Project: " + data.project_id,
    "Working directory: " + data.working_dir,
    "CWD: " + data.cwd,
  ];
  if (data.agent_instructions === null) return [...lines, "", "Agent instructions: none"].join("\n");
  const agent = record(data.agent_instructions);
  if (!agent || !knownFields(agent, ["path", "content", "truncated", "sources"]) ||
      typeof agent.content !== "string" || !Array.isArray(agent.sources) ||
      typeof agent.truncated !== "boolean") return undefined;
  const sources: string[] = [];
  for (const item of agent.sources) {
    const source = record(item);
    if (!source || !knownFields(source, ["scope", "path", "truncated"]) ||
        typeof source.scope !== "string" || typeof source.path !== "string" ||
        typeof source.truncated !== "boolean") return undefined;
    sources.push(source.scope + ": " + source.path + (source.truncated ? " [truncated]" : ""));
  }
  lines.push("", "Agent instructions from:", ...sources, "", agent.content);
  if (agent.truncated) lines.push("[Agent instructions truncated at source]");
  return lines.join("\n");
}

function batchText(data: RecordValue): string | undefined {
  if (!knownFields(data, ["results"]) || !Array.isArray(data.results)) return undefined;
  const parts: string[] = [];
  for (const raw of data.results) {
    const item = record(raw);
    if (!item || !knownFields(item, ["index", "tool", "result"]) ||
        typeof item.index !== "number" || typeof item.tool !== "string") return undefined;
    const result = record(item.result);
    if (!result) return undefined;
    const error = record(result.error);
    const payload = error ? JSON.stringify({ error: result.error })
      : item.tool === "workspace.read" ? readText(result)
      : item.tool === "workspace.search" ? searchText(result)
      : item.tool === "workspace.list" ? listText(result)
      : undefined;
    if (payload === undefined) {
      // Unknown child result: preserve all fields rather than losing information.
      parts.push("#" + item.index + " " + item.tool + "\n" + JSON.stringify(result));
    } else {
      parts.push("#" + item.index + " " + item.tool + "\n" + payload);
    }
  }
  return parts.length ? parts.join("\n\n") : "No batch results";
}

/**
 * Presentation-only projection after authorization and tool execution.
 * Unknown shapes, failures, and binary/media results always pass through.
 */
export function adaptMcpToolResult(
  profile: ClientToolProfile, name: string,
  args: Record<string, unknown>, result: Result
): Result {
  if (profile === "chatgpt" || result.isError || !Array.isArray(result.content) ||
      result.content.some((item) => item.type !== "text")) return result;
  if (!knownFields(result as RecordValue, ["structuredContent", "content", "isError"])) return result;
  const data = record(result.structuredContent);
  if (!data || "error" in data) return result;

  const formatted = name === "workspace.read" ? readText(data)
    : name === "workspace.search" ? searchText(data)
    : name === "workspace.list" ? listText(data)
    : name === "skills.read" ? skillText(data)
    : name === "project.select" && profile === "claude" ? selectedText(data)
    : name === "project.open" && profile === "muse" ? museProjectText(data)
    : name === "workspace.batch" && args.detail !== "full" ? batchText(data)
    : undefined;
  return formatted === undefined ? result : textOnly(formatted);
}
