import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { clickElement, fillElement, readAccessibilitySnapshot, readDomElement, withBrowserPage, closeBrowserConnections } from "../../src/browser/interaction.js";
import { withCdpClient, closeCdpClients } from "../../src/browser/cdp-client.js";

it("uses the selected live Chrome target, iframe and shadow locators, and disconnects without closing Chrome", async () => {
  const directory = await mkdtemp(join(dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!), "chrome-"));
  const context = await chromium.launchPersistentContext(directory, { channel: "chrome", headless: true, args: ["--remote-debugging-port=0"] });
  try {
    const page = await context.newPage();
    await page.setContent('<input aria-label="Name"><button onclick="this.textContent=\'Done\'">Submit</button><iframe srcdoc="<input id=field>"></iframe><div id=host></div>');
    await page.evaluate(() => { document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = '<input id="shadow">'; });
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const port = Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    await withBrowserPage(port, targetInfo.targetId, async selected => {
      await fillElement(selected, { selector: "input[aria-label=Name]", text: "sample" });
      await fillElement(selected, { frame: "iframe", selector: "#field", text: "frame" });
      await fillElement(selected, { selector: "#shadow", text: "shadow" });
      const snapshot = await readAccessibilitySnapshot(selected, { selector: "body" });
      expect(snapshot).toContain("button \"Submit\"");
      const frameSnapshot = await readAccessibilitySnapshot(selected, { selector: "body", frame: "iframe" });
      expect(frameSnapshot).toContain("textbox");
      const shadowSnapshot = await readAccessibilitySnapshot(selected, { selector: "#host" });
      expect(shadowSnapshot).toContain("textbox");
      const frameDom = await readDomElement(selected, { selector: "#field", frame: "iframe", mode: "html", maxBytes: 100 });
      expect(frameDom.found).toBe(true);
      expect(frameDom.outerHTML).toContain("field");
      await selected.evaluate(() => {
        const node = document.createElement("div");
        node.id = "large";
        node.textContent = "日本語😀".repeat(30_000);
        document.body.appendChild(node);
      });
      const bounded = await readDomElement(selected, { selector: "#large", mode: "both", maxBytes: 80 });
      expect(bounded.found).toBe(true);
      expect(bounded.truncated).toBe(true);
      expect(Buffer.byteLength(bounded.outerText ?? "")).toBeLessThanOrEqual(80);
      expect(Buffer.byteLength(bounded.outerHTML ?? "")).toBeLessThanOrEqual(80);
      expect(bounded.outerText).not.toContain("�");
      const missing = await readDomElement(selected, { selector: "#missing", mode: "text", maxBytes: 80 });
      expect(missing.found).toBe(false);
      await clickElement(selected, { selector: "role=button[name=Submit]" });
    });
    expect(await page.locator("input[aria-label=Name]").inputValue()).toBe("sample");
    expect(await page.frameLocator("iframe").locator("#field").inputValue()).toBe("frame");
    expect(await page.locator("#shadow").inputValue()).toBe("shadow");
    expect(await page.locator("button").textContent()).toBe("Done");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
    const target = targets.find(item => item.id === targetInfo.targetId)!;
    const capture = await withCdpClient(target.webSocketDebuggerUrl, client => client.send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: 0, y: 0, width: 100, height: 80, scale: 2 } }));
    const png = Buffer.from(capture.data, "base64");
    expect(png.readUInt32BE(16)).toBe(200);
    expect(png.readUInt32BE(20)).toBe(160);
    await closeBrowserConnections();
    expect(await page.locator("button").textContent()).toBe("Done");
  } finally {
    closeCdpClients();
    await closeBrowserConnections();
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
