const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const BROWSER_WAIT_FOR_SCHEMA = {
  type: "object",
  description: "Optional post-action condition. When supplied and observe is omitted, the condition result replaces the default screenshot; set observe=after to capture one too.",
  properties: {
    selector: { type: "string" },
    text: { type: "string" },
    url_contains: { type: "string" },
    title_contains: { type: "string" },
    timeout_ms: { type: "integer", minimum: 1, maximum: 60000 },
  },
};

export function buildBrowserToolDefinitions() {
  return [
    { name: "browser.status", description: "Return browser CDP backend availability, port range, and known sessions.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.start", description: "Start or reuse the local-dev-mcp default Chrome DevTools Protocol browser. An explicit session_id creates an isolated disposable session.", inputSchema: { type: "object", properties: { url: { type: "string" }, session_id: { type: "string" } } }, annotations: WA },
    { name: "browser.sessions", description: "List known browser CDP sessions for the selected project.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.stop", description: "Stop a browser CDP session. The default local-dev-mcp profile is retained for login continuity; explicit session profiles are deleted.", inputSchema: { type: "object", properties: { session_id: { type: "string" } } }, annotations: WA },
    { name: "browser.tabs", description: "List page targets/tabs for a browser CDP session.", inputSchema: { type: "object", properties: { session_id: { type: "string" } } }, annotations: RO },
    { name: "browser.dom", description: "Return DOM text and HTML for a selector in a browser CDP session.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, selector: { type: "string" } } }, annotations: RO },
    { name: "browser.selectors", description: "Return interactive selector candidates from a browser CDP session.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 }, query: { type: "string" } } }, annotations: RO },
    { name: "browser.click", description: "Click an element by CSS selector. Prefer wait_for for condition-driven flows; it combines click+wait and skips the default screenshot unless observe=after is explicit.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, selector: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["selector"] }, annotations: WA },
    { name: "browser.type", description: "Set text on an input-like element by CSS selector. Prefer wait_for after submit/navigation; it combines type+wait and skips the default screenshot unless observe=after is explicit.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["selector", "text"] }, annotations: WA },
    { name: "browser.wait", description: "Wait for a selector and/or text, URL substring, or title substring to appear in a browser CDP session.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, selector: { type: "string" }, text: { type: "string" }, url_contains: { type: "string" }, title_contains: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } } }, annotations: RO },
    { name: "browser.eval", description: "Evaluate JavaScript in a browser CDP session and return the JSON-serializable result.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, expression: { type: "string" } }, required: ["expression"] }, annotations: WA },
    { name: "browser.press", description: "Dispatch a key press in a browser CDP session, optionally focusing a selector first, and return an after-action screenshot by default.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, key: { type: "string" }, selector: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["key"] }, annotations: WA },
    { name: "browser.reload", description: "Reload the active page in a browser CDP session and return an after-action screenshot by default.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.back", description: "Navigate back in the active browser CDP session history and return an after-action screenshot by default.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.forward", description: "Navigate forward in the active browser CDP session history and return an after-action screenshot by default.", inputSchema: { type: "object", properties: { session_id: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.screenshot", description: "Capture a screenshot from the active Chrome DevTools Protocol page session.", inputSchema: { type: "object", properties: { session_id: { type: "string" } } }, annotations: RO },
    { name: "browser.open", description: "Navigate a browser session to an http/https URL. Prefer wait_for over a fixed wait_ms; with wait_for and no observe, the condition result replaces the default screenshot.", inputSchema: { type: "object", properties: { url: { type: "string" }, session_id: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["url"] }, annotations: WA },
  ];
}
