# Browser HTTP Basic authentication

The managed browser can open an existing HTTP Basic-protected site using an opt-in, single-navigation credential pair.

## Usage

Pass an HTTPS URL and `http_credentials: { username, password }` to `browser.open`. Do not embed credentials in the URL. A plain HTTP URL is accepted only for a loopback development server. The existing `browser.open` behavior is unchanged when `http_credentials` is omitted.

The tool enables Chrome DevTools `Fetch` request interception only on the exact origin of the requested URL. It continues paused requests, responds once to each server-side Basic authentication challenge with the supplied credentials, and cancels repeated challenges or proxy/foreign-origin challenges. It disables interception and detaches the temporary CDP session when navigation completes or fails. Browser-managed HTTP auth cache may remain usable for follow-up same-origin requests while Chrome is running; MCP itself does not persist, echo, or include the supplied password in result metadata, URLs, session files, or logs.

Cloudflare Access is a separate authentication boundary. Authenticate with Cloudflare Access before opening a Basic-protected Staging site. Do not use Basic credentials to bypass Cloudflare Access.

## Verification

- `pnpm typecheck`
- `pnpm vitest run tests/unit/http-basic-auth.test.ts`
- `pnpm vitest run tests/integration/browser-basic-http.test.ts` (uses real Google Chrome if installed; otherwise skipped)
- After runtime/schema refresh, invoke `browser.open` on the protected site with a known valid existing credential and verify that the authenticated DOM is visible. Verify that ordinary navigation without supplied credentials remains challenged.

The integration test runs a loopback Basic challenge without storing real credentials.
