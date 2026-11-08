const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const WD = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const pid = { type: "integer", minimum: 1, description: "Process ID from computer.list_windows." };
const windowId = { type: "integer", minimum: 1, description: "Window ID from computer.list_windows. Always recheck the target before modifying it." };
const point = { type: "number", minimum: 0, maximum: 100000, description: "Window-local screenshot pixel coordinate (not macOS screen points)." };
const elementIndex = { type: "integer", minimum: 0, description: "Accessibility element index from computer.get_window_state in this work context. Read the window state again before using." };
const modifiers = { type: "array", items: { type: "string", enum: ["cmd", "shift", "option", "alt", "ctrl"] }, maxItems: 4 };

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], annotations = RO) {
  return { name: "computer." + name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations };
}

export function buildComputerToolDefinitions() {
  return [
    tool("status", "Check whether the macOS Cua Driver is installed, running, and permitted to capture the screen and control UI. Does not start the driver.", {}),
    tool("list_apps", "List installed/running macOS applications, with bounded output. Use browser.* for ordinary DOM-based web operations.", {}),
    tool("list_windows", "List desktop windows and their pid/window_id/bounds before choosing an explicit target. Never infer a window ID.", {
      pid, app_name_contains: { type: "string", maxLength: 120 }, title_contains: { type: "string", maxLength: 120 },
      on_current_space: { type: "boolean" },
    }),
    tool("get_window_state", "Read a specific macOS window's accessibility tree and screenshot. Element indices are valid only for the most recent snapshot of that window. Do not inspect password, OTP, or secret fields.", {
      pid, window_id: windowId, query: { type: "string", maxLength: 160 },
    }, ["pid", "window_id"]),
    tool("screenshot", "Capture a window-local screenshot for model inspection. Use pid and window_id from computer.list_windows. Screenshots may contain private information.", {
      pid, window_id: windowId,
    }, ["pid", "window_id"]),
    tool("activate_window", "Bring the specified existing window to the foreground using Cua Driver. Requires a verified pid and window_id.", {
      pid, window_id: windowId,
    }, ["pid", "window_id"], WA),
    tool("launch_app", "Launch an installed macOS app by its bundle identifier. Does not select a window; call computer.list_windows afterwards.", {
      bundle_id: { type: "string", minLength: 3, maxLength: 200 },
    }, ["bundle_id"], WA),
    tool("click", "Click a specific window using either an accessibility element_index or window-local screenshot x/y. Reinspect the window between actions; do not blindly retry uncertain mutations.", {
      pid, window_id: windowId, element_index: elementIndex, x: point, y: point,
      count: { type: "integer", minimum: 1, maximum: 3 },
      modifier: modifiers,
    }, ["pid", "window_id"], WD),
    tool("drag", "Drag between two window-local screenshot coordinates in an explicitly identified window.", {
      pid, window_id: windowId,
      from_x: point, from_y: point, to_x: point, to_y: point,
      duration_ms: { type: "integer", minimum: 0, maximum: 10000 },
    }, ["pid", "window_id", "from_x", "from_y", "to_x", "to_y"], WD),
    tool("scroll", "Scroll a specific desktop window. Prefer element_index for a particular scrollable region.", {
      pid, window_id: windowId, element_index: elementIndex,
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: { type: "integer", minimum: 1, maximum: 50 },
      by: { type: "string", enum: ["line", "page"] },
    }, ["pid", "window_id", "direction"], WA),
    tool("type", "Type into a selected macOS window or accessibility element. Never send passwords, OTPs, recovery codes, or API tokens via this tool. Input text is not echoed in the result.", {
      pid, window_id: windowId, element_index: elementIndex,
      text: { type: "string", maxLength: 10000 },
    }, ["pid", "window_id", "text"], WD),
    tool("press_key", "Press one key in a specified window; key names include return, tab, escape, arrows, letters, digits and function keys.", {
      pid, window_id: windowId, element_index: elementIndex,
      key: { type: "string", minLength: 1, maxLength: 24 },
    }, ["pid", "window_id", "key"], WD),
    tool("hotkey", "Press a modifier and key combination in the specified macOS window (e.g. cmd+c).", {
      pid, window_id: windowId,
      keys: { type: "array", items: { type: "string", minLength: 1, maxLength: 24 }, minItems: 2, maxItems: 5 },
    }, ["pid", "window_id", "keys"], WD),
  ];
}
