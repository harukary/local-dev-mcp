# Claude Work Context Design

## Status and objective

This is the proposed implementation contract, not the currently deployed behavior. Design Claude work-context isolation without changing ChatGPT's published MCP tool surface or existing session behavior.

An interactive work context owns the selected project, optional working directory, and the browser profile used by that work. Claude.ai does not provide a verified conversation identifier to the current MCP endpoint, so it must pass an opaque context handle between tool calls. This is a model-managed work handle, **not proof of the originating Claude conversation**.

Required outcomes:

- ChatGPT's input schemas, output schemas, tool descriptions, annotations, tool results and existing session resolution remain unchanged.
- Claude can select a project once and reuse the selection for paths and browser operations within one work context, without repeating `project_id` on every call.
- Separate new Claude work contexts cannot accidentally reuse a shared `default` project or browser.
- Missing, invalid, or unauthorized context handles fail before any project-scoped operation executes.
- Maintain one shared implementation of each actual tool; vary only the authenticated client interface and context resolution.
- Retain the existing HTTP transport, Cloudflare Access authentication, ChatGPT tunnels and local stdio compatibility.

## Authenticated client profile

Choose the MCP client profile **only from successful server-side transport authentication**, not from the `user-agent`, `x-anthropic-client`, tool arguments or unverified MCP `_meta`.

| Authenticated transport | Tool profile | Work context resolution |
| --- | --- | --- |
| Existing OpenAI Secure MCP Tunnel token | `chatgpt` | Existing `openai/session`, subject and Scheduled Task behavior |
| Verified Cloudflare Access application JWT | `claude` | Explicit `context_id` bound to the verified JWT `sub` |
| Local stdio | `legacy` | Existing local behavior, no Claude-specific required input |

Today, `createCloudflareAccessVerifier` verifies JWT claims but discards the payload. Its verified result must expose the `sub` claim as the authorization principal, validated as a nonempty string. Use only the **verified** signed claim; fail closed if an identity-based principal cannot be obtained. Store a deterministic hash of the principal, never the JWT or email. Access service tokens lacking a user `sub` do not automatically qualify for Claude work contexts.

The HTTP handler already creates a separate `createMcpServer(ctx)` per request. Extend the per-request context with the authenticated tool profile and principal. `tools/list` and `tools/call` must use exactly the same profile within each request. Do not change routing or hostnames merely to select a profile.

## One tool implementation, two tool surfaces

Keep the existing parameterless `buildToolDefinitions()` output **identical** for the ChatGPT and legacy profiles. Build the Claude list as a projection of the common tool descriptors:

- `project.select`: continue requiring `project_id`; add optional `context_id` so an existing work context can change project or working directory.
- `project.list`: allow unauthenticated work-context bootstrap after transport authorization, without using the previously shared `default` project. In Claude results, a global `current` project is never inferred.
- `project.current`, `skills.list` when project-scoped, `project.inspect`, all project-dependent workspace/Git/repo/shell/image/mobile tools, and all `browser.*` tools: add a **required** `context_id: string` property on the Claude `inputSchema`. A selected context resolves both `project_id` and `working_dir`.
- Control operations that refer to work-specific resources, including pending shell approvals, job control, and browser profile access, must validate ownership of that work context; a `job_id` or profile identifier alone does not grant cross-context access.
- Truly global read-only tools (for example `tool.usage` and `tool.schema`) may remain context-free after authentication. Classify all current tool names explicitly rather than applying the requirement opportunistically.
- Keep `project_id` / `working_dir` explicit-scope parameters where already supported. For a Claude request with a valid `context_id`, reject conflicting explicit scope instead of silently overriding it; a one-off explicitly scoped call may be offered separately only if its semantics and required-schema contract are unambiguous.
- `workspace.batch` requires `context_id` **on the outer call only**. Its nested read/list/search requests inherit the validated temporary context; internal batch validation uses the nested tool schema without recursively requiring another `context_id`.

