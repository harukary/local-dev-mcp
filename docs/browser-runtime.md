# Browser runtime operations

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
