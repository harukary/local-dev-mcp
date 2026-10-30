# ChatGPT Business Workspace App / MCP schema refresh behavior

Official documentation verified: 2026-10-30. Workspace snapshot workflow last directly verified: 2026-10-02.

This note records how we currently update the **workspace-published `local-dev` / MCP app in the harukary Business workspace** when the MCP tool surface changes.

The current OpenAI Help Center and the previously observed workspace refresh flow agree that **Business admins can refresh the tools of an existing published custom MCP connection without recreating the app**. The UI location and per-workspace permissions can still differ. Treat the local verification history below as workspace-specific evidence rather than proof that a particular snapshot is current now.

## Current official documentation and observed behavior

OpenAI's Help Center, checked on 2026-10-30, documents in-place refresh for Business and Enterprise/Edu admins with a valid connection and permission to manage the app. Published connections use a frozen tool/input snapshot; later server changes are **not** applied automatically. An updated optional input may remain backward-compatible, but the new field is not considered published until the action snapshot has been refreshed and read back.

Official references:

- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://help.openai.com/en/articles/11509118-admin-controls-security-and-compliance-for-plugins-and-apps

We directly observed the following in the harukary Business workspace on 2026-09-20 and re-verified the mechanism on 2026-09-25:

1. A published workspace app still had an existing connector link and action snapshot.
2. ChatGPT's own Admin Apps client exposed and successfully executed its action refresh flow for that existing app.
3. The action snapshot changed from the old tool set to the new MCP tool set without recreating the app.
4. A Branch chat created after the refresh loaded the refreshed tool schema.
5. On 2026-09-25, the newer `Admin -> Plugins` UI no longer exposed an obvious Refresh control for `local-dev`, while the current ChatGPT frontend still contained the existing-app action refresh flow.
6. Executing that current refresh flow updated the existing `local-dev` action snapshot in place from the old `artifact.read` 8 MiB description to the new 6 MiB description.
7. A Branch chat created after that refresh exposed the 6 MiB tool schema and runtime schema version `2026-09-25.1`.
8. Uploading the same Plugin package as version `1.0.1` did **not** refresh the MCP action snapshot: the package version changed while the old 8 MiB action description remained until actions were refreshed separately.
9. On 2026-10-02, after `project.select` changed to return composed global + project/worktree agent instructions, the runtime was activated with schema version `2026-10-02.3`, the existing workspace app action snapshot was refreshed in place, and the updated `project.select` description was read back from the workspace connector configuration.
10. A Branch chat created after that refresh returned both instruction sources from `project.select` (`$CODEX_HOME/AGENTS.md` followed by the project `AGENTS.md`) and included the newly published global instructions, confirming that the branch had rebound to the refreshed action/runtime behavior.

Concrete verification from the `sodateai` app:

- before refresh: `report.search`, `report.get`, `report.create`, `report.delete`
- after refresh: `page.search`, `page.get`, `page.create`, `page.update`, `page.revisions`, `page.restore`, `page.delete`
- a Branch chat then exposed `page.*` and no longer exposed `report.*`

Therefore, **do not recreate the workspace app by default just because tool names, descriptions, annotations, or input schemas changed**.

## Preferred workflow for this workspace

For an externally visible MCP tool-surface change:

1. Implement and test the MCP change.
2. Increment the tool/schema version when the public contract changed.
3. Restart or reload the MCP runtime so the running server actually serves the new schema.
4. Verify the runtime directly, for example with `tool.schema`, `tools/list`, or another harmless schema probe.
5. Confirm the Business Secure MCP Tunnel is healthy.
6. In ChatGPT Workspace settings, locate the **existing** app.
7. Refresh that app's actions in place. Prefer a visible Refresh control when present. If the newer Plugin UI hides it, inspect the current ChatGPT app-management client flow rather than substituting a package-version upload or recreating the app.
8. Read back the app's action list and verify the expected tools/inputs/descriptions are present and the removed or old values are gone.
9. Create a **Branch chat** or a completely new chat so the conversation gets a fresh model-facing tool binding.
10. Verify the exact tool names/input fields visible in that branch before destructive work. For `project.select`, also perform a harmless call and confirm its returned `agent_instructions.sources` and effective instruction content when agent-instruction behavior changed.

The expected state flow is:

```text
repository source
    -> running MCP runtime
        -> workspace app action snapshot
            -> conversation / branch tool binding
```

Each layer can be stale independently.

## When recreation is appropriate

Recreate and republish the app only when one of these is true:

- the existing app or connector link no longer exists,
- the Tunnel association itself must change and cannot be edited safely,
- the authentication model or app identity must change,
- after checking the current ChatGPT app-management client, no usable action-refresh flow remains,
- refresh fails or the read-back still shows the old snapshot,
- a current, verified product limitation prevents an in-place update for this workspace.

If recreation is required, preserve the existing app until the replacement has been verified. Avoid deleting the working app first.

## Branch and chat cache behavior

Refreshing the workspace app does not imply that an already-running conversation will hot-swap its model-facing tool definitions.

Observed behavior:

- the app action snapshot can be new while the current conversation still sees the old tools,
- creating a Branch chat after refresh can rebind the app schema,
- a completely new chat is the clean fallback.

So the acceptance check is not only “the app page shows the new actions”. The final check is that the **new branch/chat actually exposes the expected tools**.

## Troubleshooting matrix

| Runtime schema | Workspace app actions | New Branch chat | Likely cause | Action |
| --- | --- | --- | --- | --- |
| old | old | old | Runtime still serves old code | Restart/reload MCP |
| new | old | old | Workspace app snapshot is stale | Refresh actions in place |
| new | new | old | Conversation binding is stale | Branch again or start a new chat |
| new | new | new | Fully updated | Continue |
| new | no usable refresh flow after current-client check | old | Product/workspace no longer permits in-place update | Recreate and republish per current OpenAI guidance |

## Automation notes

When automating with `local-dev` browser/computer tools:

- prefer the existing app's normal Workspace settings UI when it exposes Refresh,
- if the current Plugin UI hides Refresh, rediscover the action-refresh path from the current ChatGPT app-management client instead of hard-coding an old endpoint or link ID,
- use the existing app's action-refresh path rather than creating a duplicate USER/Workspace app pair,
- do not treat `Upload new version` as an action refresh; package version and MCP action snapshot are separate layers,
- never log or expose Tunnel tokens, session cookies, or connector credentials,
- always read back the refreshed action list,
- always verify again from a fresh Branch/new chat.

Do not depend on undocumented internal endpoint names as a durable contract. The observed in-place refresh is the operational behavior that matters; UI/client internals may change.

## Relationship to USER-scoped Developer Mode Plugins

This file is specifically about the workspace-published Business app path observed above.

For USER-scoped Developer Mode Plugin behavior, see:

- [chatgpt-user-plugin-schema-refresh.md](./chatgpt-user-plugin-schema-refresh.md)
