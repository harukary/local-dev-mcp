const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function buildDevToolDefinitions() {
  return [
    { name: "workspace.batch", description: "Preferred for 2+ independent workspace reads, searches, or listings. Run 1-20 requests with up to four in flight and a shared output budget. Results are compact by default and omit metadata already present in the request; use detail=full only when needed.", inputSchema: { type: "object", properties: { requests: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { tool: { type: "string", enum: ["workspace.read", "workspace.search", "workspace.list"] }, arguments: { type: "object" } }, required: ["tool", "arguments"], additionalProperties: false } }, max_bytes: { type: "integer", minimum: 1024, maximum: 262144, description: "Shared response budget. Defaults to 65536 bytes." }, detail: { type: "string", enum: ["compact", "full"], description: "Compact is the default; full preserves each underlying tool response." } }, required: ["requests"], additionalProperties: false }, annotations: RO },
    { name: "project.inspect", description: "Inspect the selected project.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "workspace.read", description: "Read a project text file with line numbers. Default output budget is 65536 bytes; continue with next_start_line/next_start_column when has_more=true. Prefer workspace.batch for 2+ independent reads/searches/listings.", inputSchema: { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, start_column: { type: "integer", minimum: 0, description: "UTF-16 offset in the first line; use next_start_column from the preceding read." }, end_line: { type: "integer", minimum: 1 }, max_bytes: { type: "integer", minimum: 1, maximum: 2097152, description: "Maximum returned text bytes. Defaults to 65536." } }, required: ["path"], additionalProperties: false }, annotations: RO },
    { name: "workspace.list", description: "List files and directories in the selected project. Generated artifacts and logs are excluded at the project root by default; results are bounded.", inputSchema: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 8 }, glob: { type: "string" }, include_hidden: { type: "boolean" }, include_artifacts: { type: "boolean" }, max_entries: { type: "integer", minimum: 1, maximum: 5000 } } }, annotations: RO },
    { name: "workspace.search", description: "Search project text with ripgrep. Fixed-string, case-sensitive search is the default; results default to 50 and support offset continuation. Prefer workspace.batch for 2+ independent reads/searches/listings. Generated artifacts and logs are excluded from root searches unless requested.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 }, path: { type: "string" }, glob: { type: "string" }, context_lines: { type: "integer", minimum: 0, maximum: 5 }, max_results: { type: "integer", minimum: 1, maximum: 500, description: "Maximum matches per call. Defaults to 50." }, offset: { type: "integer", minimum: 0, maximum: 100000 }, regex: { type: "boolean" }, case_sensitive: { type: "boolean" }, include_hidden: { type: "boolean" }, include_artifacts: { type: "boolean" } }, required: ["query"], additionalProperties: false }, annotations: RO },
    {
      name: "workspace.patch",
      description: "Preferred tool for normal project text edits. For a targeted edit, use path + old_text + new_text; it requires a unique old_text match unless replace_all=true. Use replacement for whole-file content and unified_diff for patch-form edits. Prefer this over Python/Node/Ruby heredocs or shell text-replacement scripts.",
      inputSchema: {
        type: "object",
        properties: {
          patches: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    path: { type: "string", minLength: 1 },
                    expected_sha256: { type: "string" },
                    replacement: { type: "string" },
                  },
                  required: ["path", "replacement"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    path: { type: "string", minLength: 1 },
                    expected_sha256: { type: "string" },
                    old_text: { type: "string", minLength: 1, description: "Exact existing text to replace. Must match exactly once unless replace_all=true." },
                    new_text: { type: "string", description: "Replacement text used with old_text." },
                    replace_all: { type: "boolean", description: "Replace every exact old_text occurrence. Defaults to false; multiple matches otherwise return a conflict." },
                  },
                  required: ["path", "old_text", "new_text"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    unified_diff: { type: "string", minLength: 1, description: "Complete unified diff including ---/+++ file headers; do not send a bare @@ hunk." },
                  },
                  required: ["unified_diff"],
                  additionalProperties: false,
                },
              ],
            },
          },
          dry_run: { type: "boolean" },
        },
        required: ["patches"],
        additionalProperties: false,
      },
      annotations: WA,
    },

    { name: "git.inspect", description: "Inspect repository state in one call: branch/upstream/ahead-behind, changed files, recent commits, worktrees, and diff stat. Prefer this over bundling multiple read-only git shell commands.", inputSchema: { type: "object", properties: { include_untracked: { type: "boolean" }, recent_commits: { type: "integer", minimum: 0, maximum: 20 }, include_worktrees: { type: "boolean" }, include_diff_stat: { type: "boolean" } } }, annotations: RO },
    { name: "git.status", description: "Return structured git status, upstream, and ahead/behind counts for the selected project.", inputSchema: { type: "object", properties: { include_untracked: { type: "boolean" } } }, annotations: RO },
    { name: "git.log", description: "Return recent commits for a git ref, optionally scoped to one project path.", inputSchema: { type: "object", properties: { ref: { type: "string" }, path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } }, annotations: RO },
    { name: "git.show", description: "Show a commit/ref as a bounded patch, stat, or name-status output, optionally scoped to one project path.", inputSchema: { type: "object", properties: { ref: { type: "string" }, path: { type: "string" }, mode: { type: "string", enum: ["patch", "stat", "name-status"] }, max_bytes: { type: "integer", minimum: 1024, maximum: 2097152 } } }, annotations: RO },
    { name: "git.diff", description: "Return git diff for the selected project.", inputSchema: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" }, stat: { type: "boolean" }, max_bytes: { type: "integer" } } }, annotations: RO },
    {
      name: "git.push",
      description: "Safely push only the current branch HEAD to its already-configured upstream branch. Requires expected_head to resolve to the current local HEAD, rejects detached HEAD, missing upstream, and behind/diverged state, never force-pushes, never pushes tags, never deletes refs, and verifies the remote branch HEAD after the push. Prefer this over shell.run for normal Git pushes, especially in ChatGPT Scheduled Tasks.",
      inputSchema: {
        type: "object",
        properties: {
          expected_head: { type: "string", minLength: 7, maxLength: 64, pattern: "^[0-9a-fA-F]+$", description: "Expected local HEAD commit SHA or unambiguous hex abbreviation obtained from git.inspect/status/log/show. The push is rejected if it does not resolve exactly to the current HEAD." },
        },
        required: ["expected_head"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  ];
}
