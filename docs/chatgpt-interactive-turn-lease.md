# ChatGPT Interactive Turn Lease

## Purpose

Long-running ChatGPT turns that repeatedly call local-dev can eventually fail with a ChatGPT-side `Message delivery timed out. Please try again.` even when the underlying local work is still healthy. The interactive turn lease limits how long a single ChatGPT assistant turn may keep calling local-dev without changing the work plan itself.

The lease is a transport-safety boundary only. It must not change implementation choices, scope, validation, ordering, or quality.

## Behavior

- The lease duration is 15 minutes.
- Timing starts at the first local-dev tool call in an interactive ChatGPT assistant turn.
- Work proceeds normally until the lease expires.
- A tool call already in progress is never interrupted by the lease.
- After the lease expires, the next local-dev tool call is not executed.
- Instead, local-dev returns a normal control response with `status: "turn_paused"`.
- The response tells ChatGPT not to retry local-dev again in the same assistant turn.
- Existing background jobs continue running.
- ChatGPT should return control to the user.
- The next user message creates a new assistant turn and therefore a fresh 15-minute lease.
- The original workflow is resumed unchanged from the same point.
- Scheduled Tasks are excluded from the interactive lease.

The lease does not prescribe user-facing wording. ChatGPT decides how to explain progress to the user.

## Turn Identification

ChatGPT supplies `openai/session`, but that identifies the chat rather than an individual assistant turn.

Secure Tunnel also forwards `X-Request-Id` values in this form:

```text
<request-group>/<request-suffix>
```

Multiple local-dev calls from the same assistant turn share the same request-group prefix. A later assistant turn receives a different prefix.

local-dev therefore builds the lease key from:

```text
openai/session + X-Request-Id request-group
```

The request-group is injected into internal MCP request metadata as `local-dev/turn-request-id` before tool dispatch.

This keeps the lease scoped to a single assistant turn while preserving the existing chat-scoped project and browser state.

## Pause Response

When the lease has expired, the requested tool is skipped and local-dev returns a non-error response similar to:

```json
{
  "status": "turn_paused",
  "reason": "interactive_turn_time_limit",
  "requested_tool": "shell.status",
  "tool_call_executed": false,
  "elapsed_seconds": 929,
  "turn_limit_seconds": 900,
  "retry_in_same_turn": false,
  "resume_on_next_user_turn": true,
  "preserve_workflow": true,
  "cancel_background_jobs": false
}
```

The accompanying instructions explain that:

- this is an intentional ChatGPT turn boundary, not a local-dev failure;
- the requested tool call was not executed;
- ChatGPT must not retry local-dev in the same assistant turn;
- the implementation plan, scope, and validation must not be reduced or changed because of the pause;
- running background jobs must not be cancelled;
- the original workflow should resume after the next user message.

## Implementation

The implementation lives in:

- `src/mcp/turn-lease.ts`
- `src/mcp/server.ts`
- `tests/unit/turn-lease.test.ts`

`InteractiveTurnLeaseManager` stores the first-call timestamp for each turn key and marks that turn as paused once 900 seconds have elapsed.

The lease check happens before tool execution. This means a long-running tool call may cross the 15-minute boundary and still finish normally; the next local-dev call is the point where execution pauses.

## Runtime Validation

The production behavior was validated end to end on 2026-10-02 using local-dev-mini with the same deployed commit as local-dev.

The test kept a single ChatGPT assistant turn alive with sequential background sleeps:

- first `sleep 300`: completed in 300.302 seconds;
- second `sleep 300`: completed in 300.142 seconds;
- third `sleep 300`: started and remained running across the 15-minute boundary;
- the next `shell.status` call after 929 elapsed seconds returned `status: "turn_paused"`;
- that `shell.status` request reported `tool_call_executed: false`;
- the fourth planned sleep was not started, which is the expected behavior.

This confirms that local-dev does not interrupt in-flight work and instead stops at the next MCP tool boundary after the 15-minute lease expires.

## Verification

The focused MCP validation for this change passed:

- turn-lease tests;
- MCP server tests;
- MCP instruction tests;
- TypeScript typecheck;
- production build.

The implementation was deployed to both local-dev and local-dev-mini from commit `abf73a5` and both LaunchAgent-managed servers were restarted.

## Operational Notes

If `turn_paused` appears unexpectedly early, inspect whether Secure Tunnel is changing the `X-Request-Id` grouping semantics.

If ChatGPT continues calling local-dev after receiving `turn_paused`, check that the current server instructions are loaded. A new Branch/chat forces a new ChatGPT MCP context and is useful after server-instruction changes.

The 15-minute value is intentionally a turn boundary, not a work-planning heuristic. Do not introduce rules such as skipping tests, shortening implementation, or changing task priority as the lease approaches expiry.
