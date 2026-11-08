# Desktop Computer Use

`computer.*` controls an explicitly selected **macOS application window** using the [Cua Driver](https://github.com/trycua/cua) CLI. It does not use Playwright or the isolated `browser.*` Chrome profile. Use `browser.*` for ordinary web DOM workflows and `mobile.*` for phones/simulators; use `computer.*` only for native dialogs, desktop apps, or a logged-in regular Chrome window.

This capability is optional and defaults to ON. Use `pnpm setup --yes --disable computer` to hide its tools; Cua Driver is not required when OFF. See [Setup](setup.md).

## Host setup

On macOS, install the `cua-driver` CLI from its official distribution. It is an external dependency, not bundled into local-dev-mcp. When the executable is outside the default installation locations, set `LOCAL_DEV_MCP_COMPUTER_DRIVER` to an **absolute executable path** in the server environment.

Run these commands **locally on the Mac**, not via the MCP interface:

```bash
cua-driver --version
cua-driver serve
cua-driver permissions status --json
```

If accessibility or screen recording is not granted to the CuaDriver app, use `cua-driver permissions grant` locally and complete the macOS permission prompts. `computer.status` checks presence, daemon status, and permissions without starting a daemon or prompting for authorization. A stopped daemon can report permissions for the calling process rather than the actual driver; recheck with the daemon running.

## Workflow

1. `computer.status` to check the driver, daemon, and permissions.
2. `computer.list_apps` / `computer.list_windows` to identify the app, PID, window ID, and bounds.
3. `computer.get_window_state({pid, window_id})` to read the accessibility tree and a screenshot, or `computer.screenshot({pid, window_id})` to see the pixels.
4. When needed, `computer.activate_window` raises that precise window. Call `computer.click`, `computer.drag`, `computer.scroll`, `computer.type`, `computer.press_key`, or `computer.hotkey` with the same PID and window ID.
5. Inspect state again after each change. Do not assume that a driver-reported success proves the intended application effect.

`computer.launch_app({bundle_id})` can start a native application; list its windows afterwards. There is no general arbitrary driver-command passthrough and no automatic fallback from `browser.*`.

For an accessibility action, pass an `element_index` from the last `get_window_state` call **in the same conversation/work context**. These indices are invalidated after a mutation or a screenshot-only call, and they can be invalidated by another tool client using the same Cua Driver; obtain a fresh state. For coordinate actions, `x/y` are **window-local screenshot pixels**, not display points. Always bind the intended `pid` and `window_id`. Host operations are serialized within this MCP process; separate processes that share Cua Driver require coordination.

Screenshots are stored as mode 0600 files at `generated/local-dev-mcp/computer/` in the selected project and returned as inline image content through `image.read`. They are **not** user-facing attachments; use `artifact.link` separately if the user requests the file.

## Safety boundary

- A verified interactive ChatGPT session or Claude/Muse work identity and an active registered project are required. Muse must pass `project_id` for every call; Claude must pass its `context_id`.
- `computer.*` is **host-wide UI access**, not a filesystem sandbox. Changing the selected project does not isolate the physical desktop. Mutation calls require that project's `write_policy=allow`. `confirm` and `deny` projects cannot mutate the desktop through these tools.
- Do not type passwords, OTPs, recovery codes, or tokens with `computer.type`. Do not capture secret-bearing windows into the model context. For these, use the local user's own login controls.
- Explicitly verify the target and final action before submitting, purchasing, deleting, sending, or publishing. Mutations with an uncertain result return `action_applied=null` and `retry_action=false`; do not blindly repeat.
- Driver errors are deliberately generic so they cannot echo typed text through stderr. Tool output never includes the text passed to `computer.type`.
- App/window names and screenshots may still contain private data: grant MCP access only to trusted clients and keep the driver and desktop permissions under local control.
