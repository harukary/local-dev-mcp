# Mobile automation

The `mobile.*` tools use the existing `agent-device` backend for physical iOS devices and iOS/Android simulators or emulators. There is no additional WebDriverAgent service, mobile server, or dependency.

## Observing the device

Use `mobile.list_devices` to choose an exact device ID. Read the current UI with `mobile.snapshot` or `mobile.screenshot` before operating on a page whose content is unknown.

Actions such as `mobile.tap`, `mobile.tap_element`, `mobile.type`, `mobile.swipe`, `mobile.launch_app`, and `mobile.press` return **compact status by default**, without a screenshot or fixed post-action delay. When the next decision depends on the updated page, request `observe: "snapshot"` for its accessibility tree or `observe: "after"` for an inline screenshot. Use `wait_for: { "target": "...", "timeout_ms": 10000 }` when the operation has a known UI postcondition.

`mobile.swipe` keeps the same four absolute coordinates and optional `duration_ms` (500 ms by default) on both platforms. On iOS it converts the rounded endpoints to a relative `agent-device gesture pan x y dx dy durationMs` (supported by pinned agent-device 0.21.0); the older `agent-device swipe x1 y1 x2 y2 durationMs` CLI form is invalid. Android continues using ADB `input swipe x1 y1 x2 y2 durationMs`. The `swipe` step inside `mobile.batch` uses the same implementation.

A successful action distinguishes execution from verification:

- `action_applied: true`: the device backend reported successful execution.
- `action_complete: true`: the action and its explicitly requested observation/wait completed.
- `verified: true`: a requested `wait_for` UI target was found, not that a business transaction succeeded.
- `verification_deferred: true`: no UI postcondition was requested.

An action-level transport error may report `action_applied: null`: execution is uncertain. Never replay an uncertain tap, text entry, or submission without first observing the current device state. If an observation fails *after* an action, `action_applied: true` and `retry_action: false` preserve that distinction.

If `mobile.launch_app` or a snapshot repeatedly fails with the same backend/device error, **do not immediately repeat the launch**. Use `mobile.status` and `mobile.list_devices` to verify the backend and device, check the current UI with `mobile.snapshot` or `mobile.screenshot` where possible, then address a missing device, unavailable simulator, or stale session before retrying once. Repeated failures are not evidence that the app was never launched. This is an operational recovery rule, not an automatic retry or extra mobile service.

`mobile.snapshot` removes redundant values and common true flags. It keeps `ref`, `identifier`, `label`, type, hierarchy, and relevant state. Element rectangles are `[x,y,width,height]` in the backend's screen coordinates. Element refs expire after page mutations, cross-chat actions or 60 seconds; use fresh refs instead of replaying stale ones.

## Batching known steps

`mobile.batch` executes at most 20 known steps sequentially on **one device**. Supported operations are `tap`, `tap_element`, `type`, `swipe`, `press`, `launch_app`, `open_url` and `wait`. Every step is schema-validated before the first device operation. Step objects cannot override the batch device. The same per-device operation queue used by other `mobile.*` tools serializes the entire batch.

For example, to open settings and return to the previous screen:

```json
{
  "device": "your-device-id",
  "steps": [
    { "op": "tap_element", "args": { "target": "設定" } },
    { "op": "wait", "args": { "target": "通知" } },
    { "op": "press", "args": { "key": "back", "observe": "snapshot" } }
  ]
}
```

Only the final step may request a screenshot or snapshot. If an intermediate result requires a decision, finish the batch there and inspect its state before starting another one. For uncertain targets, purchase/submit actions, or destructive operations, do not blindly chain subsequent steps; include an explicit postcondition and verify the outcome.

A batch returns `complete`, `completed_steps`, and `results`. On failure it also returns `stopped_at`, `stop_reason`, `failed_step`, and `replay_action: false`. A per-batch 90-second scheduling budget stops *before* another step, rather than replaying or silently dropping steps. Earlier completed steps must not be resent.

## Error recovery

For element lookup/visibility failures, `mobile.tap_element` returns a recovery hint. A single screenshot is attached when the backend reports a recognized UI-target error and image capture succeeds; otherwise inspect with `mobile.screenshot`. Authentication, device/session faults, and uncertain transport failures are not treated as missing UI elements. The original error remains available even if screenshot capture fails.

Keep screenshots and large UI dumps out of normal action results. Request them only when the next decision, a final checkpoint, or a failure requires visual evidence.
