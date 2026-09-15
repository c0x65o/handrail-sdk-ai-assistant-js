import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { build } from "vite";
import { chromium } from "playwright";

// Built SDK component qualification; no application login, provider, or business data.
const result = await build({ configFile: false, logLevel: "error",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { write: false, lib: { entry: fileURLToPath(new URL("../test/fixtures/single-conversation-browser.tsx", import.meta.url)),
    name: "SingleConversationFixture", formats: ["iife"] } } });
const code = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output)
  .find(output => output.type === "chunk").code;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html");
  response.end(request.url === "/app.js" ? code : '<style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const captures = process.env.HANDRAIL_SINGLE_SCREENSHOT_DIR;
  if (captures) await mkdir(captures, { recursive: true });
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText("Your saved conversation is ready.").waitFor();
    assert.equal(await page.getByText("Hidden legacy title").count(), 0);
    assert.equal(await page.getByRole("button", { name: "New", exact: true }).count(), 0);
    assert.equal(await page.getByRole("complementary", { name: "Conversation history" }).count(), 0);
    const draft = page.locator("textarea");
    await draft.fill("Preserve my draft");
    await page.getByRole("button", { name: "Clear conversation", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Your saved conversation is ready.").waitFor();
    await page.getByRole("button", { name: "Clear conversation", exact: true }).click();
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      clearBottom: [...document.querySelectorAll("button")].find(b => b.textContent === "Clear").getBoundingClientRect().bottom,
      composerBottom: document.querySelector("textarea").getBoundingClientRect().bottom, height: innerHeight }));
    assert.ok(geometry.scroll <= geometry.width && geometry.clearBottom <= geometry.height && geometry.composerBottom <= geometry.height, JSON.stringify(geometry));
    if (captures) await page.screenshot({ path: `${captures}/single-confirm-${width}.png` });
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByText("Your saved conversation is ready.").waitFor({ state: "hidden" });
    assert.equal(await draft.inputValue(), "Preserve my draft");
    if (captures) await page.screenshot({ path: `${captures}/single-cleared-${width}.png` });
    console.log(`${width}px: no threads/title; confirmation, cancel, reset, draft and geometry passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