Claude should not see tools that require ChatGPT-only client capabilities. In particular, `artifact.receive` relies on `openai/fileParams` and should be omitted from the Claude tool list **and blocked in the Claude dispatcher**. `artifact.link` and `resources/read` require special care: today resource retrieval resolves context from MCP request metadata, which Claude does not supply. Do not expose the existing link-based flow to Claude until a context-bound resource identifier and ownership check are implemented. Direct inline `image.read` can be tested independently.

Use `buildToolDefinitions("claude")` (or equivalent) only to transform descriptors. No second handwritten set of operation schemas or handlers.

## Claude work-context lifecycle

The first `project.select({ project_id, working_dir? })` in a Claude chat creates a cryptographically random, unguessable `context_id`, for example `ctx_<random>`. The result contains the handle in both MCP `structuredContent` and text `content`, so the model can pass it into subsequent calls. A `project.select` that supplies an existing valid handle changes that work context's selected project or directory.

The server stores only the handle's hash as the internal context key, alongside the hash of the Cloudflare Access `sub`, project selection, working directory and timestamps in the existing `ChatContextStore` persistence. Never write the raw handle into audit logs, server logs or persistent browser manifests.

On every subsequent Claude tool call:

1. Confirm authenticated Cloudflare client and verified user principal.
2. Parse and validate the required `context_id`.
3. Resolve its hashed internal context record and verify owner identity.
4. Resolve project and working directory from the record; reject an unavailable project or conflicting explicit scope.
5. Execute the existing handler with the trusted internal `chatContextId`.
6. Preserve the existing MCP result, except for documented Claude-specific bootstrap fields and compatibility differences.

Required error cases:

