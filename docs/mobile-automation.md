# Mobile automation

The `mobile.*` tools use one backend per device. They do not require a shared Appium or WebDriverAgent server. Mobile is optional (default ON); `pnpm run setup --yes --disable mobile` hides the tool family and skips mobile dependency diagnostics. See [Setup](setup.md).

| Target | Backend | Prerequisites |
| --- | --- | --- |
| Physical iPhone/iPad (iOS/iPadOS 27+) | Official standalone `roamrunctl mcp` | A saved device-control pairing, Wi-Fi and reachable Tailscale |
| iOS Simulator | Xcode Simulator + project-local `agent-device` | Xcode, iOS runtime and `pnpm install` |
| Android physical device/emulator | ADB; `agent-device` for accessibility operations | Android SDK Platform-Tools and authorized debugging |

The standalone iPhone path does **not** require RoamRun.app, Xcode, WDA, or repeated XCUITest/passcode authorization. The app's older Xcode bridge is not used. An iPhone reboot may still require the owner to unlock it once; Face ID, passcodes and trust prompts are never bypassed.

## Physical iPhone setup (OSS)

1. Install Tailscale on the Mac and iPhone from [its official site](https://tailscale.com/) and join the permitted tailnet. Keep debugging/MCP ports private.
2. Install the open-source standalone CLI. The official Homebrew formula builds the Rust source:

   ```bash
   brew tap mh-mobile/tap
   brew install mh-mobile/tap/roamrunctl
   roamrunctl --version
   ```

   On other supported hosts, consult the [upstream CLI instructions](https://github.com/mh-mobile/RoamRun/tree/main/Rust/roamrunctl). Verify source, checksums and code signing as applicable; do not silently bypass macOS Gatekeeper. If the server's launchd PATH does not contain Homebrew, the standard /opt/homebrew/bin and /usr/local/bin are checked automatically. Set `LOCAL_DEV_MCP_ROAMRUNCTL_BIN` only when using a different **verified** executable.
3. Pair **once**, with the Mac and iPhone on the **same Wi-Fi** (not only remotely via a Tailscale relay). Enable iPhone Developer Mode. The device owner runs:

   ```bash
   roamrunctl pair control --to <iphone-tailnet-name> --as phone
   ```

   On iPhone, open Settings → Privacy & Security → Developer Mode, select the Mac's pairing request, and enter the code shown in the terminal. This manual approval is required. For a host that cannot be near the iPhone, follow upstream's trusted-introducer procedure rather than bypassing pairing.
4. Check `roamrunctl devices`. A listed alias means the pairing key is **saved**; it does not prove the device is online. The CLI stores local pairing keys under `~/.config/roamrunctl/devices/` with owner-only permissions. Other processes running as that user can use an unencrypted key; consider upstream passphrase protection and a protected `ROAMRUNCTL_PASSPHRASE_COMMAND` for unattended sessions. Never commit keys, pairing files, passwords or screenshots.
5. In ChatGPT, select a project and call `mobile.status` or `mobile.list_devices`. A paired device appears as `roamrunctl:phone` with backend `ios_roamrunctl` and state `Paired`. Verify an **actual** `mobile.screenshot` before any tap. After initial pairing, the phone can be on another Wi-Fi connected through Tailscale; starting on cellular alone is not guaranteed.

`pnpm run doctor` reports whether the standalone CLI exists and how many saved pairings it found. It does not contact the iPhone to verify its screen. RoamRun.app's legacy GUI pairing is **not** automatically a standalone `roamrunctl` pairing. Preserve a working old connection until the new one has been explicitly verified.

## Physical iPhone tool behavior

A local-dev MCP server process holds its own persistent **stdio** `roamrunctl mcp` session (via the maintained MCP SDK). No public or local HTTP port is opened. It is independent of haruclaw's separate RoamRunCTL session.

- `mobile.screenshot` returns inline image content, a project-local private JPEG path and original screenshot width/height (`capture.coordinate_space: "image-pixels"`). The phone's native UIKit point size and displayed thumbnail size are **not** coordinate spaces for taps.
- One screenshot authorizes **one** `mobile.tap`, `mobile.swipe` or `mobile.type` in that conversation/device, within 55 seconds. local-dev MCP stores RoamRun's short-lived `lookId` internally; callers need not pass it. An `observe: "after"` screenshot after an action establishes a new look for the next operation. Another client's look or action may invalidate a token; do not automatically retry.
- `mobile.type` uses key input for ASCII and paste for non-ASCII (Japanese included); an iOS paste permission prompt may require manual approval.
- `mobile.launch_app` accepts an exact bundle ID. `mobile.press` supports Home, but not an artificial iOS Back button.
- `mobile.snapshot` reads accessibility captions only: **no element refs, bounding rectangles or selection geometry**. `mobile.tap_element` returns a clear unsupported error on physical iOS; inspect a screenshot and tap its coordinates instead. `mobile.wait` can check visible caption text, not agent-device selector syntax.
- `mobile.open_url`, `mobile.stop_app` and `mobile.restart_app` are not supported on physical iOS. No automatic fallback to Xcode, Appium or another device occurs.
- `mobile.batch` supports at most **one** tap/swipe/type per observed screen on a physical iPhone. It rejects unsupported operations or multiple coordinate/text gestures *before* touching the device. Run another `mobile.screenshot` before subsequent gestures.

A typical interaction is `mobile.list_devices` → `mobile.screenshot` → inspect the image → `mobile.tap` with the exact device and pixel coordinates → `mobile.screenshot` to verify. When an exact `roamrunctl:<alias>` ID is supplied, operations skip unrelated Simulator/ADB discovery. Only perform a mutation after observing the target screen. Do not include raw screenshots, text input or pairing keys in normal log outputs.

## Simulator and Android

iOS Simulator continues to use `agent-device` 0.21.0 for accessibility/tap/swipe, and simctl for app lifecycle/screenshot. The timed swipe adapter uses `agent-device gesture pan`, not its unsupported duration-extended `swipe` command. Android uses ADB and `agent-device` for accessibility. They are **not** switched to RoamRunCTL.

For these backends, `mobile.snapshot` can include refs, hierarchy and `rect=[x,y,width,height]`. Snapshot refs expire after mutation, cross-chat actions or 60 seconds. `mobile.tap_element` and ref-aware `mobile.wait` remain supported as before.

## Observations, batching and failures

Actions return a compact result unless `observe: "snapshot"`, `observe: "after"` or `wait_for` is requested. `action_applied: true` means the backend accepted the operation, not that the app reached the intended business state. `verified: true` means an explicit UI wait condition was met. A failed post-action observation preserves `action_applied: true` and `retry_action: false`.

`mobile.batch` prevalidates up to 20 known steps for one device; only the last step may request observation. A failure stops at `stopped_at`, returns completed steps and **never** resends an uncertain or completed operation. For physical iPhone, the stricter one-gesture-per-look rule applies.

If a mutation outcome is uncertain, capture a fresh screen first. A missing CLI, unpaired device, sleeping/offline iPhone, expired look token, unsupported element operation, and application failure are different diagnoses. When a device is named explicitly, the tool never changes to another target silently.

## Security and lifecycle

The mobile backend runs under the same host-user and MCP authentication rules as local-dev MCP. RoamRunCTL's pairing key provides broad access to the phone screen (including notifications) to processes with the host user's privileges. Protect the pairing directory, avoid exposing another RoamRun HTTP MCP service, and revoke retired device-control pairings on the iPhone under Developer Mode.

The `roamrunctl mcp` subprocess is created only when a physical iPhone operation needs it and is closed with the local-dev MCP process. Saved keys survive restarts; old look tokens do not. The normal ChatGPT Secure MCP Tunnel, project-selection policy and image.read/artifact.link rules remain unchanged.
