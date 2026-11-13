# Repository actions

`repo.action.*` is the closed-world interface for repository-declared commands. The repository supplies the executable and fixed argument positions in `.local-dev/actions.json`; the caller supplies an action ID and schema-validated values. Execution uses direct argv (`shell=false`), never model-authored shell text. Repository Actions are optional; `pnpm run setup --yes --disable repo-actions` hides them.

## Manifest and calls

The manifest has `version: 1` and an `actions` object. Each action defines `mode`, `executable`, fixed `argv` (with optional `{ "param": "name" }` references), a validated `input_schema`, and optional `timeout_seconds`.

- `repo.action.list(project_id=...)` returns the available IDs, argument schemas, flags, and catalog hash without execution.
- `repo.action.read(project_id=..., action=..., args=...)` runs a declared read action.
- `repo.action.write(project_id=..., action=..., args=...)` runs an allowed write action or a verified deployment; the project requires `write_policy=allow`.
- Scheduled Tasks must specify `project_id` (and `working_dir` if used) on every call.

## Host-pinned credentialed reads

An audited, fixed, read-only repository probe that needs remote credentials can opt into `operation: "credentialed_read"`. It must declare `mode: "read"`, `network: true`, `credential_scope: "bitwarden"`, and a closed `input_schema` (`additionalProperties: false`). The project must have `network_policy=allow`.

Example repository manifest entry:

```json
"signal.inspect": {
  "mode": "read",
  "operation": "credentialed_read",
  "network": true,
  "credential_scope": "bitwarden",
  "executable": "node",
  "argv": ["scripts/world-model/production-signal-operation.mjs", "probe", "--signal-id", {"param":"signal_id"}],
  "input_schema": {
    "type": "object",
    "properties": {"signal_id":{"type":"integer","minimum":1}},
    "required": ["signal_id"],
    "additionalProperties": false
  },
  "timeout_seconds": 120
}
```

**The repository declaration alone grants no credentials.** The host operator must independently pin the exact manifest entry in the host-only project configuration (`config/projects.local.yaml`, not committed):

```yaml
projects:
  recipie:
    credentialed_read_actions:
      signal.inspect: <sha256-of-manifest-action-json>
```

Compute the SHA-256 of `JSON.stringify(actions["signal.inspect"])` from the manifest using a trusted local tool, then review the executable, referenced script, arguments, schema, and remote read-only behavior before pinning. Any manifest change invalidates the pin and fails closed until explicitly reapproved. The action is **code executed with the token**: pinning a script requires trusting its implementation and imports, not merely its manifest name. Keep that script reviewed and control its changes accordingly. The host-owned allowlist is not a secret but must remain outside the source-controlled project.

The host resolves the existing Bitwarden Keychain token only after confirming the pin, read mode, network policy, safe argv shape, and validated arguments. It injects credentials into the one subprocess, redacts known secret values from returned output, and audits the execution. It never logs the token. If credentials are missing or the manifest has changed, execution is refused. Generic networked read actions and arbitrary credential-bearing `shell.run` remain unchanged; this does not bypass the latter's approval policy. This operation cannot invoke the Queue or mutate Production under its approved repository contract.

## Verified production deployment

Deployment remains a distinct operation: `mode: "write"`, `operation: "deployment"`, `network: true`, and `credential_scope: "bitwarden"`. It requires `network_policy=allow`, `write_policy=allow`, a fixed argv with exactly one dynamic `expected_head` parameter, and a checked-out Git branch with a clean tracked worktree whose exact HEAD matches the live upstream remote. Credentials are resolved only after these checks. A successful CLI result is not a substitute for independent deployed-version read-back.

## Safety

- Shell/eval executables, interpreter eval flags, generic dispatchers, dynamic package-manager executable selection, catastrophic commands, and forbidden paths are rejected.
- Ordinary read/write actions remain local-only. An unapproved network action is rejected.
- The host-pinned credentialed-read exception is explicitly scoped to one reviewed action definition; it does not make arbitrary Node/shell scripts read-only.
- The existing deployment contract, shell command approval rules, and project policies remain unchanged.
- Use typed `git.status`, `git.commit`, and `git.push` for verified Git changes, and keep Production data mutations on each repository's guarded writer/Queue path.
