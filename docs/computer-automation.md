# macOS Computer Use

`computer.*` is an optional macOS window and app automation capability powered by the external [Cua Driver](https://cua.ai/driver) CLI. No additional MCP server is installed, and local-dev-mcp has no dependency on haruclaw.

Prefer `browser.*` for ordinary web DOM operations and `mobile.*` for phones. Use Computer only for native apps, OS dialogs, and already signed-in normal Chrome windows. Computer and Browser have different profiles and state.

## Setup

Computer defaults to ON. To hide its tools and skip its optional dependency, use `pnpm setup --yes --disable computer`.

For Computer use, install the stable Cua Driver CLI on the macOS host after inspecting its official installer.

```bash
curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-driver-install.sh
# Review the downloaded script first
bash /tmp/cua-driver-install.sh --no-connect --no-test --no-modify-path
cua-driver --version
```

`--no-connect` prevents Cua Driver from automatically installing MCP registrations or Skills into other agents. This integration calls the CLI directly. Grant required macOS permissions locally:

```bash
cua-driver permissions grant
cua-driver permissions status --json
open -n -g -a CuaDriver --args serve
cua-driver status
```

If `permissions status` returns `source.attribution:"caller"`, those permissions describe the calling process, **not necessarily the CuaDriver daemon**. Verify the driver's daemon-attributed permissions when running. To use a nonstandard installation path, set the server's `LOCAL_DEV_MCP_COMPUTER_DRIVER` to an absolute executable path.

## Workflow

1. Check installation and permissions with `computer.status`.
2. Identify a real `pid` and `window_id` with `computer.list_windows`.
3. Use `computer.get_window_state` for an image and accessibility tree, or `computer.screenshot` for the image alone.
4. Perform one action and reacquire the state before further actions.

Cua Driver identifies an accessibility element by **`element_token`**, not a standalone `element_index`. Compose the token as `<snapshot_id>:<row>` from `get_window_state`'s `snapshot_id` and numbered tree rows `[N]`. A new tree snapshot invalidates old element tokens.

local-dev-mcp uses a distinct public Cua Driver `session` label per authenticated conversation, and consistently passes it for observation and actions. The session label itself is not an authentication credential.

Coordinate actions use the **pixel position within the captured window image**, not global macOS screen coordinates. Cua Driver performs the Retina scale / logical-point conversion; do not manually convert pixels.

Mutations default to **background delivery** without stealing focus. Only use `delivery_mode=foreground` after observing that background delivery did not take effect. Use `computer.activate_window` only when foreground activation is explicitly necessary.

## Safety

- Requires an authenticated interactive context and a registered project. Mutations require the selected project's `write_policy=allow`.
- Desktop access applies to the **whole Mac**; the selected project's file root is not a desktop sandbox.
- The server verifies `pid`/`window_id` for each action and requires a capture no more than five minutes old in the same work context.
- Element tokens become invalid after an action, and the agent must reacquire window state before another mutation.
- Driver `effect:"unverifiable"` is not proof of success; inspect the screen before retrying uncertain operations.
- A locked or sleeping Mac may still yield screenshots, but the driver reports `degraded:true`. The wrapper rejects input until the Mac is unlocked.
- Never type passwords, one-time codes, recovery codes, or API keys using Computer tools. Minimize screenshots of sensitive views.
- Screenshots are stored mode 0600 inside the selected project's `generated/local-dev-mcp/computer/` and returned via `image.read`. User-visible file delivery uses `artifact.link` separately.
