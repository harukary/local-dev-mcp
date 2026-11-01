# ChatGPT Business Workspace MCP action refresh

This procedure applies to the existing, workspace-published `local-dev` and `local-dev-mini` Apps. The UI and end-to-end behavior below were directly checked on 2026-11-01. Current UI paths are operational observations, not a stable API contract.

## Four independently cached layers

```text
repository source
  -> running MCP runtime
    -> Business Workspace App action snapshot
      -> conversation / Branch tool binding
```

Each layer can be stale even when the previous layer is current. A Git Push, runtime restart, successful Tunnel connection, or Plugin package update does **not** refresh the published action snapshot. Refreshing actions does **not** hot-swap tool definitions in an existing conversation.

Published custom MCP Apps in this Business workspace support refreshing the existing connection's tools in place. Do not recreate the App or create a duplicate user-scoped connection merely because a tool description or input schema changed.

## Refresh procedure

1. Inspect the repository HEAD, dirty files and upstream before changing code. Preserve unrelated worktrees and uncommitted changes.
2. Build and deploy the runtime through the normal LaunchAgent path. Confirm the MCP `/healthz`, Business Secure MCP Tunnel, and the exact changed input/description with `tool.schema`.
3. In an authenticated ChatGPT Web session, open **Settings → Plugins → Installed → the existing App → Manage**. The current App settings page has a **Refresh tools** button under **Manage app**.
4. Refresh tools on the **existing** App. Check that the operation succeeded. A successful request alone is insufficient to establish that the expected schema was published.
5. Read the App's **current connector action definitions** back through the authenticated ChatGPT app-management client. Check the affected tool name, input property, description, and tool count against the running MCP. The settings screen need not display the full action list. Discover the read-back mechanism from the current client; do not encode internal endpoint names, connector link identifiers, or authentication details into permanent instructions.
6. Create a **Branch or completely new chat** after the action refresh. Test the newly bound tool through a harmless real call that uses the changed input property. Reading the runtime's `tool.schema` alone is **not** verification of the model-facing binding.
7. Preserve existing Workspace settings such as enabled tools and approval policy. Do not use a Plugin package upload or version change as a substitute for action Refresh.

If the Refresh button is absent, check the existing App's action definitions and the current app-management client before concluding that Refresh is unavailable. A route or layout change is not proof that the capability has been removed.

## Verified action and binding state

On 2026-11-01, both runtime servers already exposed `browser.open.http_credentials` in their input schema, but the conversation that initiated the investigation still exposed the previous `browser.open` binding.

- `local-dev`: The existing App's **Refresh tools** operation succeeded. Its connector actions were read back as 82 tools, including the updated `browser.open` description and `http_credentials` input.
- `local-dev-mini`: Before Refresh, its 82 published connector actions used the old `browser.open` description and had no `http_credentials`. After Refresh, read-back showed 82 actions with the updated description and input.
- A completely new ChatGPT Web chat then invoked **both** `browser.open` tools with `http_credentials` containing only dummy test strings and `url=https://example.com/`. Both tool calls returned `ok: true` and `action_applied: true`. This validates new-conversation argument binding, **not** successful HTTP Basic authentication against a protected site.
- The original conversation remains a separate cached binding and should not be assumed to have changed.

The `/link` metadata for an App may list enabled action names without containing full tool parameter schemas. Its lack of a parameter string alone is **not** evidence that the connector's current action definitions are stale.

## Diagnosing a mismatch

| Source/runtime | Workspace actions | New conversation | Interpretation |
| --- | --- | --- | --- |
| Stale runtime | Any | Any | Deploy or restart the MCP runtime first |
| Current | Stale | Stale | Refresh the existing App's tools and read back its action definitions |
| Current | Current | Stale | Use a fresh Branch/new chat and verify its binding |
| Current | Current | Current | The change is reflected end-to-end |

Keep Tunnel tokens, session cookies, connector credentials, HTTP Basic passwords, and raw browser authentication state out of tool results, logs, and documentation. Do not manually recreate or delete a working App without a demonstrated need and a verified replacement.
