/* global document, requestAnimationFrame, window */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

// Production public SDK build, real browser layout, synthetic read-only data.
const output = await build({ configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { write: false, lib: { entry: fileURLToPath(new URL('../test/fixtures/settled-transcript-browser.tsx', import.meta.url)),
    name: 'SettledTranscriptFixture', formats: ['iife'] } } });
const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(req.url === '/app.js' ? code : '<div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#paged [data-display-message]').last().waitFor();
  await page.locator('summary').click();
  await page.getByText('Update a vehicle or boat · Executed').waitFor({ timeout: 3000 });
  await page.locator('summary').click();
  await page.reload();
  await page.locator('#paged [data-display-message]').last().waitFor();
  assert.equal(await page.getByText('Update a vehicle or boat · Executed').count(), 0);
  const evidence = [];
  for (const id of ['full', 'paged']) {
    const samples = await page.evaluate(async id => {
      const root = document.getElementById(id), port = root.querySelector('[aria-label="Conversation transcript"]');
      const frame = () => new Promise(requestAnimationFrame);
      const visible = () => Boolean(root.querySelector('.hr-chat__jump'));
      await frame();
      // Establish paused state before testing whether an already-visible control churns.
      port.scrollTop = port.scrollHeight - port.clientHeight - 90; await frame(); await frame();
      const values = [visible()];
      for (const distance of [73, 71, 65, 63, 49, 47, 20, 5]) {
        port.scrollTop = port.scrollHeight - port.clientHeight - distance; await frame(); values.push(visible());
      }
      for (let i = 0; i < 6; i++) {
        window.streamFrame(); port.style.height = `${400 + (i % 2) * 80}px`;
        for (let n = 0; n < 3; n++) { await frame(); values.push(visible()); }
      }
      root.querySelector('.hr-chat__jump').click();
      for (let n = 0; n < 30; n++) await frame();
      return { awayFrames: values, jumpHidden: !visible(), distance: port.scrollHeight - port.clientHeight - port.scrollTop };
    }, id);
    assert.ok(samples.awayFrames.every(Boolean), `${id}: jump flickered while away`);
    assert.ok(samples.jumpHidden && Math.abs(samples.distance) <= 2, `${id}: jump did not reach latest`);
    const pinned = await page.evaluate(async id => {
      const root = document.getElementById(id), port = root.querySelector('[aria-label="Conversation transcript"]');
      const values = [];
      for (let i = 0; i < 8; i++) {
        window.streamFrame(); port.style.height = `${300 + (i % 2) * 100}px`;
        for (let n = 0; n < 3; n++) { await new Promise(requestAnimationFrame); values.push(Boolean(root.querySelector('.hr-chat__jump'))); }
      }
      return values;
    }, id);
    assert.ok(pinned.every(value => !value), `${id}: jump flashed while following`);
    evidence.push({ surface: id, awayFrames: samples.awayFrames.length, pinnedFrames: pinned.length, tailDistance: samples.distance });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', environment: 'Chromium, synthetic data, production SDK/Vite build', historyReload: 'collapsed', evidence }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
