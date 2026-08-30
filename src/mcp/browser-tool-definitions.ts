const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const WD = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

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
    { name: "browser.status", description: "Return the current chat-owned browser profile, auth-probe, and GC status.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.start", description: "Start or reuse the current chat-owned Chrome profile cloned from the immutable golden profile.", inputSchema: { type: "object", properties: { url: { type: "string" } } }, annotations: WA },
    { name: "browser.sessions", description: "Return only the current chat-owned browser session.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.stop", description: "Stop the current chat-owned browser, verify allowlisted logins, and checkpoint it for possible golden promotion.", inputSchema: { type: "object", properties: {} }, annotations: WA },
    { name: "browser.tabs", description: "List tabs in the current chat-owned browser.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.tab.open", description: "Open a new tab and make it the active tab for the current chat-owned browser.", inputSchema: { type: "object", properties: { url: { type: "string" } } }, annotations: WA },
    { name: "browser.tab.use", description: "Select an existing page target as the active tab for subsequent browser operations.", inputSchema: { type: "object", properties: { target_id: { type: "string" } }, required: ["target_id"] }, annotations: WA },
    { name: "browser.tab.close", description: "Close an existing page target. Closing the active tab leaves no active selection.", inputSchema: { type: "object", properties: { target_id: { type: "string" } }, required: ["target_id"] }, annotations: WD },
    { name: "browser.dom", description: "Return DOM text and HTML for a selector in the current chat-owned browser.", inputSchema: { type: "object", properties: { selector: { type: "string" } } }, annotations: RO },
    { name: "browser.selectors", description: "Return interactive selector candidates from the current chat-owned browser.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 }, query: { type: "string" } } }, annotations: RO },
    { name: "browser.click", description: "Click an element by CSS selector. Prefer wait_for for condition-driven flows; it combines click+wait and skips the default screenshot unless observe=after is explicit.", inputSchema: { type: "object", properties: { selector: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["selector"] }, annotations: WA },
    { name: "browser.type", description: "Set text on an input-like element by CSS selector. Prefer wait_for after submit/navigation; it combines type+wait and skips the default screenshot unless observe=after is explicit.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["selector", "text"] }, annotations: WA },
    { name: "browser.wait", description: "Wait for a selector, text, URL substring, or title substring in the current chat-owned browser.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, url_contains: { type: "string" }, title_contains: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } } }, annotations: RO },
    { name: "browser.eval", description: "Evaluate JavaScript in the current chat-owned browser and return the JSON-serializable result.", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }, annotations: WA },
    { name: "browser.press", description: "Dispatch a key press in the current chat-owned browser, optionally focusing a selector first.", inputSchema: { type: "object", properties: { key: { type: "string" }, selector: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["key"] }, annotations: WA },
    { name: "browser.reload", description: "Reload the active page in the current chat-owned browser.", inputSchema: { type: "object", properties: { observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.back", description: "Navigate back in the current chat-owned browser history.", inputSchema: { type: "object", properties: { observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.forward", description: "Navigate forward in the current chat-owned browser history.", inputSchema: { type: "object", properties: { observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.screenshot", description: "Capture a screenshot from the current chat-owned browser.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.open", description: "Navigate the current chat-owned browser to an http/https URL.", inputSchema: { type: "object", properties: { url: { type: "string" }, observe: { type: "string", enum: ["none", "after"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["url"] }, annotations: WA },
  ];
}
