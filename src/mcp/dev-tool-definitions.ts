const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildDevToolDefinitions() {
  return [
    { name: "project.inspect", description: "Inspect the selected project.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "workspace.read", description: "Read a project text file with line numbers.", inputSchema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" }, max_bytes: { type: "integer" } }, required: ["path"] }, annotations: RO },
    { name: "workspace.list", description: "List files and directories in the selected project.", inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer" }, glob: { type: "string" }, include_hidden: { type: "boolean" } } }, annotations: RO },
    { name: "workspace.search", description: "Search text files in the selected project.", inputSchema: { type: "object", properties: { query: { type: "string" }, glob: { type: "string" }, context_lines: { type: "integer" }, max_results: { type: "integer" } }, required: ["query"] }, annotations: RO },
    { name: "workspace.patch", description: "Apply replacement or diff text patches inside the selected project.", inputSchema: { type: "object", properties: { patches: { type: "array", items: { type: "object", properties: { path: { type: "string" }, expected_sha256: { type: "string" }, replacement: { type: "string" }, unified_diff: { type: "string" } } } }, dry_run: { type: "boolean" } }, required: ["patches"] }, annotations: WA },

    {
      name: "notes.guidelines",
      description: "Return the writing guidelines for public compact Notes.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
    },
    {
      name: "notes.create",
      description: "Create a public note in the selected Astro homepage project under src/content/notes.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title." },
          description: { type: "string", description: "Short description for note index and metadata. Must be reviewed in chat before creation." },
          tags: { type: "array", items: { type: "string" }, description: "Topic tags." },
          source_urls: { type: "array", items: { type: "string" }, description: "Reference URLs used for the note." },
          body: { type: "string", description: "Markdown body reviewed in chat before creation." },
          slug: { type: "string", description: "Optional URL/file slug. Generated from title when omitted." },
          overwrite: { type: "boolean", description: "Overwrite an existing note file when true." }
        },
        required: ["title", "description", "body"]
      },
      annotations: WA,
    },
    {
      name: "notes.validate",
      description: "Validate notes in the selected Astro homepage project and report note metadata issues.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      annotations: RO,
    },
    {
      name: "private_notes.guidelines",
      description: "Return operating instructions for the separate private-notes HTML site. Use this before creating or editing private notes.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
    },
    {
      name: "private_notes.create",
      description: "Create a private HTML note under public/notes and regenerate public/index.html. This auto-resolves the private-notes project from registry project_id=private-notes or LOCAL_DEV_MCP_PRIVATE_NOTES_ROOT, independent of the currently selected project.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Private note title." },
          body_html: { type: "string", description: "HTML fragment for the note body, reviewed in chat before creation." },
          slug: { type: "string", description: "Optional URL/file slug. Generated from title when omitted." },
          date: { type: "string", description: "Optional YYYY-MM-DD date. Defaults to today." },
          project: { type: "string", description: "Optional project slug. When set, the note is written under public/notes/<project>/." },
          type: { type: "string", description: "Optional database type metadata. Defaults to note." },
          status: { type: "string", description: "Optional database status metadata. Defaults to draft." },
          tags: { type: "array", items: { type: "string" }, description: "Optional database tags metadata." },
          parent: { type: "string", description: "Optional parent note id, meaning filename without .html." },
          pinned: { type: "boolean", description: "Pin the note to the top of generated views when true." },
          overwrite: { type: "boolean", description: "Overwrite the generated note path when true." }
        },
        required: ["title", "body_html"]
      },
      annotations: WA,
    },
    {
      name: "private_notes.validate",
      description: "Validate the private-notes project and regenerate public/index.html from public/notes/*.html, independent of the currently selected project.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      annotations: RO,
    },
    { name: "git.status", description: "Return structured git status for the selected project.", inputSchema: { type: "object", properties: { include_untracked: { type: "boolean" } } }, annotations: RO },
    { name: "git.diff", description: "Return git diff for the selected project.", inputSchema: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" }, stat: { type: "boolean" }, max_bytes: { type: "integer" } } }, annotations: RO },
  ];
}
