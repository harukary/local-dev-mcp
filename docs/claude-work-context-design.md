## MCP client architecture

The server exposes a single set of development operations through authenticated client-specific MCP interfaces. ChatGPT and Claude share project validation, tool execution, auditing, and persistent work state. Only client-facing tool contracts and the final presentation of tool results may differ.

The intended behavior is to deliver **all information required to do the work, without repeatedly sending unnecessary serialization or metadata to the model**. Optimize for correctness and usable source evidence, not just minimum byte count.

### Delivery boundary

Authenticated ChatGPT tool definitions, context resolution, and result representations remain unchanged. Claude uses explicit work-context handles and a deterministic, client-specific response adapter for selected text-oriented tools. The shared tool implementations still produce canonical structured results, and only the authenticated Claude response is projected to text.

## Client identification and state

| Client | Authentication | Tool input contract | Work context |
| --- | --- | --- | --- |
| ChatGPT | OpenAI Secure MCP Tunnel token | Existing tool descriptors, unchanged | Existing OpenAI chat session or explicit Scheduled Task scope |
| Claude | Verified Cloudflare Access JWT with user `sub` | Dedicated descriptors with explicit `context_id` | Server-issued opaque work context |
| Local stdio | Local process | Existing descriptors, unchanged | Existing local context behavior |

Client identity is derived from verified transport authentication, never from `user-agent`, `x-anthropic-client`, unverified `_meta`, or tool arguments. The same authenticated profile selects the tool list, input validator, context resolver, dispatcher policy, and result adapter.

For Claude, `project.select({project_id, working_dir?})` creates a new random `context_id` and persists the chosen project, optional worktree directory, and verified owner's hash. Any subsequent browser state is owned by that context. Subsequent project-scoped operations require the handle. `project.select({context_id, project_id, working_dir?})` reopens the same project and worktree without changing its scope. Different projects or working directories require a fresh `project.select` without a handle. Missing, unknown, or unauthorized handles fail without falling back to a shared default context.

The public handle is returned to Claude on selection but never echoed by unrelated tool results or written to logs. The storage key is a hash-derived internal context ID. The browser and asynchronous shell-job ownership checks continue to use this verified internal identity. Because a context's project and worktree are immutable, browser and job ownership cannot outlive a scope change. ChatGPT session behavior is unchanged.

A Claude conversation can intentionally reuse a handle from another conversation belonging to the same authenticated user. No verified Claude conversation ID reaches the server, so a handle establishes a **work context**, not a guarantee of one context per Claude chat.

## Request and result pipeline

    Authenticated MCP request
      -> client-specific tool input schema / validation
      -> resolve authorized project and work context
      -> shared tool implementation
      -> canonical result (structured data, native media, error state)
      -> derive error / partial-success telemetry from canonical result
      -> authenticated client response adapter
          ChatGPT: return the original result unchanged
          Claude:  format selected text-oriented results
                   preserve structured and media results when needed
      -> apply the existing final-response size limit
      -> record transmitted size and return

The response adapter **only changes presentation**. It cannot resolve paths, change permissions, perform new filesystem access, reinterpret an error as success, or alter persistent state.

Do not build a second tool implementation, a separate MCP server, a custom JavaScript execution service for Claude, or a general-purpose "summarize all tool results" LLM. ChatGPT's Code Mode is a client-side execution capability; reproducing it inside the MCP server would add execution and security responsibilities unrelated to this requirement.

## Result contracts

MCP `content` is the normal model-facing channel for text, images, and other supported media; `structuredContent` is optional structured data. For backward compatibility, MCP recommends serializing `structuredContent` into text too, but this is not a requirement for tools returning **only ordinary text**. A tool declaring `outputSchema` must not return structured data that violate that schema.

The adapter uses an explicit allowlist of text-oriented tools. Never infer a result's format from a random field name, response length, or a generic "JSON looks unnecessary" heuristic.