- Missing: `CONTEXT_ID_REQUIRED`.
- Unknown, malformed, or owned by another user: `CONTEXT_NOT_FOUND` (do not reveal whether another user's handle exists).
- No selected project or removed project: `PROJECT_NOT_SELECTED`.
- Conflicting explicit project scope: `CONTEXT_PROJECT_CONFLICT`.
- No valid owner identity: deny the Claude request rather than accepting a global `default` context.

Do not guess a context from the most recent request, OAuth session, `user-agent`, client fingerprint, process state or last selected project. The existing persisted ChatGPT contexts must remain untouched.

This design deliberately allows a handle to be reused in another Claude chat **when the same authorized user supplies it**. Because Claude.ai does not transmit a conversation ID, the server cannot enforce chat-to-chat ownership beyond the handle. This supports explicit work resumption but is not automatic conversation isolation. If Claude loses the handle after context compaction, the model must supply an old handle or create a new context; the server must not silently recover an arbitrary old selection.

## Browser and other persistent operations

The browser manager currently accepts only internal keys beginning with `chatgpt-session:`. Extend the recognized **internally resolved** browser-owner keys to include `claude-context:`, without relaxing `getOwnedProfile` checks. Derive each browser profile from the hashed internal context key using the existing profile hash, lock and lifecycle machinery. Do not repurpose `browser.session_id`, which is currently unsupported as a caller-selected identifier.

Existing browser suspension, tab restoration and retention stay unchanged. Shell job identifiers and mobile devices are still physical shared resources; separate work context IDs do not create independent Git worktrees, running jobs or device instances. Existing concurrent-use controls remain responsible for conflicting operations, and any context-sensitive job-control action must check its owning context.

## Result and output-schema contracts

MCP `inputSchema` describes arguments; `outputSchema` optionally describes `structuredContent`. They are protocol-level contracts for both clients, not two unrelated output formats.

- ChatGPT: preserve current `structuredContent`, `content`, `outputSchema`, descriptor `_meta`, and response sizing behavior exactly. In particular, `image.read` intentionally has no `outputSchema` because the current ChatGPT bridge otherwise drops inline `ImageContent`.
- Claude: add the returned `context_id` to the `project.select` success object, keeping the selected project and working-directory details. The field must be visible in normal `content` as well as `structuredContent`; it must not be hidden in result `_meta`, which is not a reliable model-visible channel.
- Other Claude tool results initially use the existing MCP `structuredContent` and text/image `content` exactly as implemented. Add or adapt Claude-only `outputSchema` only when the concrete result shape is validated and the Claude connector's handling is observed. Never declare an `outputSchema` contradicted by real successful results.
- A Claude-specific presentation exception must be owned by a small response adapter; do not duplicate tool execution or transform all result bodies without evidence.
- `tool.schema` must describe the effective authenticated profile while the existing ChatGPT tool schema snapshot remains byte-for-byte identical.

The tools exposed through `tools/list` are not the only defense: the dispatcher must reject profile-incompatible tool names, missing context IDs and unauthorized access even if the client calls `tools/call` directly.

## Source ownership and changes required

- `cloudflare-access.ts` and HTTP authentication in `server.ts`: return and attach the verified user identity and client profile.
- `tool-definitions.ts`: keep the existing ChatGPT surface as the unmodified base; derive the Claude tool surface and its usage instructions.
- `input-validation.ts`: compile/cache input validators by **profile plus tool name**, not only tool name. Validate the actual authenticated profile; nested `workspace.batch` validation uses the already-resolved batch scope.
- `server.ts`: select per-request descriptors, profile-specific MCP server instructions, context resolution, tool authorization and dispatcher checks before side effects.
- `project-select.ts`, `project-current.ts` and `context-store.ts`: issue/resume/validate opaque Claude contexts and persist selected project and directory safely.
- `browser/profile-manager.ts`: accept authenticated Claude internal context keys while preserving per-profile ownership checks.
- Other resource/job handlers: verify or explicitly prohibit any path that could still read or write through shared `default` or use a raw cross-context resource identifier.

The existing HTTP stateless transport is retained. This work does not require introducing MCP transport sessions, a database service, an additional tunnel, or a second tool implementation.

## Verification requirements before rollout

1. **Exact ChatGPT regression:** compare all tool descriptors (including names, descriptions, annotations, `inputSchema`, `outputSchema`, `_meta`) with the pre-change snapshot. Compare representative structured and image-bearing results; confirm ChatGPT Android and Web, Scheduled Task scope behavior, image transfer and resource-link behavior.
2. **Authenticated discovery:** send authenticated `tools/list` through each existing tunnel; only Claude receives the new context properties and excludes ChatGPT-only tools. Verify the `tool.schema` result matches the same profile.
3. **Schema enforcement:** test both validators on the same tool name, including missing `context_id`, required fields, unknown profiles, and the outer `workspace.batch` scope.
4. **Claude lifecycle:** use a new Claude.ai chat to select a project and call two tools with the same handle. Open another chat and create another handle. Confirm different projects and working directories do not leak, and that an explicit old handle can resume its context.
5. **Authentication:** reject invalid Access JWTs and missing principals, unauthorized use of another user's context, non-Claude use of a Claude handle, and direct calls to hidden tools. Ensure raw handles, JWTs and identity data are not recorded.
6. **Browser and async work:** verify separate context-owned profiles, stop/resume, cross-context profile access rejection, and job/approval ownership. Test actual Claude `image.read` image delivery; keep unsupported resource flows hidden until verified.
7. **Deployment:** after implementation, restart only the affected MCP server while retaining ChatGPT Personal/Business and Cloudflare Tunnel configuration. Read back both authenticated tool profiles and the resulting schema. The ChatGPT connector must not require an actions refresh unless its own published schema actually changed.

## Boundaries and residual uncertainty

MCP tool input/output compatibility does not imply that Claude.ai always carries `context_id` correctly. Its reliability must be measured through real multi-step and cross-chat operations, especially after long conversations and context compaction.

The server can guarantee that missing/invalid handles do not silently acquire another context. It **cannot guarantee that two Claude chats belonging to the same authenticated user will never reuse the same valid handle**, because the upstream client provides no trusted conversation identity.
