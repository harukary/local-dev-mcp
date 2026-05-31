import { describe, it, expect } from "vitest";
import {
  isAllowedRedirectUri,
  isRegisteredRedirectUri,
  isMcpDebugEnabled,
  getPublicOrigin,
  resolveChatContextId,
  renderPassphrasePage,
  sanitizeRequestUrlForLog,
} from "../../src/mcp/server.js";
import { buildToolSchemaSnapshot } from "../../src/mcp/tool-definitions.js";
import { imageViewerMeta, imageViewerResource, imageViewerResourceUri } from "../../src/mcp/resources/image-viewer.js";

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

  it("redacts passphrases from request URLs before logging", () => {
    expect(sanitizeRequestUrlForLog("/authorize?client_id=x&passphrase=secret&state=y")).toBe(
      "/authorize?client_id=x&passphrase=%5BREDACTED%5D&state=y"
    );
  });
});

describe("tool schema snapshot", () => {
  it("exposes runtime tool definitions with shell.run annotations", () => {
    const snapshot = buildToolSchemaSnapshot();
    const shellRun = snapshot.tools.find((tool) => tool.name === "shell.run");
    const imageRead = snapshot.tools.find((tool) => tool.name === "image.read");

    expect(snapshot.schema_version).toMatch(/^\d{4}-\d{2}-\d{2}\./);
    expect(snapshot.tools.some((tool) => tool.name === "tool.schema")).toBe(true);
    expect(imageRead?._meta).toMatchObject({
      ui: { resourceUri: imageViewerResourceUri() },
      "openai/outputTemplate": imageViewerResourceUri(),
      "openai/widgetAccessible": true,
    });
    expect(shellRun?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

describe("image viewer resource", () => {
  it("exposes an Apps SDK HTML component for image.read output", () => {
    const resource = imageViewerResource();

    expect(resource.uri).toBe("ui://local-dev-mcp/image-viewer.html");
    expect(resource.mimeType).toBe("text/html+skybridge");
    expect(resource.text).toContain('document.createElement("img")');
    expect(resource._meta).toMatchObject({
      ui: {
        prefersBorder: true,
        csp: {
          resourceDomains: expect.arrayContaining([expect.stringMatching(/^https?:\/\//)]),
        },
      },
      "openai/widgetDescription": expect.stringContaining("image.read"),
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