| Tool / result family | Claude result | Required preservation |
| --- | --- | --- |
| `workspace.read` | One plain `TextContent` block, no `structuredContent` | Exact returned text, original line numbers, continuation cursor |
| `workspace.search` | Plain text matches grouped by relative path | Each matched line, before/after context, truncation and `next_offset` |
| `workspace.list` | Plain text path and entry type list | Relative paths, directory/file distinction, truncation |
| `workspace.batch`, default compact mode | One text block with indexed child results | Child tool identity, result order, individual errors, continuation |
| `workspace.batch`, `detail=full` | Existing complete structured representation | Existing diagnostic escape hatch for fields not in compact text |
| `skills.read` | Full skill/reference text with source path | Entire content within the existing size limit, explicit `FILE_TOO_LARGE` error otherwise, and source provenance |
| `project.select` | Plain text containing selected project, `working_dir`, `context_id`, and complete agent instructions | Handle can be copied into later calls; no placeholder hiding AGENTS content |
| `git.diff` / `git.show` | Existing structured result | Exact diff, file paths, hunks, and truncation; formatting is deferred until the result shapes and client handling justify it |
| Other Git, repo-action, shell, job, mobile, browser, Todo, and global management results | Existing structured result initially | Operation IDs, timestamps, statuses, execution and authorization details |
| Inline `ImageContent` and other non-text media | Existing MCP media blocks unchanged | Native content blocks, byte budgets, client compatibility |
| Any failure result | Existing error structure initially | `isError`, stable error code, actionable message; no concealed partial failure |

The response adapter formats `workspace.read`, `workspace.search`, `workspace.list`, default `workspace.batch`, `skills.read`, and `project.select`. Git diff/show and all other operations retain their existing results until their actual output and consumer needs justify a formatter.

An unfamiliar successful result shape must fall back to the existing full result, **not** silently omit fields.

### File reading

For a complete read, return a compact header and the original line text:

    README.md (lines 1–43 / 43)
     1 | # 100年日記 / 100-Year Diary
     2 |
     3 | ローカル保存・Zipエクスポート・PDF保存...

Do not include `project_id`, `absolute_path`, `size_bytes`, `returned_bytes`, `sha256`, null continuation fields, or duplicate JSON by default. The selected context and the request already determine the project and path.

When the response is incomplete, include the **exact** existing continuation data rather than an estimated next line:

    README.md (lines 1–16 / 43; truncated)
    ...
    next: start_line=16 start_column=207

A continuation at a UTF-16 column offset may resume in the same line. It must not be rounded to the following line. Preserve each returned `lines[].text` value exactly; do not trim indentation, wrap long lines, or summarize content to reduce tokens. Maintain the file reader's existing newline handling, bounded-read behavior, and output budget.

A tool user that genuinely needs all of the original metadata can use `workspace.batch({context_id,detail:"full",requests:[...]})`; do not introduce a separate "format" argument on every workspace tool merely for this case.

### Search, listing, and batches

Search output is organized by file, with real line numbers and snippets. The original number of matches, pagination offset, and truncation status stay observable. If context lines were requested, include them with the correct line references; do not silently drop before/after lines.

    3 matches under src/
    src/mcp/server.ts
      721 | result = jsonError(...)
      725 | result = jsonError(...)
    next_offset=3 (truncated)

Listing output should distinguish directories from files, for example `src/mcp/ [directory]` and `src/mcp/server.ts [file]`. Preserve deterministic path ordering. File size is not emitted by default when the task is just navigation.

For a batch, mark each child by its original index and tool name, and apply the corresponding formatter to each successful child. Display child errors independently, not as a generic "batch failed" message. Do not change nested request validation, project context inheritance, the shared byte budget, or response-order semantics.

### Project selection and model-visible instructions

The first Claude `project.select` returns the actual `context_id`, project, working directory, and all bounded agent instructions **in a single model-visible text response**. This corrects the current Claude risk that AGENTS content exists only in `structuredContent`, while the text fallback says it is available elsewhere.

    Selected: hundred-year-diary
    Working directory: .
    Context ID: ctx_...

    Agent instructions:
    [actual global and project AGENTS content]

Claude receives one text-only result without a second copy of AGENTS in `structuredContent`. Verify with a real Claude.ai chat that the model retains the ID and complete instructions. ChatGPT's existing agent-instruction behavior remains unchanged because its Code Mode can selectively extract `structuredContent`.

