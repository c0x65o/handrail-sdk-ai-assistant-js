/* global document, innerWidth -- Playwright callbacks execute in the browser. */
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
  build: { write: false, lib: { entry: fileURLToPath(new URL("../test/fixtures/activity-browser.tsx", import.meta.url)),
    name: "ActivityFixture", formats: ["iife"] } } });
const code = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output)
  .find(output => output.type === "chunk").code;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
  response.end(request.url === "/app.js" ? code : '<style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  const captures = process.env.HANDRAIL_ACTIVITY_SCREENSHOT_DIR;
  if (captures) await mkdir(captures, { recursive: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const status = page.getByRole("region", { name: "Current request" });
    await status.getByText("Thinking…", { exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.getByText("Thinking…", { exact: true }).count(), 1);
    assert.equal(await page.locator(".hr-activity").count(), 0);
    assert.equal(await page.getByText("Working…", { exact: true }).count(), 0);
    if (captures) await page.screenshot({ path: `${captures}/activity-${width}-thinking.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    const group = page.locator("details.hr-activity");
    assert.equal(await group.count(), 1);
    assert.equal(await group.getAttribute("open"), null);
    await status.getByText("Working…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Working…", { exact: true }).count(), 1);
    await group.locator("summary").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("details.hr-activity").open);
    await page.locator("textarea").fill("Keep this draft");
    await page.getByRole("button", { name: "Writing", exact: true }).click();
    await status.getByText("Writing response…", { exact: true }).waitFor();
    assert.equal(await page.getByText("Writing response…", { exact: true }).count(), 1);
    assert.notEqual(await group.getAttribute("open"), null);
    assert.equal(await page.locator("textarea").inputValue(), "Keep this draft");
    const geometry = await page.evaluate(() => {
      const card = document.querySelector(".hr-activity");
      const detail = card.querySelector(".hr-activity__details");
      const transcript = document.querySelector(".hr-chat__transcript");
      const composer = document.querySelector("textarea");
      const status = document.querySelector(".hr-chat__request-status");
      return { width: innerWidth, scroll: document.documentElement.scrollWidth,
        detailHeight: detail.clientHeight, detailScroll: detail.scrollHeight,
        transcriptWidth: transcript.clientWidth, wrapperWidth: transcript.parentElement.clientWidth,
        userRight: document.querySelector('[aria-label="user message"]').getBoundingClientRect().right, rowRight: document.querySelector(".hr-chat__message-row").getBoundingClientRect().right,
        inline: transcript.contains(card), fixedStatus: !transcript.contains(status),
        statusBottom: status.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top,
        composerBottom: composer.getBoundingClientRect().bottom };
    });
    assert.ok(Math.abs(geometry.userRight - geometry.rowRight) < 2, JSON.stringify(geometry));
    assert.ok(geometry.inline && geometry.scroll <= width && geometry.detailHeight <= 256 && geometry.detailScroll > geometry.detailHeight, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.wrapperWidth - geometry.transcriptWidth) <= 20 && geometry.composerBottom <= 844, JSON.stringify(geometry));
    assert.ok(geometry.fixedStatus && geometry.statusBottom <= geometry.composerTop, JSON.stringify(geometry));
    await page.locator(".hr-chat__transcript").evaluate(element => { element.scrollTop = 0; });
    assert.ok(await status.isVisible());
    assert.equal(await page.getByText("DO_NOT_RENDER", { exact: false }).count(), 0);
    if (captures) await page.screenshot({ path: `${captures}/activity-${width}-expanded.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await page.getByText("Activity complete", { exact: true }).waitFor();
    assert.notEqual(await group.getAttribute("open"), null);
    assert.equal(await status.getAttribute("data-phase"), "complete");
    assert.equal(await page.locator(".hr-activity__dots").count(), 0);
    await group.locator("summary").click();
    await page.waitForFunction(() => !document.querySelector("details.hr-activity").open);
    if (captures) await page.screenshot({ path: `${captures}/activity-${width}-complete.png`, animations: "disabled" });
    console.log(`${width}px: inline grouping, keyboard expansion, live writing/completion, stable disclosure, bounded detail, draft and geometry passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
