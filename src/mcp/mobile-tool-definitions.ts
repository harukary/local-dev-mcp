import { imageViewerMeta } from "./resources/image-viewer.js";

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const imageMeta = imageViewerMeta();

export function buildMobileToolDefinitions() {
  return [
    { name: "mobile.status", description: "Return mobile backend availability and discovered devices.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "mobile.list_devices", description: "List iOS Simulator and Android devices visible to local-dev-mcp.", inputSchema: { type: "object", properties: {} }, annotations: RO },
    { name: "mobile.screenshot", description: "Capture a screenshot from an iOS Simulator or Android device and return image metadata/path.", _meta: imageMeta, inputSchema: { type: "object", properties: { device: { type: "string" } } }, annotations: RO },
    { name: "mobile.boot", description: "Boot an iOS Simulator and open the Simulator app.", inputSchema: { type: "object", properties: { device: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: "mobile.open_url", description: "Open a URL on an iOS Simulator or Android device and return an after-action screenshot by default.", _meta: imageMeta, inputSchema: { type: "object", properties: { device: { type: "string" }, url: { type: "string" }, observe: { type: "string", enum: ["none", "after"] } }, required: ["url"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: "mobile.tap", description: "Tap coordinates on an iOS Simulator or Android device and return an after-action screenshot by default.", _meta: imageMeta, inputSchema: { type: "object", properties: { device: { type: "string" }, x: { type: "number" }, y: { type: "number" }, observe: { type: "string", enum: ["none", "after"] } }, required: ["x", "y"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: "mobile.type", description: "Type text on an iOS Simulator or Android device and return an after-action screenshot by default.", _meta: imageMeta, inputSchema: { type: "object", properties: { device: { type: "string" }, text: { type: "string" }, observe: { type: "string", enum: ["none", "after"] } }, required: ["text"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ];
}
