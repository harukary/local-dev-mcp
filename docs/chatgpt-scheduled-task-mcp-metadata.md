# ChatGPT Scheduled Task / MCP metadata observations

Last verified: 2026-09-18

This note records ChatGPT behavior observed while running `local-dev-mcp` as a Workspace-published Plugin over OpenAI Secure MCP Tunnel.

Some details below are documented by OpenAI, while the Scheduled Task request shape is only an observed product behavior. Treat the observed shape as an operational compatibility rule, not as a stable public API contract.

## Scope

The observations in this file apply to the Workspace-published `local-dev` Plugin path that was tested on 2026-09-17.

Do not generalize these observations to:

- USER-scoped Developer Mode Plugins,
- Personal workspaces,
- other ChatGPT clients or rollout cohorts,
- OAuth-authenticated MCP servers,
- future Scheduled Task implementations.

## What OpenAI documents

OpenAI's Scheduled Tasks documentation states that Scheduled Tasks can run in the background and can use connected tools, skills, and plugins. It also distinguishes independent Scheduled Tasks from tasks attached to an existing chat.

Official reference:

- https://learn.chatgpt.com/ja-JP/docs/automations

The Plugin reference documents these client-provided MCP `_meta` fields:

- `openai/locale`
- `openai/userAgent`
- `openai/userLocation`
- `openai/subject`
- `openai/session`
- `openai/organization`

It describes `openai/subject` as an anonymized user identifier, `openai/session` as an anonymized conversation identifier, and `openai/organization` as an anonymized organization identifier when available.

The same reference explicitly says that `openai/userAgent` and `openai/userLocation` are hints only and must not be relied on for authorization decisions.

Official reference:

- https://developers.openai.com/plugins/reference

As of 2026-09-17, these official pages do not document a Scheduled-Task-specific MCP marker such as a task id, automation id, `scheduled=true`, or a dedicated authenticated principal for Scheduled Task tool calls. They also do not document whether `openai/subject`, `openai/session`, or `openai/organization` are present or absent during Scheduled Task executions.

## Observed request shapes

### Normal interactive Workspace call

A normal interactive `local-dev` tool call from the tested ChatGPT Workspace conversation included this exact `_meta` key set:

```text
openai/locale
openai/organization
openai/session
openai/subject
openai/userAgent
openai/userLocation
timezone
```

The server used `openai/subject` for the owner allowlist and `openai/session` for the per-chat context id.

### Scheduled Task call

A real Scheduled Task call to the same Workspace-published `local-dev` Plugin included this exact `_meta` key set:

```text
openai/locale
openai/userAgent
openai/userLocation
timezone
```

The following fields were absent:

```text
openai/subject
openai/session
openai/organization
```

The standalone top-level `timezone` key was also observed in both request shapes. The Plugin reference documents `timezone` as a possible property of `openai/userLocation`, but the standalone top-level `timezone` key is not described in the `_meta` table cited above.

A controlled Scheduled Task probe successfully used this four-key shape. After the compatibility change was deployed, a recurring real-world Scheduled Task also completed a normal multi-tool `local-dev` workflow without being rejected by subject authorization.

At the 2026-09-17 verification point, the privacy-safe audit log contained accepted `scheduled_task_meta` events across project selection, workspace reads and writes, git inspection, and shell execution. All accepted events had the same four-key metadata set shown above. This establishes that the observed shape was not limited to a single probe tool.

## What this does and does not prove

The observed four-key shape is useful for compatibility detection, but it is not cryptographic proof that a request came from a Scheduled Task.

In particular:

- `openai/userAgent` and `openai/userLocation` are explicitly documented as non-authorization hints.
- Absence of `openai/subject`, `openai/session`, and `openai/organization` does not by itself identify the caller.
- No documented task id or authenticated Scheduled Task principal was available in the tested request.
- Another future ChatGPT execution mode could theoretically produce the same key set.

Therefore the local implementation must not broaden the rule to "allow any request with no subject/session".

## Current local-dev-mcp compatibility rule

Subject enforcement is an optional defense-in-depth layer. Without subject configuration, `local-dev-mcp` relies on the required Secure MCP Tunnel token. When subject enforcement is enabled, authorization resolves in this order:

