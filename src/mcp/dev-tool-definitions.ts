const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildDevToolDefinitions() {
  return [
    { name: "project.inspect", description: "Inspect the selected project.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "workspace.read", description: "Read a project text file with line numbers.", inputSchema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" }, max_bytes: { type: "integer" } }, required: ["path"] }, annotations: RO },
    { name: "workspace.list", description: "List files and directories in the selected project.", inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer" }, glob: { type: "string" }, include_hidden: { type: "boolean" } } }, annotations: RO },
    { name: "workspace.search", description: "Search text files in the selected project.", inputSchema: { type: "object", properties: { query: { type: "string" }, glob: { type: "string" }, context_lines: { type: "integer" }, max_results: { type: "integer" } }, required: ["query"] }, annotations: RO },
    { name: "workspace.patch", description: "Apply replacement or diff text patches inside the selected project.", inputSchema: { type: "object", properties: { patches: { type: "array", items: { type: "object", properties: { path: { type: "string" }, expected_sha256: { type: "string" }, replacement: { type: "string" }, unified_diff: { type: "string" } } } }, dry_run: { type: "boolean" } }, required: ["patches"] }, annotations: WA },
    { name: "git.status", description: "Return structured git status for the selected project.", inputSchema: { type: "object", properties: { include_untracked: { type: "boolean" } } }, annotations: RO },
    { name: "git.diff", description: "Return git diff for the selected project.", inputSchema: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" }, stat: { type: "boolean" }, max_bytes: { type: "integer" } } }, annotations: RO },
  ];
}
