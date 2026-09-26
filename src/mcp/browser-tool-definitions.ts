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
    { name: "browser.interact", description: "Hover, select an option, set a checkbox, drag, or upload project files using a strict Playwright locator with optional iframe.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["hover", "select", "check", "uncheck", "drag", "upload"] }, selector: { type: "string" }, frame: { type: "string" }, value: { type: "string" }, target_selector: { type: "string" }, files: { type: "array", items: { type: "string" }, maxItems: 20 }, observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["action", "selector"] }, annotations: WA },
    { name: "browser.status", description: "Return the current chat-owned browser profile, suspend/resume metadata, auth-probe state, and retention limits.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.start", description: "Start or reuse the current chat-owned Chrome profile. A suspended profile resumes its saved tabs and active tab; an optional URL replaces the saved active tab URL.", inputSchema: { type: "object", properties: { url: { type: "string" } } }, annotations: WA },
    { name: "browser.sessions", description: "Return only the current chat-owned browser session.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.stop", description: "Suspend the current chat-owned browser, preserving its profile, tabs, tab order, and active tab for the next live browser tool call. Repeated stop is idempotent once suspended.", inputSchema: { type: "object", properties: {} }, annotations: WA },
    { name: "browser.tabs", description: "List tabs in the current chat-owned browser.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "browser.tab.open", description: "Open a new tab and make it the active tab for the current chat-owned browser.", inputSchema: { type: "object", properties: { url: { type: "string" } } }, annotations: WA },
    { name: "browser.tab.use", description: "Select an existing page target as the active tab for subsequent browser operations.", inputSchema: { type: "object", properties: { target_id: { type: "string" } }, required: ["target_id"] }, annotations: WA },
    { name: "browser.tab.close", description: "Close an existing page target. Closing the active tab leaves no active selection.", inputSchema: { type: "object", properties: { target_id: { type: "string" } }, required: ["target_id"] }, annotations: WD },
    { name: "browser.dom", description: "Read bounded DOM text (default), HTML, or both for a selector.", inputSchema: { type: "object", properties: { selector: { type: "string" }, mode: { type: "string", enum: ["text", "html", "both"] }, max_bytes: { type: "integer", minimum: 1, maximum: 131072 } } }, annotations: RO },
    { name: "browser.selectors", description: "Return interactive selector candidates from the current chat-owned browser.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 }, query: { type: "string" } } }, annotations: RO },
    { name: "browser.click", description: "Click an element using a strict Playwright locator (CSS, text= or role=), with actionability checks and optional iframe. Prefer wait_for for condition-driven flows; it combines click+wait and skips the default screenshot unless observe=after is explicit.", inputSchema: { type: "object", properties: { selector: { type: "string" }, frame: { type: "string", description: "Optional iframe selector." }, observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["selector"] }, annotations: WA },
    { name: "browser.type", description: "Fill an input or contenteditable using a strict Playwright locator and optional iframe. Prefer wait_for after submit/navigation; it combines type+wait and skips the default screenshot unless observe=after is explicit.", inputSchema: { type: "object", properties: { selector: { type: "string" }, frame: { type: "string", description: "Optional iframe selector." }, text: { type: "string" }, submit: { type: "boolean" }, observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["selector", "text"] }, annotations: WA },
    { name: "browser.wait", description: "Wait for a selector, text, URL substring, or title substring in the current chat-owned browser.", inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, url_contains: { type: "string" }, title_contains: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } } }, annotations: RO },
    { name: "browser.eval", description: "Evaluate JavaScript in the current chat-owned browser and return the JSON-serializable result.", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] }, annotations: WA },
    { name: "browser.press", description: "Dispatch a key press in the current chat-owned browser, optionally focusing a selector first.", inputSchema: { type: "object", properties: { key: { type: "string" }, selector: { type: "string" }, frame: { type: "string", description: "Optional iframe selector." }, observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["key"] }, annotations: WA },
    { name: "browser.reload", description: "Reload the active page in the current chat-owned browser.", inputSchema: { type: "object", properties: { observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.back", description: "Navigate back in the current chat-owned browser history.", inputSchema: { type: "object", properties: { observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.forward", description: "Navigate forward in the current chat-owned browser history.", inputSchema: { type: "object", properties: { observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 } } }, annotations: WA },
    { name: "browser.screenshot", description: "Capture a screenshot from the current chat-owned browser.", inputSchema: { type: "object", properties: { clip: { type: "object", description: "Optional page-coordinate crop and output scale.", properties: { x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, width: { type: "number", minimum: 1, maximum: 4096 }, height: { type: "number", minimum: 1, maximum: 4096 }, scale: { type: "number", minimum: 0.25, maximum: 2 } }, required: ["x", "y", "width", "height", "scale"] } } }, annotations: RO },
    { name: "browser.open", description: "Navigate the current chat-owned browser to an http/https URL.", inputSchema: { type: "object", properties: { url: { type: "string" }, observe: { type: "string", enum: ["none", "after", "snapshot"] }, wait_ms: { type: "integer", minimum: 0, maximum: 10000 }, wait_for: BROWSER_WAIT_FOR_SCHEMA }, required: ["url"] }, annotations: WA },
  ];
}
