const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const kind = { type: "string", enum: ["bug", "improvement", "missing_feature"] };
const status = { type: "string", enum: ["open", "in_progress", "resolved", "dismissed"] };

export function buildFeedbackToolDefinitions() {
  return [
    {
      name: "feedback.report",
      description: "Report a reproducible local-dev MCP defect, recurring friction, missing capability, or concrete improvement. Use proactively when a real issue is observed, not for transient retries or every failed call. Never include credentials, raw logs, personal data, or full tool inputs/outputs. Reports are shared across authenticated clients; no selected project is required. Exact same title/kind/tool/project reports are counted together; existing_id explicitly records a recurrence.",
      inputSchema: {
        type: "object",
        properties: {
          kind,
          title: { type: "string", minLength: 1, maxLength: 160, description: "Specific concise symptom or improvement title." },
          description: { type: "string", minLength: 1, maxLength: 2000, description: "Minimal reproducible circumstances and expected vs actual behavior; no raw logs or secrets." },
          impact: { type: "string", maxLength: 500, description: "Concrete user or agent impact." },
          suggestion: { type: "string", maxLength: 1000, description: "Optional proposed improvement, not a mandatory fix." },
          related_tool: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$", description: "Relevant local-dev MCP tool name, if known." },
          project_id: { type: "string", minLength: 1, maxLength: 128, description: "Optional registered project; otherwise use the currently selected project if one exists. Omit for server-wide issues." },
          existing_id: { type: "string", pattern: "^fb_[a-f0-9-]{36}$", description: "Existing feedback ID for a known recurrence. Reopens resolved items." },
        },
        required: ["kind", "title", "description"],
        additionalProperties: false,
      },
      annotations: WA,
    },
    {
      name: "feedback.list",
      description: "Review durable local-dev MCP issues and improvements across ChatGPT, Claude and Muse, including unresolved and recurring reports. Default is all active reports across projects; use status=all and recent_days=7 for a weekly change/reopen review. No selected project is required. Combine with tool.usage for weekly improvement analysis.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "open", "in_progress", "resolved", "dismissed", "all"], description: "Default active (open + in_progress); all includes closed reports." },
          kind,
          project_id: { type: "string", minLength: 1, maxLength: 128, description: "Optional project filter; omit for all projects." },
          recent_days: { type: "integer", minimum: 1, maximum: 365, description: "Optional filter by last update, UTC calendar-independent rolling days." },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum items, default 50." },
          offset: { type: "integer", minimum: 0, description: "Pagination offset when has_more=true." },
        },
        additionalProperties: false,
      },
      annotations: RO,
    },
    {
      name: "feedback.update",
      description: "Track work on an existing local-dev MCP feedback report. Update status, a concise latest action note, or the resolution/verification reference. Closing a report requires resolution; resolve only after verifying the changed behavior. No selected project is required.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^fb_[a-f0-9-]{36}$", description: "Feedback ID returned by feedback.report or feedback.list." },
          status,
          note: { type: "string", minLength: 1, maxLength: 1000, description: "Latest investigation or verification result; no secrets or raw logs." },
          resolution: { type: "string", minLength: 1, maxLength: 1000, description: "Verified fix summary, commit reference, or dismissal rationale. Required when first closing a report." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: WA,
    },
  ];
}