Model-visible instructions are legitimate task context, not disposable serialization overhead. Do not suppress or truncate them further merely to improve a byte-count metric. Existing content limits and truncation indicators still apply.

### Errors, output schemas, and image handling

Always format errors after the dispatcher has validated the requested handle, project, permissions, and tool input. An error must remain an error even when its text is short. `CONTEXT_ID_REQUIRED`, `CONTEXT_NOT_FOUND`, permission failures, partial batch failures, process exit statuses, and timeouts retain their actionable meaning.

Text-only Claude results should not declare a structured `outputSchema`. Any tool that already has an `outputSchema` must retain a compatible `structuredContent` contract; leave it unchanged unless the schema and behavior are redesigned together.

Keep all image/audio/resource content blocks unchanged. ChatGPT's image tools deliberately avoid an `outputSchema` in certain cases to preserve inline image blocks. No generic adapter may reinterpret base64 image data as text or silently discard non-text blocks.

Claude currently does not expose `artifact.receive`, `artifact.link`, or the existing unscoped MCP Resources flow. This security boundary is independent of response formatting and remains in place.

## Ownership and implementation

- Add a small deterministic `src/mcp/response-adapter.ts` responsible only for client-specific result projection. It receives the authenticated profile, tool name, validated request metadata needed for headings, and the canonical tool result.
- Keep file reading, search, listing, batch, Git, and skill handlers in their current locations and return their current canonical structured results. Do not copy business logic into the adapter.
- In `src/mcp/server.ts`, derive semantic success/failure and partial batch metrics from the canonical result **before** projection; apply the existing final output limit to the **projected** result so unnecessary original JSON does not cause a spurious size failure.
- Record transmitted bytes from the projected result and preserve the existing error-code accounting. If profile-level size statistics are needed for evaluation, aggregate counts and sizes only, not raw file content.
- Keep ChatGPT tool definitions, `outputSchema`, result representation, image handling, stateless Scheduled Task behavior, and session resolution unchanged.
- Keep current Claude `context_id` input schemas, verification, ownership checks, and browser/job isolation unchanged. Output presentation must never be a second authorization path.
- Use plain text and line-preserving deterministic formatters. No additional AI calls, dependencies, database, server process, or tool category is required.

## Verification contract

Validate these conditions against both the implementation and the running MCP clients. Automated MCP tests cover the structural behavior; Claude.ai's actual model ingestion is a separate live acceptance check:

1. **ChatGPT parity:** original tool definitions and representative `structuredContent`, `content`, image, and resource-link results remain identical; session and Scheduled Task tests still pass.
2. **Claude text delivery:** `workspace.read` returns exactly one useful text block with no duplicate `structuredContent`; line number, multiline Unicode, empty lines, long-line column continuation, and source evidence remain correct.
3. **Claude structured escape hatch:** `workspace.batch detail=full` retains the complete data when a caller needs metadata such as `sha256`.
4. **Search/list/batch correctness:** filenames with spaces/Unicode, matched context lines, pagination, truncation, empty results, deterministic ordering, and mixed successful/failed child results are faithfully represented.
5. **Project selection:** a real Claude.ai chat receives the handle and **actual** agent instructions; its next two project-scoped calls reuse the handle; another chat creates a separate handle. Server context ownership remains enforced.
6. **Errors/media:** invalid context, invalid tool arguments, missing file, output limits, and binary media remain visible and correctly typed; Claude image rendering is checked independently.
7. **Size and outcome:** measure MCP wire bytes and model-visible text bytes for the actual `hundred-year-diary/README.md` example and representative short/large inputs. Assess whether Claude can use the information correctly. Do not claim a token reduction solely from a smaller wire payload, because Claude.ai's internal ingestion and token accounting are not observable from server logs.

## Design boundaries

This change is a **presentation optimization**, not a different local-dev-mcp state architecture. The model's ability to continue work, read files faithfully, navigate by path/line, recover from errors, and operate the same tools is more important than maximizing byte reduction.

Do not implement a Claude-side Code Mode clone or a broad "text versus JSON" user setting. If other tool families later demonstrate similar waste, extend the explicit formatter table based on real output shapes and client verification rather than adding a generic transformation that may discard meaningful state.
