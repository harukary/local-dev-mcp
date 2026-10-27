import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { navigateWithHttpBasicAuth } from "../../src/browser/http-basic-auth.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe.skipIf(!existsSync(CHROME))("live Chrome HTTP Basic challenge", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.headers.authorization !== "Basic " + Buffer.from("valid:secret").toString("base64")) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Integration Test"' });
        response.end("Authentication required");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!DOCTYPE html><title>Authenticated Browser</title><h1>Success</h1>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Unexpected server address");
    url = `http://127.0.0.1:${addr.port}/private`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });
  it("navigates the real HTTP Basic challenge without a native dialog", async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const page = await browser.newPage();
      await navigateWithHttpBasicAuth(page, url, { username: "valid", password: "secret" });
      expect(await page.title()).toBe("Authenticated Browser");
      expect(await page.locator("h1").innerText()).toBe("Success");
    } finally {
      await browser.close();
    }
  }, 25_000);
});
