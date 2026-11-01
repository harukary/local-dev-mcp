# Claude Work Contexts

## Runtime architecture

The MCP server runs one set of tool implementations behind two authenticated client profiles. The ChatGPT interface is unchanged. Cloudflare Access users receive a Claude-specific tool interface that requires an explicit, model-managed work context handle.

| Client | Authentication | Tool input schema | Context identity |
| --- | --- | --- | --- |
| ChatGPT | Existing OpenAI Secure MCP Tunnel | Existing tool surface, unchanged | Existing `openai/session` and Scheduled Task behavior |
| Claude | Cloudflare Access JWT with verified `sub` | Tool surface with `context_id` | Server-issued opaque work context |
| Local stdio | Local process boundary | Existing tool surface | Existing local behavior |

The server uses a single Express HTTP endpoint and stateless MCP transport. Authentication determines the client profile before `tools/list` and `tools/call`; neither `user-agent` nor MCP metadata can select it. The same dispatcher and underlying tool implementations serve both clients.

## Claude context lifecycle

1. In a new Claude conversation, call `project.select({ "project_id": "target-project" })`. Optionally include a project-relative `working_dir`. The server returns `context_id` alongside the selected project, directory and existing agent instructions.
2. Keep the returned `context_id` in the conversation and pass it on every project-scoped operation, including `workspace.*`, `git.*`, `repo.action.*`, `browser.*`, `mobile.*`, `shell.*`, and `project.current`.
3. To select another project or working directory in the **same** work context, call `project.select({ "context_id": "ctx_...", "project_id": "new-project" })`. To create another isolated work context, omit the handle.
4. To deliberately resume an older work context, call `project.select` with its existing handle and the desired project. Different Claude conversations do **not** receive unique IDs automatically.
5. If a handle is lost, create a new work context with `project.select`. The server does not guess which old context to restore.

The handle is random and opaque; only its SHA-256-derived internal key and the verified user's subject hash are persisted in the existing `ChatContextStore`. The raw handle is returned to the model but never written to server logs, audit logs or persisted browser manifests.

All project-dependent tool calls require the handle. `project.list`, `project.reload`, `skills.read`, global diagnostics and global read-only Todo queries remain context-free after transport authentication. A Claude `project.list` call never reports a shared current project. The `workspace.batch` outer call receives the handle, which supplies the project and directory to all nested read/list/search operations.

An unknown handle or another user's handle returns `CONTEXT_NOT_FOUND`; missing context returns `CONTEXT_ID_REQUIRED`. Conflicting explicit project or directory scope returns `CONTEXT_PROJECT_CONFLICT`. No such error falls back to the old shared `default` context.

## Tool schemas and output compatibility

`buildToolDefinitions()` with no arguments publishes the original ChatGPT tool definitions. The Claude profile projects an authenticated subset of the same definitions, adding `context_id` to `project.select` as an optional argument and to stateful tool calls as a required argument. Validation caches are keyed by client profile **and** tool name.

The dispatcher repeats the profile checks independently of `tools/list`: callers cannot invoke hidden tools by sending a direct `tools/call`.

`project.select` includes `context_id` in both MCP `structuredContent` and text `content`. All other results keep the existing underlying MCP content representation. Claude's `tool.schema` introspects Claude's own tool surface; ChatGPT sees the same tool schema and output contracts as before.

ChatGPT's `image.read` intentionally has **no** declared `outputSchema` to preserve inline MCP image blocks. That compatibility behavior remains unchanged. Claude can try the same inline `image.read` path with an explicit context; live Claude image rendering remains a client-dependent verification item.

`artifact.receive` needs ChatGPT `openai/fileParams`, and `artifact.link` needs model-facing MCP resource-link support. Both are hidden and blocked on Claude. The Claude MCP Resources API is disabled because the existing `resources/read` path cannot authenticate a model-managed work context; use scoped `workspace.*` or direct `artifact.read` instead. ChatGPT's resource and file transfer contract is unchanged.

## Authentication and isolation

Cloudflare Access JWT verification checks RS256 signature, issuer, audience, expiry and nonempty user `sub`. The verified subject is hashed to bind each Claude context to its user. The raw JWT, raw handle and subject are never included in audit records. Invalid or absent credentials are rejected at the HTTP boundary.

Every Claude tool call resolves its handle to an internal `claude-context:<hash>` key before side effects. The existing browser profile manager accepts that internal key, retains separate browser snapshots and rejects access to another profile. Background shell jobs started through Claude record the owning internal context, and `shell.status` and `shell.cancel` reject jobs from other contexts. Shell approvals are already keyed by that context.

Individual Git worktrees, local files and attached devices remain physically shared across contexts. A context ID isolates *selection and ownership*, not the underlying filesystem or mobile device. Existing project policies, browser-operation locks and build serialization continue to apply.

A model can deliberately or accidentally reuse a valid handle in another Claude conversation belonging to the same verified user. The server cannot detect the originating Claude conversation because Claude.ai sends no verified chat identifier. Therefore this is **work-context isolation**, not a cryptographic guarantee of one handle per Claude chat.

## Local implementation and verification

- `src/mcp/cloudflare-access.ts`: validates JWT subject.
- `src/mcp/claude-context.ts`: creates and resolves handles and coordinates project selection.
- `src/project/context-store.ts`: existing persistent project and working-directory state, with Claude owner hash.
- `src/mcp/tool-definitions.ts`: client-specific tool views with a shared base definition.
- `src/mcp/input-validation.ts`: profile-specific validation without changing ChatGPT's contract.
- `src/mcp/server.ts`: authenticated client selection, context validation and shared dispatch.
- `src/browser/profile-manager.ts`: independent browser profile ownership.
- `src/shell/job-manager.ts`: explicit ownership of Claude asynchronous shell jobs.

Local tests cover the exact original ChatGPT tool-descriptor fingerprint, Claude tool discovery, project selection/resume, two concurrent work contexts, nested batch execution, missing and unauthorized handles, another user's handle, browser ownership, and shell-job ownership. Real-client checks are required for Claude's model reliably carrying the handle, optional image delivery and ChatGPT connector bindings after deployment.
