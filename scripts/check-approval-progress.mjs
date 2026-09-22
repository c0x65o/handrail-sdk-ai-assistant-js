import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";
import { build } from "vite";
import { chromium } from "playwright";

// Synthetic SDK UI qualification; no app login, provider calls, or business writes.
const result = await build({ configFile: false, logLevel: "error",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: { write: false, lib: { entry: fileURLToPath(new URL("../test/fixtures/approval-progress-browser.tsx", import.meta.url)),
    name: "ApprovalFixture", formats: ["iife"] } } });
const code = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output).find(output => output.type === "chunk").code;
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
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  const captures = process.env.HANDRAIL_APPROVAL_SCREENSHOT_DIR;
  if (captures) await mkdir(captures, { recursive: true });
  for (const width of [390, 667, 1280]) {
    await page.setViewportSize({ width, height: 615 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const status = page.getByRole("region", { name: "Current request" });
    await status.getByText("2 actions need your review.", { exact: true }).waitFor();
    await page.locator("textarea").fill("Keep my draft");
    await page.locator(".hr-chat__transcript").evaluate(node => { node.scrollTop = 0; });
    const geometry = await status.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const transcript = globalThis.document.querySelector(".hr-chat__transcript");
      const composer = globalThis.document.querySelector("textarea").getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: globalThis.innerHeight, composerTop: composer.top,
        scrollWidth: globalThis.document.documentElement.scrollWidth, outsideTranscript: !transcript.contains(node),
        transcriptOverflow: transcript.scrollHeight > transcript.clientHeight };
    });
    assert.ok(geometry.outsideTranscript && geometry.transcriptOverflow && geometry.top >= 0
      && geometry.bottom <= geometry.composerTop && geometry.bottom <= geometry.viewport
      && geometry.scrollWidth <= width, JSON.stringify(geometry));
    await status.getByRole("button", { name: "Review next" }).click();
    assert.equal(await page.locator('[data-pending-approval="true"]').first().evaluate(node => globalThis.document.activeElement === node), true);
    if (captures) await page.screenshot({ path: `${captures}/approvals-${width}-waiting.png` });
    await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
    await status.getByText("Saving approval decision…").waitFor();
    await status.getByText("1 action needs your review.", { exact: true }).waitFor();
    await status.getByRole("button", { name: "Review next" }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await status.getByText("Continuing…").waitFor();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await status.getByText("Working…", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Approval settings" }).click();
    assert.equal(await page.getByRole("switch").isEnabled(), true);
    await page.getByRole("switch").check();
    assert.equal(await page.getByRole("switch").isChecked(), true);
    if (captures) await page.screenshot({ path: `${captures}/approvals-${width}-working.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Next approval", exact: true }).click();
    await status.getByText("Waiting for approval", { exact: true }).waitFor();
    await status.getByRole("button", { name: "Review next" }).click();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await status.getByText("Continuing…").waitFor();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await status.getByText("Request complete", { exact: true }).waitFor();
    assert.equal(await status.getAttribute("data-phase"), "complete");
    assert.equal(await page.locator("textarea").inputValue(), "Keep my draft");
    if (captures) await page.screenshot({ path: `${captures}/approvals-${width}-complete.png` });
    console.log(`${width}px: status stays visible while scrolling; sequential approvals, saving, continuation, next approval, completion, auto-approve, and draft retention passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