1. If the configured owner `openai/subject` matches, allow with `owner_subject`.
2. Otherwise, if the `_meta` key set exactly matches the four-key Scheduled Task shape observed above, allow with `scheduled_task_meta`.
3. Otherwise, reject.

The Scheduled Task exception matches key names only. It does not log or compare the values of locale, user agent, location, or timezone.

This exact-key exception still depends on the presence of `openai/userAgent` and `openai/userLocation`, even though OpenAI documents those fields as optional hints that must not be used as authorization signals. That makes this a deliberately narrow, fail-closed compatibility workaround rather than a portable authentication mechanism: if ChatGPT stops sending either hint, the request should be rejected and re-observed instead of silently broadening the rule.

Relevant implementation:

- `src/mcp/server.ts`: `SCHEDULED_TASK_META_KEYS`, `isObservedScheduledTaskMeta`, `resolveOpenAiAuthorization`
- `src/types.ts`: `openAiAuthorizationBasis`, `requestMetaKeys`, `requestMetaUnknownKeyCount`

## Scheduled Task project context is stateless

A second operational consequence of the observed request shape is that Scheduled Task calls do not carry `openai/session`. The current stateless HTTP transport also does not receive a usable `mcp-session-id` on these calls. There is therefore no observed stable task or conversation identifier that can safely key mutable project selection state across Scheduled Task tool calls.

Before 2026-09-18, calls without `openai/session` or `openai/subject` fell back to the shared context id `default`. Audit review showed unrelated Scheduled Tasks repeatedly overwriting that shared project's selection. A `project.select` followed by another tool call could therefore run against a project selected by a different Scheduled Task.

The 2026-09-18 execution rule is:

- interactive calls keep the existing persistent per-chat project selection,
- calls matching the observed Scheduled Task metadata shape execute in an isolated request-local context,
- `project.select` returns `STATELESS_PROJECT_CONTEXT` for those calls instead of pretending the selection can persist,
- project-scoped tools accept `project_id` and optional `working_dir` directly,
- Scheduled Task project-scoped calls without `project_id` return `PROJECT_SCOPE_REQUIRED`,
- request-local contexts are isolated with `AsyncLocalStorage` and are never written to the persisted chat-context store.

This is intentionally stateless. Do not derive a synthetic task identity from locale, user-agent, location, timezone, request timing, or another hint. Those values are not stable authenticated task identifiers.

Relevant implementation:

- `src/project/context-store.ts`: request-local context isolation
- `src/mcp/server.ts`: `resolveRequestContextId`, explicit project scope resolution, Scheduled Task guards
- `src/mcp/tool-definitions.ts`: project-scoped `project_id` / `working_dir` inputs

## Audit and privacy rules

Authorization audit entries record only privacy-safe metadata needed to diagnose compatibility:

- whether a subject was present,
- the one-way subject hash when present,
- authorization result,
- authorization basis,
- sanitized request metadata key names,
- count of metadata keys whose names were not safe to log.

Do not persist raw `openai/subject` values or `_meta` values.

For a Scheduled Task accepted through the observed compatibility path, the expected audit shape is conceptually:

```text
openAiSubjectPresent: false
openAiSubjectAuthorized: true
openAiAuthorizationBasis: scheduled_task_meta
requestMetaKeys:
  - openai/locale
  - openai/userAgent
  - openai/userLocation
  - timezone
```

## Operational troubleshooting

If a Scheduled Task starts failing with:

```text
Forbidden: this ChatGPT user is not authorized to use local-dev.
```

check the `openai_subject_authorization` audit entry before changing the authorization rule.

Compare only the recorded metadata key names against this document. Do not enable raw request-body logging just to inspect metadata values.

If OpenAI changes the Scheduled Task request shape:

1. confirm the change with a harmless real Scheduled Task probe,
2. compare it with a normal interactive call,
3. update this document with the observation date and scope,
4. update the exact-match compatibility rule only after the new shape is confirmed,
5. keep unknown anonymous request shapes fail-closed.

If OpenAI later documents a dedicated authenticated Scheduled Task identity or another stronger principal, prefer that mechanism over this observed key-set exception.

## Why this is documented locally

Without this note, a future absence of `openai/subject` can look like an MCP or Tunnel regression even when it is a ChatGPT Scheduled Task behavior difference.

Keep the distinction explicit between:

- official OpenAI documentation,
- directly observed ChatGPT request behavior,
- the local compatibility policy built on that observation.
