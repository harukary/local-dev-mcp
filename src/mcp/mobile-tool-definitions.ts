const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MUT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const MOBILE_WAIT_FOR_SCHEMA = {
  type: "object",
  description: "Optional post-action UI condition. When supplied and observe is omitted, the wait result replaces the default screenshot; set observe=after to capture one too.",
  properties: {
    target: { type: "string", description: "Visible text, or an agent-device snapshot ref/selector on backends that support them; physical iPhone roamrunctl supports visible text only." },
    timeout_ms: { type: "integer", minimum: 1, maximum: 60000 },
  },
  required: ["target"],
};

const MOBILE_OBSERVE = { type: "string", enum: ["none", "after", "snapshot"], description: "Default none: return a compact action result. Choose snapshot or after only when the next decision needs a new UI tree or screenshot." };

const BATCH_POST = { observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA };
const BATCH_NUMBER = { type: "number", minimum: 0, maximum: 10000 };
const BATCH_TEXT = { type: "string", minLength: 1 };
const BATCH_STEPS = [
  { op: "tap", properties: { x: BATCH_NUMBER, y: BATCH_NUMBER, ...BATCH_POST }, required: ["x", "y"] },
  { op: "tap_element", properties: { target: BATCH_TEXT, snapshot_id: BATCH_TEXT, ...BATCH_POST }, required: ["target"] },
  { op: "type", properties: { text: { type: "string" }, ...BATCH_POST }, required: ["text"] },
  { op: "swipe", properties: { x1: BATCH_NUMBER, y1: BATCH_NUMBER, x2: BATCH_NUMBER, y2: BATCH_NUMBER, duration_ms: { type: "integer", minimum: 0, maximum: 60000 }, ...BATCH_POST }, required: ["x1", "y1", "x2", "y2"] },
  { op: "press", properties: { key: { type: "string", enum: ["home", "back"] }, ...BATCH_POST }, required: ["key"] },
  { op: "launch_app", properties: { app: BATCH_TEXT, ...BATCH_POST }, required: ["app"] },
  { op: "open_url", properties: { url: { type: "string", minLength: 1, pattern: "^(?!file:)" }, ...BATCH_POST }, required: ["url"] },
  { op: "wait", properties: { target: BATCH_TEXT, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["target"] },
].map(({ op, properties, required }) => ({
  type: "object",
  properties: { op: { type: "string", const: op }, args: { type: "object", properties, required, additionalProperties: false } },
  required: ["op", "args"],
  additionalProperties: false,
}));

export function buildMobileToolDefinitions() {
  return [
    { name: "mobile.status", description: "Return mobile backend availability and discovered simulators, emulators, and physical devices.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "mobile.list_devices", description: "List iOS Simulator, physical iOS, and Android devices visible to local-dev-mcp.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "mobile.screenshot", description: "Capture a screenshot from an iOS Simulator, physical iOS device, or Android device for model inspection and return inline image content plus metadata/path. This does not create a user-visible chat attachment. If the user asks to send, show, or attach the screenshot in chat, call artifact.link with the returned screenshot path; use artifact.read only as a compatibility fallback.", inputSchema: { type: "object", properties: { device: { type: "string" } } }, annotations: RO },
    { name: "mobile.snapshot", description: "Capture a compact accessibility tree. iOS Simulator and Android may provide refs and rectangles; physical iPhone roamrunctl returns captions only, with no element refs or positions.", inputSchema: { type: "object", properties: { device: { type: "string" }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000 } } }, annotations: RO },
    { name: "mobile.current_app", description: "Return the foreground Android package/activity without invoking adb through shell.run.", inputSchema: { type: "object", properties: { device: { type: "string" } } }, annotations: RO },
    { name: "mobile.logs", description: "Return bounded Android logcat output, optionally narrowed by package PID and literal query.", inputSchema: { type: "object", properties: { device: { type: "string" }, package: { type: "string" }, query: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 1000 } } }, annotations: RO },
    { name: "mobile.stop_app", description: "Stop an Android app or iOS Simulator app by package/bundle ID. Physical iOS app termination is not supported.", inputSchema: { type: "object", properties: { device: { type: "string" }, app: { type: "string" } }, required: ["app"] }, annotations: MUT },
    { name: "mobile.restart_app", description: "Stop then relaunch an Android or iOS Simulator app. wait_for can verify the relaunched UI in the same call; physical iOS restart is not supported.", inputSchema: { type: "object", properties: { device: { type: "string" }, app: { type: "string" }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["app"] }, annotations: MUT },
    { name: "mobile.boot", description: "Boot an iOS Simulator and open the Simulator app. Physical iOS devices do not need booting.", inputSchema: { type: "object", properties: { device: { type: "string" } } }, annotations: MUT },
    { name: "mobile.launch_app", description: "Launch an app by name/bundle/package. Default returns compact status without a screenshot; use wait_for for an expected UI target or observe=snapshot/after for the next decision.", inputSchema: { type: "object", properties: { device: { type: "string" }, app: { type: "string" }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["app"] }, annotations: MUT },
    { name: "mobile.open_url", description: "Open a URL on Android or iOS Simulator. Not supported on physical iPhone roamrunctl; use the app UI instead. wait_for can verify supported targets.", inputSchema: { type: "object", properties: { device: { type: "string" }, url: { type: "string" }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["url"] }, annotations: MUT },
    { name: "mobile.tap", description: "Tap coordinates on iOS or Android. Physical iPhone roamrunctl requires a recent mobile.screenshot from this chat; its coordinates are original image pixels and each screenshot permits one gesture. Use observe=snapshot/after or wait_for for verification.", inputSchema: { type: "object", properties: { device: { type: "string" }, x: { type: "number" }, y: { type: "number" }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["x", "y"] }, annotations: MUT },
    { name: "mobile.tap_element", description: "Tap an Android or iOS Simulator accessibility element by snapshot ref, visible text or selector. Not supported on physical iPhone roamrunctl because captions have no positions; use mobile.screenshot then mobile.tap.", inputSchema: { type: "object", properties: { device: { type: "string" }, target: { type: "string" }, snapshot_id: { type: "string", description: "Snapshot generation returned by mobile.snapshot. Element refs must belong to a recent snapshot from this chat and are invalidated by device actions." }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["target"] }, annotations: MUT },
    { name: "mobile.type", description: "Type text on iOS or Android. Physical iPhone roamrunctl requires a fresh mobile.screenshot from the same chat; non-ASCII uses paste and may prompt for permission. Use observe or wait_for for verification.", inputSchema: { type: "object", properties: { device: { type: "string" }, text: { type: "string" }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["text"] }, annotations: MUT },
    { name: "mobile.swipe", description: "Swipe between two coordinates. Physical iPhone roamrunctl needs a recent mobile.screenshot; coordinates are original image pixels. Use wait_for to verify the resulting UI.", inputSchema: { type: "object", properties: { device: { type: "string" }, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, duration_ms: { type: "integer", minimum: 0, maximum: 60000 }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["x1", "y1", "x2", "y2"] }, annotations: MUT },
    { name: "mobile.press", description: "Press Home or Back on Android/Simulator. Physical iPhone roamrunctl supports Home only; Back requires observing and tapping the on-screen control.", inputSchema: { type: "object", properties: { device: { type: "string" }, key: { type: "string", enum: ["home", "back"] }, observe: MOBILE_OBSERVE, wait_for: MOBILE_WAIT_FOR_SCHEMA }, required: ["key"] }, annotations: MUT },
    { name: "mobile.wait", description: "Wait until UI content appears. Physical iPhone roamrunctl supports caption-text matching only; Android/Simulator may support element refs and selectors.", inputSchema: { type: "object", properties: { device: { type: "string" }, target: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 60000 } }, required: ["target"] }, annotations: RO },
    { name: "mobile.batch", description: "Run prevalidated mobile steps on one device, stopping on errors without retry. Physical iPhone roamrunctl permits at most one tap/swipe/type per fresh screenshot, and no tap_element/open_url/Back. Only the final step may request an observation.", inputSchema: { type: "object", properties: { device: { type: "string" }, steps: { type: "array", minItems: 1, maxItems: 20, items: { oneOf: BATCH_STEPS } } }, required: ["steps"], additionalProperties: false }, annotations: MUT },
  ];
}
