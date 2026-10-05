# Repository actions

`repo.action.*` is an opt-in typed execution surface for repository-owned local operations that would otherwise require `shell.run`.

The goal is not to hide command names. The goal is to expose a closed-world MCP contract for known operations while keeping `shell.run` available as the fallback for unknown or ad-hoc work.

## Manifest

A repository opts in by adding:

```text
.local-dev/actions.json
```

The current manifest version is `1`.

Example:

```json
{
  "version": 1,
  "actions": {
    "run.record": {
      "mode": "write",
      "description": "Record a completed run in the local operational ledger.",
      "executable": "pnpm",
      "argv": [
        "world-model:tasks:record-run",
        "--",
        "--domain",
        { "param": "domain" },
        "--metrics-json",
        { "param": "metrics", "encoding": "json" }
      ],
      "input_schema": {
        "type": "object",
        "properties": {
          "domain": { "type": "string" },
          "metrics": { "type": "object" }
        },
        "required": ["domain", "metrics"],
        "additionalProperties": false
      },
      "timeout_seconds": 60
    }
  }
}
```

`argv` accepts fixed string tokens and structured parameter references. Parameter values are shell-quoted by local-dev-mcp; repositories do not accept arbitrary command text from the model through this surface. Use `encoding: "json"` when an object or array must be passed as one JSON argument.

## Tools

- `repo.action.list` reads the manifest and returns action IDs, mode, description, input schema, timeout, and catalog hash. It does not execute shell discovery.
- `repo.action.read` executes only actions declared with `mode: "read"`.
- `repo.action.write` executes only actions declared with `mode: "write"` and currently requires the project `write_policy` to be `allow`.

All three tools support explicit `project_id` / `working_dir` scope, so Scheduled Tasks can remain stateless.

## Initial safety boundary

The first version is intentionally narrow:

- arbitrary shell text is never an MCP input to `repo.action.read/write`
- actions are repository-owned and identified by a stable action ID
- structured inputs are validated against the action's `input_schema`
- `network: true` actions are rejected; external or credential-backed operations continue to use their existing repository contract for now
- catastrophic, forbidden, or mode-inconsistent resolved commands are rejected
- `repo.action.write` requires `write_policy=allow`
- `shell.run` remains available for unsupported operations

Internally the action is still executed by the existing sandbox/process runner. The difference is the model-facing capability boundary: executable and argv structure come from trusted repository configuration rather than from an arbitrary shell command supplied by the model.

## Rollback

This feature is opt-in. Removing a repository's `.local-dev/actions.json` returns that repository to the previous behavior immediately. Reverting the local-dev-mcp implementation removes the `repo.action.*` tools without changing `shell.run` or other typed tools.
