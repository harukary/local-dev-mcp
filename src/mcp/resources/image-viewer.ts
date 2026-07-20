const IMAGE_VIEWER_URI = "ui://local-dev-mcp/image-viewer.html";

export function imageViewerResourceUri(): string {
  return IMAGE_VIEWER_URI;
}

export function imageViewerMeta() {
  const publicOrigin = getPublicOrigin();
  return {
    ui: {
      resourceUri: IMAGE_VIEWER_URI,
      prefersBorder: true,
      csp: {
        connectDomains: [publicOrigin],
        resourceDomains: [publicOrigin],
      },
    },
    "openai/outputTemplate": IMAGE_VIEWER_URI,
    "openai/toolInvocation/invoking": "Loading image",
    "openai/toolInvocation/invoked": "Image loaded",
    "openai/widgetAccessible": true,
    "openai/widgetDescription": "Displays an image returned by image.read with basic file metadata.",
    "openai/widgetPrefersBorder": true,
    "openai/widgetCSP": {
      connect_domains: [publicOrigin],
      resource_domains: [publicOrigin],
    },
  };
}

export function imageViewerResource() {
  return {
    uri: IMAGE_VIEWER_URI,
    mimeType: "text/html+skybridge",
    text: imageViewerHtml(),
    _meta: imageViewerMeta(),
  };
}

function getPublicOrigin(): string {
  const configured = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through
    }
  }
  return "http://127.0.0.1:3456";
}

function imageViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --panel: #f9fafb;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111827;
        --fg: #f9fafb;
        --muted: #9ca3af;
        --border: #374151;
        --panel: #1f2937;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap {
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .image-frame {
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 8px;
      overflow: hidden;
      min-height: 120px;
      display: grid;
      place-items: center;
    }
    img {
      display: block;
      width: 100%;
      height: auto;
      max-height: min(70vh, 720px);
      object-fit: contain;
      background: var(--panel);
    }
    dl {
      margin: 0;
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 4px 10px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    dt { font-weight: 600; color: var(--fg); }
    dd { margin: 0; }
    .empty {
      padding: 24px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="image-frame" id="frame"><div class="empty">No image</div></div>
    <dl id="meta"></dl>
  </main>
  <script>
    let latestToolResult = null;

    function readToolResult() {
      if (latestToolResult) return latestToolResult;

      const bridge = window.openai || {};
      const metadata = bridge.toolResponseMetadata || {};
      const fullResult = metadata.mcp_tool_result || metadata.call_tool_result;
      if (fullResult && typeof fullResult === "object") return fullResult;

      return {
        structuredContent: bridge.toolOutput || {},
        content: [],
        _meta: metadata,
      };
    }

    function readOutput(toolResult) {
      return toolResult.structuredContent || (window.openai && window.openai.toolOutput) || {};
    }

    function findImageSource(toolResult, output) {
      const content = Array.isArray(toolResult.content) ? toolResult.content : [];
      const image = content.find((item) => {
        return item && item.type === "image" && item.data && (item.mimeType || item.mime_type);
      });
      if (image) {
        const mimeType = image.mimeType || image.mime_type;
        return {
          src: "data:" + mimeType + ";base64," + image.data,
          source: "base64",
        };
      }

      const meta = toolResult._meta || {};
      if (meta.image_data_uri) {
        return { src: meta.image_data_uri, source: "metadata" };
      }

      if (output.display_url) {
        return { src: output.display_url, source: "url" };
      }

      return null;
    }

    function render() {
      const toolResult = readToolResult();
      const output = readOutput(toolResult);
      const frame = document.getElementById("frame");
      const meta = document.getElementById("meta");
      const imageSource = findImageSource(toolResult, output);
      frame.innerHTML = "";
      if (imageSource) {
        const img = document.createElement("img");
        img.src = imageSource.src;
        img.alt = output.path || "image";
        img.onload = notifyHeight;
        img.onerror = function () {
          frame.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "Image could not be displayed.";
          frame.appendChild(empty);
          notifyHeight();
        };
        frame.appendChild(img);
      } else {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No image data was returned.";
        frame.appendChild(empty);
      }
      const rows = [
        ["Path", output.path],
        ["Type", output.mime_type],
        ["Size", output.size_bytes ? output.size_bytes + " bytes" : ""],
        ["Dimensions", output.width && output.height ? output.width + " x " + output.height : ""],
        ["Source", imageSource ? imageSource.source : ""],
        ["Expires", output.display_expires_at],
      ].filter(([, value]) => value);
      meta.innerHTML = "";
      for (const [label, value] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = String(value);
        meta.append(dt, dd);
      }
      notifyHeight();
    }
    function notifyHeight() {
      const height = document.documentElement.scrollHeight;
      if (window.openai && typeof window.openai.notifyIntrinsicHeight === "function") {
        window.openai.notifyIntrinsicHeight(height);
      }
    }
    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method !== "ui/notifications/tool-result") return;
      latestToolResult = message.params || null;
      render();
    }, { passive: true });
    window.addEventListener("openai:set_globals", render);
    render();
  </script>
</body>
</html>`;
}
