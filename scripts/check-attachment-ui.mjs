/* global window, document, createImageBitmap, File, innerWidth */
// Browser globals below are used only inside Playwright callbacks.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.HANDRAIL_ATTACHMENT_SCREENSHOT_DIR;
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}test/fixtures/attachment-ui/`);
  await page.getByRole('textbox').waitFor();
  await page.evaluate(() => { window.outerEscapeCount = 0; document.addEventListener('keydown', event => { if (event.key === 'Escape') window.outerEscapeCount += 1; }, true); });
  const measured = await page.evaluate(async () => {
    // Deterministic synthetic pixels reproduce copying a compressed photo as PNG.
    const canvas = document.createElement('canvas'); canvas.width = 2600; canvas.height = 2600;
    const ctx = canvas.getContext('2d'); const pixels = ctx.createImageData(canvas.width, canvas.height);
    let seed = 47;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255; pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const original = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.52));
    const bitmap = await createImageBitmap(original); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const clipboard = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    window.attachmentQA.paste(new File([clipboard], 'pasted-image.png', { type: 'image/png', lastModified: 123 }));
    return { originalBytes: original.size, clipboardBytes: clipboard.size, width: canvas.width, height: canvas.height };
  });
  assert.ok(measured.originalBytes < 3_000_000, JSON.stringify(measured));
  assert.ok(measured.clipboardBytes > 10 * 1024 * 1024, JSON.stringify(measured));
  await page.waitForFunction(() => window.attachmentQA.uploads.length === 1);
  await page.getByRole('button', { name: 'Send message' }).waitFor({ state: 'visible' });
  const qa = await page.evaluate(() => ({ uploads: window.attachmentQA.uploads, oldRejections: window.attachmentQA.oldRejections }));
  assert.deepEqual(qa.oldRejections, ['too_large']);
  assert.ok(qa.uploads[0].size <= 8 * 1024 * 1024);
  assert.equal(qa.uploads[0].type, 'image/jpeg');
  assert.equal(qa.uploads[0].width, measured.width); assert.equal(qa.uploads[0].height, measured.height);
  assert.equal(await page.getByRole('progressbar').count(), 0);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const trigger = page.getByRole('button', { name: 'Enlarge pasted-image.jpg' });
    await trigger.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close image preview' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    assert.equal(await page.getByRole('button', { name: 'Reset image zoom' }).textContent(), '150%');
    const geometry = await page.locator('.hr-attachment-viewer__canvas').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, image: el.querySelector('img').getBoundingClientRect().width }));
    assert.ok(geometry.scroll > geometry.client && geometry.image > geometry.client, JSON.stringify(geometry));
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/viewer-${width}.png` }); }
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    if (evidence) await page.screenshot({ path: `${evidence}/composer-${width}.png` });
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, nodes: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => ({ tag: el.tagName, className: el.className, right: el.getBoundingClientRect().right })).slice(0, 10) }));
    assert.ok(overflow.width <= overflow.viewport, JSON.stringify(overflow));
  }
  await page.getByRole('button', { name: 'Remove pasted-image.jpg' }).click();
  assert.equal(await page.getByRole('button', { name: 'Enlarge pasted-image.jpg' }).count(), 0);
  // Under-limit clipboard bytes must pass through without re-encoding.
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
    window.attachmentQA.paste(new File([blob], 'small.png', { type: 'image/png' }));
  });
  await page.waitForFunction(() => window.attachmentQA.uploads.length === 2);
  assert.equal(await page.evaluate(() => window.attachmentQA.uploads[1].type), 'image/png');
  await page.getByRole('button', { name: 'Enlarge floor-plan.png' }).click();
  await page.getByRole('dialog', { name: 'floor-plan.png image preview' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.outerEscapeCount), 0, 'Escape must not close the host chat');
  assert.deepEqual(errors, []);
  const result = { ...measured, ...qa, widths: [320, 390, 1280], checks: ['compression', 'dimensions retained', 'thumbnail', 'remove', 'modal focus', 'zoom', 'Escape', 'no horizontal overflow', 'small PNG unchanged'] };
  if (evidence) await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await server.close(); }
