# Browser runtime operations

Browser automation is optional (default ON). `pnpm run setup --yes --disable browser` hides `browser.*` and prevents the managed Chrome lifecycle from starting. No Chrome installation is necessary when disabled. See [Setup](setup.md).

## Browser tool contract

- Use `browser.snapshot` to read a bounded accessibility/ARIA view of the selected tab, optionally scoped by `selector` and `frame`. Use `query` to search lines anywhere in the accessibility snapshot and `next_offset` for subsequent pages (offset counts matching lines). This is the default discovery route; accessible roles and names are preferred to fragile positional CSS selectors.
- Use `browser.dom` only for exact text or HTML, with `selector`, optional `frame`, `mode`, and `max_bytes`. DOM text and HTML are truncated inside the page before transfer over CDP. Both operations use Playwright locators so they can inspect open Shadow DOM and iframe content.
- Use `browser.click`, `browser.type`, and `browser.interact` for actions. `wait_for` verifies a postcondition and avoids an extra screenshot unless `observe: "after"` is requested. An unknown action result is not a reason to retry an irreversible action automatically.
- Use `browser.tabs` to select or inspect the target tab and `browser.status` for the chat-owned browser lifecycle. Arbitrary `browser.eval` requires an explicit `unsafe: true`; prefer typed tools for normal operation.
- The browser operation engine is Playwright Core attached over CDP (`noDefaults: true`), preserving the existing Chrome process, download settings, and on-disk profile management. Connection to an unresponsive tab may fail; a timeout is not evidence that another tab is unavailable.

## Profile operation locks

Browser operations on the same chat profile are serialized across coordinator
instances by a loopback TCP listener. Probe connections identify the current lock
owner. The listener retains the lock until the owning operation finishes.

A probe that disconnects or resets its TCP connection is closed independently.
It must not terminate the MCP process, release the listener, or allow another
operation to enter the same profile early. The regression test exercises a real
TCP reset followed by a competing operation and subsequent lock reuse:

```sh
pnpm exec vitest run tests/unit/browser-operation-coordinator.test.ts
```

## 2026-10-24 incident observations

The runtime exited with an unhandled socket `read ECONNRESET` at 08:29 and 08:47
JST. Resetting an isolated operation-lock probe reproduced the same exception and
exit status before the fix. The historical stack traces do not identify the
individual socket, so they do not prove which connection originally reset.

After the first restart, one profile had an incomplete running lease. Subsequent
browser calls recorded `BROWSER_START_FAILED`. Chrome startup and saved-tab
restoration succeeded using a copy of that profile, including from a separate
LaunchAgent with the server's environment. The later startup failures were not
reproduced. They must not be reported as explained solely by the socket fix.

Chrome child stderr is currently discarded by the browser-start handler. A
`BROWSER_START_FAILED` response and an MCP process crash are different failures;
investigate the returned error and current `/healthz` state separately.
