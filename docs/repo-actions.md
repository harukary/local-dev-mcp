# Repository actions

`repo.action.*` provides a closed-world interface for repository-owned commands. The repository declares executable and argument positions in `.local-dev/actions.json`; the model supplies only an action ID and schema-validated values, never arbitrary shell text. Commands use direct process execution (`shell=false`).

## Manifest and calls

The manifest has `version: 1` and an `actions` object. A typical local read/write action declares `mode`, `description`, `executable`, fixed `argv`, optional validated parameter references (`{ "param": "name" }`), `input_schema`, and `timeout_seconds`.

- `repo.action.list(project_id=...)` returns the repository's action catalog, input schemas, network classification, and catalog hash without executing actions.
- `repo.action.read(project_id=..., action=..., args=...)` runs local actions with `mode: "read"`.
- `repo.action.write(project_id=..., action=..., args=...)` runs local write actions, or an explicitly declared verified deployment action. Project `write_policy` must be `allow`.
- `working_dir` selects a real project-contained worktree. For Scheduled Tasks, include `project_id` and `working_dir` on each call instead of relying on `project.select`.

## Production deployment actions

External network actions are rejected by default. Deployment is the only supported credential-backed exception. It must be declared as `mode: "write"`, `operation: "deployment"`, `network: true`, and `credential_scope: "bitwarden"`; the project also needs `network_policy=allow` and `write_policy=allow`. Example:

```json
{
  "version": 1,
  "actions": {
    "pages.deploy": {
      "mode": "write",
      "operation": "deployment",
      "network": true,
      "credential_scope": "bitwarden",
      "description": "Deploy the already-verified pushed commit.",
      "executable": "pnpm",
      "argv": ["run", "deploy:pages", "--", "--expected-head", { "param": "expected_head" }],
      "input_schema": {
        "type": "object",
        "properties": { "expected_head": { "type": "string", "pattern": "^[0-9a-fA-F]{40}$" } },
        "required": ["expected_head"],
        "additionalProperties": false
      },
      "timeout_seconds": 240
    }
  }
}
```

The deployment executable is a repository-owned fixed command. The single permitted parameter reference in its argv is `expected_head`; the backend validates the exact 40-character commit SHA, a clean tracked Git worktree, checked-out branch, configured upstream, and live remote HEAD equality *before* reading Bitwarden credentials. This also works with clean project-contained Git worktrees and refuses dirty or behind/unpushed checkouts.

The Bitwarden access token is resolved from the existing macOS Keychain configuration and injected only into the action subprocess. The repo-specific wrapper resolves the Cloudflare deployment credentials in-process; neither the token nor the account secret belongs in the action arguments or manifest.

Use distinct preflight and production action IDs when the repository offers a dry-run/preflight mode. A production action must be called only after validation, successful commit/push, and an independent production read-back plan. If the action or credential gate fails, report the blocker; do not fall back to a generic credential-bearing `shell.run` in unattended tasks.

## Safety and scope

- Shell/eval executables, interpreter eval flags, generic dispatchers, `find -exec`, dynamic package-manager dispatch, catastrophic commands, and forbidden paths are rejected.
- Normal repository actions remain local-only. `network: true` without `operation: "deployment"` is rejected.
- The deployment operation is explicitly marked as an external write, never a read; other dynamic argv parameters are not allowed.
- Credentials are redacted from subprocess output and are not supplied to read actions.
- Removing `.local-dev/actions.json` disables the repository's declared actions. No per-project MCP tool or additional public ingress is required.

## Git and publishing

Use typed `git.status`, `git.commit`, and `git.push` to finalize verified tracked changes. Git push and Cloudflare deployment are distinct. The deployment command requires `HEAD == upstream remote HEAD`, and successful CLI execution still requires application-specific live URL read-back before reporting production completion.
