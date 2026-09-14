# ChatGPT USER Plugin / MCP schema refresh behavior

Last verified: 2026-09-14

This note documents the schema-refresh behavior we rely on when developing `local-dev-mcp` as a **USER-scoped ChatGPT Developer Mode Plugin**.

The important distinction is that some behavior below is documented by OpenAI, while some is only observed in the current ChatGPT product. Treat the observed behavior as an operational workaround, not a stable public API contract.

## Scope

This note is specifically about the USER-scoped `local-dev` Plugin used from ChatGPT Developer Mode.

It is **not** describing the lifecycle of a Business app that has been published to a workspace. Workspace-published apps have separate approval/snapshot rules and should not be used to infer USER Plugin behavior.

## What OpenAI documents

OpenAI currently documents the following relevant behavior:

- Developer Mode apps can be tested by opening a new chat and selecting the app.
- Apps are selected for a message rather than permanently for the whole conversation; the app can be selected or mentioned again in a follow-up when another app action is needed.
- A Refresh action can retrieve newly available actions and updated action definitions in the relevant app-management flows.

Official reference:

- https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta
- https://help.openai.com/ja-jp/articles/12584461-chatgpt-%E3%81%AE%E9%96%8B%E7%99%BA%E8%80%85%E3%83%A2%E3%83%BC%E3%83%89%E3%81%A8-mcp-%E3%82%A2%E3%83%97%E3%83%AA%E3%83%99%E3%83%BC%E3%82%BF%E7%89%88

The documentation does **not** currently spell out the lifetime of the model-facing tool schema inside an already-running conversation, nor does it document Branch chat as a schema-refresh mechanism.

## Observed ChatGPT behavior

The following behavior was observed while developing `local-dev-mcp` on 2026-09-14.

### 1. Refresh can update the Plugin's discovered actions without updating every existing conversation branch

After the MCP server exposes a changed input schema, ChatGPT's Plugin settings can show the updated action definition after Refresh while an existing conversation branch may still expose an older model-facing tool schema.

This means there are at least two conceptually separate states:

1. the Plugin/action snapshot known by ChatGPT, and
2. the tool definitions bound into a particular conversation branch.

Do not assume that seeing the new schema in Plugin settings proves that the current conversation branch is using it.

### 2. Branch chat rebinds the Plugin schema

Operationally, creating a **Branch chat** after Refresh causes the new branch to resolve the Plugin tools again and pick up the refreshed schema.

This is useful because it preserves the conversation up to the branch point while avoiding the stale tool binding of the original branch.

As of 2026-09-14 this behavior is not sufficiently documented by OpenAI, so treat it as a practical workaround rather than a guaranteed product contract.

### 3. A new chat is also a reliable clean rebind

Opening a new chat and selecting `local-dev` gives ChatGPT a fresh opportunity to load the current Plugin schema. This matches OpenAI's documented testing flow and is the safest fallback when Branch chat behavior is uncertain.

### 4. Refresh cannot expose source code that the MCP runtime has not loaded

There are three distinct layers:

```text
repository source
    -> running local-dev-mcp process
        -> ChatGPT Plugin discovery / Refresh
            -> conversation-branch tool binding
```

If the source says schema `B` but the running MCP process still serves schema `A`, pressing Refresh can only discover `A`.

For schema changes, first make sure the MCP runtime itself has restarted or otherwise loaded the new code.

### 5. `tools/list_changed` is not enough to rely on for an existing ChatGPT branch

MCP supports notifying a client that its tool list changed. In practice, this should not be treated as a guarantee that ChatGPT will hot-swap the already-bound model tool definitions in the current conversation branch.

`local-dev-mcp` may still emit normal MCP tool-list change notifications, but our operational workflow should not depend on those notifications refreshing an existing branch.

## Recommended schema-change workflow

For any change to tool names, descriptions, annotations, or input schemas:

1. Implement and test the change locally.
2. Increment `schema_version` when the externally visible tool contract changed.
3. Restart/reload `local-dev-mcp` so the running process serves the new schema.
4. Verify the runtime directly with `tool.schema` and confirm the expected `schema_version` and fields.
5. In ChatGPT, open Plugin settings for `local-dev` and press **Refresh**.
6. Create a **Branch chat** from the conversation where you want to continue working.
7. If there is any doubt, use a completely new chat instead.
8. Verify the model-facing schema before doing destructive work.

For normal implementation changes that do not affect the external tool contract, steps 2 and 5-8 are usually unnecessary.

## How to verify which layer is stale

Use the following checks in order.

| Check | What it proves |
| --- | --- |
| Repository source | What the next runtime should expose |
| `tool.schema` response | What the currently running MCP process exposes |
| Plugin Settings -> Actions after Refresh | What ChatGPT discovery currently knows |
| Tool definition visible to the model in the active branch | What the current conversation can actually call |

A useful harmless probe is to ask the model to list the exact input argument names it sees for a known tool, without executing it. For example, after adding `output` and `max_bytes` to `shell.status`, ask for the argument names of `shell.status` in the current turn.

Do not use `tool.schema` alone to prove that the active conversation binding is current: `tool.schema` is itself a call to the server and reports the server's runtime contract, not necessarily the wrapper already supplied to the model for the current branch.

## Troubleshooting matrix

| Runtime `tool.schema` | Plugin Settings after Refresh | Active branch | Likely cause | Action |
| --- | --- | --- | --- | --- |
| old | old | old | MCP process still runs old code | Restart/reload MCP first |
| new | old | old | ChatGPT Plugin discovery is stale | Press Refresh |
| new | new | old | Conversation branch has stale binding | Branch chat; otherwise start a new chat |
| new | new | new | Fully updated | Continue |

## Why we record this locally

This behavior affects development productivity and can otherwise look like an MCP implementation bug: a schema can be correct in source and at runtime yet appear missing to the model.

Until OpenAI documents the conversation/branch binding lifecycle more explicitly, keep this file updated when observed behavior changes. Record dates and distinguish:

- documented product behavior,
- directly observed behavior,
- hypotheses that still need verification.
