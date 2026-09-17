import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

// Synthetic SDK component fixture only; never an application/preview login.
const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
  server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
await server.listen();
let browser;
const failures = [];
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", error => failures.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}test/fixtures/display-window-browser.html`);
  await page.waitForFunction(() => globalThis.fixture?.controller.getSnapshot().status === "ready");
  assert.equal(await page.locator("[data-display-message]").count(), 20);
  assert.equal(await page.evaluate(() => globalThis.fixture.requests.length), 1);
  const position = () => page.evaluate(() => {
    const viewport = globalThis.document.getElementById("transcript"), top = viewport.getBoundingClientRect().top;
    const item = [...viewport.querySelectorAll("[data-display-message]")].find(item => item.getBoundingClientRect().bottom > top);
    return { id: item.dataset.displayMessage, offset: item.getBoundingClientRect().top - top };
  });
  await page.locator("#transcript").evaluate(element => { element.scrollTop = 320; });
  await page.waitForTimeout(100);
  const before = await position();
  await page.getByRole("button", { name: "Load older messages" }).evaluate(button => button.click());
  await page.waitForFunction(() => globalThis.fixture.controller.getSnapshot().records.length === 40);
  await page.waitForTimeout(100);
  const after = await position();
  assert.equal(after.id, before.id, JSON.stringify({ before, after }));
  assert.ok(Math.abs(after.offset - before.offset) <= 2, JSON.stringify({ before, after }));
  // Image/Markdown layout can grow a preceding bubble after the page has rendered.
  await page.locator("[data-display-message]").first().evaluate(item => { item.style.paddingBottom = "300px"; });
  await page.waitForTimeout(150);
  const resized = await position();
  assert.equal(resized.id, after.id, JSON.stringify({ after, resized }));
  assert.ok(Math.abs(resized.offset - after.offset) <= 2, JSON.stringify({ after, resized }));
  for (let index = 0; index < 6; index++) {
    const version = await page.evaluate(() => globalThis.fixture.controller.getSnapshot().version);
    await page.getByRole("button", { name: "Load older messages" }).evaluate(button => button.click());
    await page.waitForFunction(version => globalThis.fixture.controller.getSnapshot().version > version, version);
    assert.ok(await page.locator("[data-display-message]").count() <= 60);
  }
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await page.waitForFunction(() => globalThis.fixture.controller.getSnapshot().records.at(-1)?.id === "message-1000");
  await page.getByRole("button", { name: "Slow chat" }).click();
  await page.getByRole("button", { name: "Fast chat" }).click();
  await page.waitForFunction(() => globalThis.fixture.controller.getSnapshot().conversationId === "fast" && globalThis.fixture.controller.getSnapshot().status === "ready");
  await page.waitForTimeout(600);
  assert.equal(await page.locator("#transcript").getByText(/^slow:/).count(), 0);
  assert.equal(await page.evaluate(() => globalThis.fixture.controller.getSnapshot().conversationId), "fast");
  assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
  await page.getByRole("log", { name: "Conversation transcript" }).focus();
  assert.equal(await page.evaluate(() => globalThis.document.activeElement.id), "transcript");
  await page.getByRole("button", { name: "Large chat" }).click();
  await page.getByRole("button", { name: "Read message", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.fixture.contentRequests.length), 0);
  await page.getByRole("button", { name: "Read message", exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelector('[aria-label="Message text part"]')?.textContent ?? '').length === 8192);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Next part", exact: true }).click();
  await page.getByText("Last part of the large message.", { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="Message text part"]').count(), 1);
  await page.getByRole("button", { name: "Previous part", exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelector('[aria-label="Message text part"]')?.textContent ?? '').length === 8192);
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.contentRequests.map(input => input.offset)), [0, 8192, 0]);
  await page.getByRole("button", { name: "Close message", exact: true }).click();
  assert.equal(await page.locator('[aria-label="Message text part"]').count(), 0);
  // Separate frontend metrics: synthetic page reads, no production HTTP or database timing.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
  const frontend = [];
  for (const messages of [200, 1000]) {
    await page.evaluate(messages => { globalThis.fixture.setTotal(messages); globalThis.fixture.setDelay(0); globalThis.fixture.requests.length = 0; }, messages);
    const beforeMetrics = await metrics(), samples = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      samples.push(await page.evaluate(async id => {
        const start = globalThis.performance.now(); globalThis.fixture.setConversation(id);
        for (;;) {
          await new Promise(globalThis.requestAnimationFrame);
          const state = globalThis.fixture.controller.getSnapshot();
          if (state.conversationId === id && state.status === "ready" && globalThis.document.getElementById("transcript").textContent.includes(`${id}:`)) break;
        }
        await new Promise(globalThis.requestAnimationFrame);
        return globalThis.performance.now() - start;
      }, `bench-${messages}-${iteration}`));
    }
    const afterMetrics = await metrics();
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await metrics();
    const retained = await page.evaluate(() => ({ records: globalThis.fixture.controller.getSnapshot().records.length,
      bytes: globalThis.fixture.controller.getSnapshot().retainedBytes, requests: globalThis.fixture.requests.length,
      domMessages: globalThis.document.querySelectorAll("[data-display-message]").length }));
    assert.equal(retained.requests, 12); assert.equal(retained.domMessages, 20); assert.equal(retained.records, 20);
    samples.sort((a, b) => a - b);
    assert.ok(samples.at(-1) < 1000, "Synthetic selection exceeded its 1s smoke-test ceiling");
    frontend.push({ sourceMessages: messages, samples: samples.length, selectionToPaintP50Ms: samples[5],
      selectionToPaintP95Ms: samples[11], scriptMeanMs: (afterMetrics.ScriptDuration - beforeMetrics.ScriptDuration) * 1000 / 12,
      layoutMeanMs: (afterMetrics.LayoutDuration - beforeMetrics.LayoutDuration) * 1000 / 12,
      browserHeapAfterGcBytes: heap.JSHeapUsedSize, ...retained });
  }
  await cdp.detach();
  assert.deepEqual(failures, []);
  const report = { browser: "Chromium", viewport: 390, initialRequests: 1, initialMessages: 20,
    maximumRenderedMessages: 60, prependAnchorDriftPixels: Math.abs(after.offset - before.offset),
    delayedLayoutAnchorDriftPixels: Math.abs(resized.offset - after.offset),
    switchCancellation: "passed", keyboardFocus: "passed", responsiveWidth: "passed",
    largeMessageText: { automaticReads: 0, maximumRetainedCharacters: 8192, navigation: "passed", responsiveWidth: "passed" }, frontend,
    limitation: "Synthetic SDK component with direct page fixtures; React development build. Browser heap includes Vite/React. Does not measure HTTP, production data, model streaming or Flutter rendering." };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.HANDRAIL_DISPLAY_BROWSER_REPORT) await writeFile(process.env.HANDRAIL_DISPLAY_BROWSER_REPORT, JSON.stringify(report, null, 2) + "\n");
} finally { await browser?.close(); await server.close(); }
