import { describe, it, expect } from "vitest";
import {
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
  isMcpDebugEnabled,
  getPublicOrigin,
  getAllowedHttpHosts,
  hasExplicitHttpHostAllowlist,
  isAllowedHttpHost,
  normalizeHttpHost,
  resolveChatContextId,
  renderPassphrasePage,
  renderDownloadAuthPage,
  sanitizeRequestUrlForLog,
} from "../../src/mcp/server.js";
import { buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";
import { imageViewerMeta, imageViewerResource, imageViewerResourceUri, IMAGE_VIEWER_RESOURCE_MIME_TYPE } from "../../src/mcp/resources/image-viewer.js";

describe("resolveChatContextId", () => {
  it("uses openai/session when present", () => {
    expect(
      resolveChatContextId({
        "openai/session": "conv_123",
        "openai/subject": "user_456",
      })
    ).toBe("chatgpt-session:conv_123");
  });

  it("falls back to openai/subject when session is missing", () => {
    expect(
      resolveChatContextId({
        "openai/session": "",
        "openai/subject": "user_456",
      })
    ).toBe("chatgpt-user:user_456");
  });

  it("falls back to default when no app meta is present", () => {
    expect(resolveChatContextId(undefined)).toBe("default");
    expect(resolveChatContextId({ "openai/session": "" })).toBe("default");
  });

  it("reads the debug env gate from LOCAL_DEV_MCP_DEBUG", () => {
    const previous = process.env.LOCAL_DEV_MCP_DEBUG;
    delete process.env.LOCAL_DEV_MCP_DEBUG;
    expect(isMcpDebugEnabled()).toBe(false);
    process.env.LOCAL_DEV_MCP_DEBUG = "1";
    expect(isMcpDebugEnabled()).toBe(true);
    process.env.LOCAL_DEV_MCP_DEBUG = "0";
    expect(isMcpDebugEnabled()).toBe(false);
    if (previous === undefined) {
      delete process.env.LOCAL_DEV_MCP_DEBUG;
    } else {
      process.env.LOCAL_DEV_MCP_DEBUG = previous;
    }
  });
});

describe("OAuth helpers", () => {
  it("prefers LOCAL_DEV_MCP_PUBLIC_ORIGIN over request-derived origin", () => {
    const previous = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = "https://public.example.com/base";

    expect(
      getPublicOrigin({
        headers: {
          host: "127.0.0.1:3456",
          "x-forwarded-proto": "http",
        },
      } as never)
    ).toBe("https://public.example.com");

    if (previous === undefined) {
      delete process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    } else {
      process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = previous;
    }
  });

  it("allows localhost and ChatGPT connector redirect URIs", () => {
    expect(isAllowedRedirectUri("http://localhost/redirect")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:3000/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://chat.openai.com/connector/oauth/callback")).toBe(true);
  });

  it("rejects unknown external redirect origins", () => {
    expect(isAllowedRedirectUri("https://evil.example.com/callback")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });

  it("matches redirect URIs against registered client data", () => {
    const client = {
      redirect_uris: [
        "http://localhost/redirect",
        "https://chatgpt.com/connector/oauth/callback-123",
      ],
    };

    expect(isRegisteredRedirectUri("http://localhost/redirect", client)).toBe(true);
    expect(isRegisteredRedirectUri("https://chatgpt.com/connector/oauth/callback-123", client)).toBe(true);
    expect(isRegisteredRedirectUri("https://chatgpt.com/connector/oauth/callback-456", client)).toBe(false);
  });

  it("escapes hidden passphrase form inputs", () => {
    const html = renderPassphrasePage(
      new URLSearchParams([
        ["client_id", `x" onfocus="alert(1)`],
        ["state", `<script>alert('x')</script>`],
        ["passphrase", "secret"],
      ])
    );

    expect(html).toContain('name="client_id"');
    expect(html).toContain('method="POST"');
    expect(html).toContain("x&quot; onfocus=&quot;alert(1)");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('x')</script>");
  });

  it("renders a link-bound download authentication form", () => {
    const html = renderDownloadAuthPage("link-123", "challenge-456");
    expect(html).toContain('action="/download-auth"');
    expect(html).toContain('name="link" value="link-123"');
    expect(html).toContain('name="challenge" value="challenge-456"');
    expect(html).not.toContain("Bearer");
  });

  it("redacts passphrases from request URLs before logging", () => {
    expect(sanitizeRequestUrlForLog("/authorize?client_id=x&passphrase=secret&state=y")).toBe(
      "/authorize?client_id=x&passphrase=%5BREDACTED%5D&state=y"
    );
  });
});

describe("HTTP host allowlist helpers", () => {
  it("normalizes host headers and origins", () => {
    expect(normalizeHttpHost("Public.Example.com:443")).toBe("public.example.com");
    expect(normalizeHttpHost("https://Tunnel.Example.com/path")).toBe("tunnel.example.com");
    expect(normalizeHttpHost("")).toBeNull();
  });

  it("allows localhost and configured public hosts", () => {
    const previousPublicOrigin = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    const previousAllowedHosts = process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS;
    process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = "https://public.example.com/base";
    process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS = "extra.example.com, https://second.example.com/path";

    expect(getAllowedHttpHosts()).toEqual(expect.arrayContaining([
      "localhost",
      "127.0.0.1",
      "public.example.com",
      "extra.example.com",
      "second.example.com",
    ]));
    expect(isAllowedHttpHost("public.example.com")).toBe(true);
    expect(isAllowedHttpHost("extra.example.com:443")).toBe(true);
    expect(isAllowedHttpHost("evil.example.com")).toBe(false);

    if (previousPublicOrigin === undefined) {
      delete process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    } else {
      process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = previousPublicOrigin;
    }
    if (previousAllowedHosts === undefined) {
      delete process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS;
    } else {
      process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS = previousAllowedHosts;
    }
  });

  it("does not enforce an external host allowlist until one is configured", () => {
    const previousPublicOrigin = process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    const previousAllowedHosts = process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS;
    delete process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    delete process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS;

    expect(hasExplicitHttpHostAllowlist()).toBe(false);
    expect(isAllowedHttpHost("ephemeral.example.com")).toBe(true);

    if (previousPublicOrigin === undefined) {
      delete process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN;
    } else {
      process.env.LOCAL_DEV_MCP_PUBLIC_ORIGIN = previousPublicOrigin;
    }
    if (previousAllowedHosts === undefined) {
      delete process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS;
    } else {
      process.env.LOCAL_DEV_MCP_ALLOWED_HOSTS = previousAllowedHosts;
    }
  });
});

describe("tool schema snapshot", () => {
  it("exposes runtime tool definitions with shell.run annotations", () => {
    const snapshot = buildToolSchemaSnapshot();
    const shellRun = snapshot.tools.find((tool) => tool.name === "shell.run");
    const imageRead = snapshot.tools.find((tool) => tool.name === "image.read");
    const imageShow = snapshot.tools.find((tool) => tool.name === "image.show");
    const downloadLink = snapshot.tools.find((tool) => tool.name === "download.link");
    const skillsList = snapshot.tools.find((tool) => tool.name === "skills.list");
    const skillsRead = snapshot.tools.find((tool) => tool.name === "skills.read");

    expect(snapshot.schema_version).toMatch(/^\d{4}-\d{2}-\d{2}\./);
    expect(snapshot.tools.some((tool) => tool.name === "tool.schema")).toBe(true);
    expect(downloadLink?.inputSchema).toMatchObject({
      type: "object",
      required: ["path"],
    });
    expect(downloadLink?.description).toContain("passphrase authentication screen");
    expect(skillsList?.annotations).toMatchObject({ readOnlyHint: true });
    expect(skillsRead?.inputSchema).toMatchObject({
      type: "object",
      required: ["path"],
    });
    expect(imageRead?._meta).toBeUndefined();
    expect(imageShow?._meta).toMatchObject({
      ui: { resourceUri: imageViewerResourceUri() },
      "openai/outputTemplate": imageViewerResourceUri(),
      "openai/widgetAccessible": true,
    });
    for (const name of ["browser.click", "browser.open", "mobile.screenshot", "mobile.tap"]) {
      expect(snapshot.tools.find((tool) => tool.name === name)?._meta).toBeUndefined();
    }
    expect(shellRun?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(shellRun?.inputSchema).toMatchObject({
      properties: {
        credential_scope: {
          enum: ["bitwarden"],
        },
      },
    });
  });
});

describe("image viewer resource", () => {
  it("exposes the MCP Apps image viewer for image.show output", () => {
    const resource = imageViewerResource();

    expect(resource.uri).toBe("ui://local-dev-mcp/image-viewer-v2.html");
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.mimeType).toBe(IMAGE_VIEWER_RESOURCE_MIME_TYPE);
    expect(resource.text).toContain('document.createElement("img")');
    expect(resource.text).toContain("ui/notifications/tool-result");
    expect(resource.text).toContain('item.type === "image"');
    expect(resource.text).toContain('"data:" + mimeType + ";base64," + image.data');
    expect(resource._meta).toMatchObject({
      ui: {
        visibility: ["model", "app"],
        prefersBorder: true,
        csp: {
          resourceDomains: expect.arrayContaining([expect.stringMatching(/^https?:\/\//)]),
        },
      },
      "openai/widgetDescription": expect.stringContaining("image.show"),
      "openai/widgetPrefersBorder": true,
      "openai/outputTemplate": imageViewerResourceUri(),
      "openai/widgetAccessible": true,
    });
    expect(resource._meta["openai/widgetCSP"]).toMatchObject({
      resource_domains: expect.arrayContaining([expect.stringMatching(/^https?:\/\//)]),
    });
  });

  it("uses the same widget metadata for tool descriptors and invocation results", () => {
    expect(imageViewerMeta()).toMatchObject({
      ui: { resourceUri: imageViewerResourceUri() },
      "openai/outputTemplate": imageViewerResourceUri(),
      "openai/toolInvocation/invoking": "Loading image",
      "openai/toolInvocation/invoked": "Image loaded",
      "openai/widgetAccessible": true,
    });
  });
});
