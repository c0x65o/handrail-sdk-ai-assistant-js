/* global document */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = await build({ configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  build: { write: false, lib: { entry: fileURLToPath(new URL('../test/fixtures/launcher-polling-browser.tsx', import.meta.url)),
    name: 'LauncherPollingFixture', formats: ['iife'] } } });
const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code;
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/app.js' ? code : '<div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.clock.install({ time: new Date('2026-10-06T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-06T00:00:01Z'));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const ready = async () => {
    // Browser timers are paused; use the runner's clock to wait for React work.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await page.evaluate(() => document.querySelector('[data-display-message]') &&
        globalThis.pollingFixture.snapshot()?.loading === false)) return;
      await setTimeout(20);
    }
    throw new Error(JSON.stringify({ errors, state: await page.evaluate(() => ({
      text: document.body.textContent, snapshot: globalThis.pollingFixture?.snapshot(), reads: globalThis.pollingFixture?.gateway.reads,
    })) }));
  };
  const count = operation => page.evaluate(operation => globalThis.pollingFixture.gateway.count(operation), operation);
  const configure = async settings => { await page.evaluate(settings => globalThis.pollingFixture.configure(settings), settings); await ready(); };
  const interval = async (operation, milliseconds) => {
    const before = await count(operation);
    await page.clock.runFor(milliseconds - 1); assert.equal(await count(operation), before, `${operation}: no early read`);
    await page.clock.runFor(1); assert.equal(await count(operation), before + 1, `${operation}: configured interval`);
  };
  await ready();
  await page.clock.runFor(1000); // Settle startup refreshes.
  await interval('control', 1000);
  await page.clock.runFor(3000);
  assert.equal(await count('activity'), 2, 'Default activity interval remains 5000ms');
  await page.evaluate(() => globalThis.pollingFixture.uncertainSend());
  assert.equal(await page.evaluate(() => globalThis.pollingFixture.snapshot().hasPendingSubmission), true);
  await configure({ synchronizationPollingMilliseconds: 3000, idleSynchronizationPollingMilliseconds: 9000,
    activityPollingMilliseconds: 7000 });
  assert.equal(await page.evaluate(() => globalThis.pollingFixture.snapshot().hasPendingSubmission), true);
  await page.evaluate(() => globalThis.pollingFixture.retry());
  const admissions = await page.evaluate(() => globalThis.pollingFixture.gateway.admissions);
  assert.equal(admissions.length, 2); assert.deepEqual(admissions[1], admissions[0], 'Timing rebind must replay the exact pending admission');
  await page.clock.runFor(3000);
  await interval('control', 3000);
  const activity = await count('activity');
  await page.clock.runFor(999); assert.equal(await count('activity'), activity);
  await page.clock.runFor(1); assert.equal(await count('activity'), activity + 1);
  await page.evaluate(() => globalThis.pollingFixture.configure({ visible: false }));
  // Hidden display sessions unload their window and poll only control at the idle interval.
  const changes = await count('changes');
  await interval('control', 9000);
  assert.equal(await count('changes'), changes);
  await configure({ visible: true });
  await page.clock.runFor(3000);
  await page.evaluate(() => { globalThis.pollingFixture.gateway.throttle.add('control'); });
  await page.clock.runFor(3000);
  const throttled = await count('control');
  await page.clock.runFor(19999); assert.equal(await count('control'), throttled, 'Retry-After prevents early polling');
  await page.clock.runFor(1); assert.equal(await count('control'), throttled + 1);
  assert.equal(await page.locator('[activitypollingmilliseconds], [synchronizationpollingmilliseconds], [idlesynchronizationpollingmilliseconds]').count(), 0);
  await page.evaluate(() => globalThis.pollingFixture.dispose());
  const stopped = await page.evaluate(() => globalThis.pollingFixture.gateway.reads.length);
  await page.clock.runFor(30000);
  assert.equal(await page.evaluate(() => globalThis.pollingFixture.gateway.reads.length), stopped);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', boundary: 'Built public launcher in Chromium; deterministic clock; synthetic fetch; no providers or database',
    checks: ['default cadence', 'all three intervals', 'visible idle', 'hidden idle', 'pending admission identity across timing rebind', 'Retry-After minimum', 'no DOM props or React errors', 'unmount stops reads'] }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
