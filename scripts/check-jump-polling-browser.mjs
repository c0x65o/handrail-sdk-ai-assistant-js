/* global document, getComputedStyle, performance, requestAnimationFrame */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium } from 'playwright';
import { APPLICATION_GATEWAY_PROTOCOL_VERSION } from '../dist/client/index.js';

const output = await build({ configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { write: false, lib: { entry: fileURLToPath(new URL('../test/fixtures/jump-polling-browser.tsx', import.meta.url)),
    name: 'JumpPollingFixture', formats: ['iife'] } } });
const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code;
const requests = [], errors = [], evidence = [];
let count = 100, revision = 100, changed = [], failNext = false;
const disabled = { supported: false, reason: 'not_implemented' };
const descriptor = id => ({ conversationId: id, title: id, lifecycle: 'active', archivedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', version: 1, metadata: {} });
const record = (id, rev = id) => ({ kind: 'message', id: `m${id}`, turnId: null, revision: rev, bytes: 400, deferred: false,
  value: { message_id: `m${id}`, role: 'assistant', attachments: [], attribution: null, created_at: null,
    content: [{ type: 'text', text: `Message ${id} revision ${rev}. ` + 'Synthetic read-only conversation. '.repeat(12) }] } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/api/')) {
      res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      res.end(req.url === '/app.js' ? code : '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/app.js"></script>');
      return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const input = body.input ?? body;
    const entry = { path: req.url, operation: body.operation, input, started: Date.now() }; requests.push(entry);
    let value;
    if (req.url.endsWith('/capabilities')) value = { protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION,
      authoritativeCancellation: false, attachments: false, presence: false, activity: false, synchronization: false,
      resources: { conversations: { rename: disabled, clear: disabled, archive: disabled, restore: disabled, permanentDelete: disabled }, approvals: false, titleGeneration: false },
      displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144, control: true } };
    else if (req.url.endsWith('/conversations/list')) value = { items: [descriptor('chat')], order: input.order, hasMore: false, nextCursor: null };
    else if (req.url.endsWith('/conversations/get')) value = { operation: 'get', status: 'found', descriptor: descriptor(input.conversationId) };
    else if (req.url.endsWith('/conversations/history')) {
      const header = { schemaVersion: 1, status: 'ready', conversationId: input.conversationId, generation: 0,
        revision, canonicalRevision: revision, activeTurnId: null };
      if (body.operation === 'control') value = { ...header, activeTurn: null, latestTurn: null, requestedTurn: null };
      else if (body.operation === 'changes') {
        await delay(180);
        if (failNext) { failNext = false; res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'Synthetic transient read failure', retryable: true } })); return; }
        value = { ...header, records: changed.filter(row => row.revision > input.afterRevision), nextCursor: null, throughRevision: header.revision };
      } else if (body.operation === 'page') {
        await delay(120);
        const anchor = input.anchor, edge = anchor ? Number(anchor.messageId.slice(1)) : count + 1;
        const start = anchor?.direction === 'newer' ? edge + (anchor.inclusive ? 0 : 1) : Math.max(1, edge - input.limit);
        const end = anchor?.direction === 'newer' ? Math.min(count, start + input.limit - 1) : edge - 1;
        value = { ...header, records: input.view ? [] : Array.from({ length: end - start + 1 }, (_, i) => record(start + i)),
          nextCursor: !input.view && (anchor?.direction === 'newer' ? end < count : start > 1) ? 'more' : null };
      } else throw new Error(`Unexpected operation ${body.operation}`);
    } else throw new Error(`Unexpected endpoint ${req.url}`);
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, value })); entry.finished = Date.now();
  } catch (error) { errors.push(error.message); res.statusCode = 500; res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const artifactDir = process.env.HANDRAIL_JUMP_ARTIFACT_DIR;
try {
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  const ready = () => page.waitForFunction(() => globalThis.fixture?.snapshot()?.status === 'ready' && document.querySelector('[data-display-message]'));
  const away = async distance => {
    await page.locator('.hr-chat__transcript').evaluate((element, distance) => { element.scrollTop = element.scrollHeight - element.clientHeight - distance; }, distance);
    await page.locator('.hr-chat__jump').waitFor();
  };
  const sample = async label => {
    const samples = await page.evaluate(async () => {
      const samples = [], start = performance.now();
      while (performance.now() - start < 1400) {
        await new Promise(requestAnimationFrame);
        const jump = document.querySelector('.hr-chat__jump'), port = document.querySelector('.hr-chat__transcript');
        samples.push({ ms: Math.round(performance.now() - start), visible: Boolean(jump),
          opacity: jump ? getComputedStyle(jump).opacity : null, disabled: jump?.disabled, jumpBusy: jump?.getAttribute('aria-busy'),
          busy: port.getAttribute('aria-busy'), loading: globalThis.fixture.snapshot().loading });
      }
      return samples;
    });
    const changes = key => samples.slice(1).filter((sample, i) => sample[key] !== samples[i][key]).length;
    evidence.push({ label, opacityChanges: changes('opacity'), visibilityChanges: changes('visible'), samples });
    if (artifactDir) await page.screenshot({ path: `${artifactDir}/${label}.png` });
    assert.ok(samples.some(sample => sample.loading === 'changes') && samples.some(sample => sample.loading === null), 'Must exercise real polling');
    assert.ok(samples.every(sample => sample.visible && sample.opacity === '1' && !sample.disabled && sample.jumpBusy === 'false'), `${label}: Jump pulsed or disabled during polling`);
  };
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${server.address().port}`); await ready();
    await away(850); await sample(`${viewport.width}-idle`);
    await away(48); await sample(`${viewport.width}-threshold`);
    changed = [record(95, ++revision), record(++count, ++revision)];
    await sample(`${viewport.width}-arrival`);
    await page.reload(); await ready(); await away(180); await sample(`${viewport.width}-reload`);
    // A real click in a delayed poll must result in one latest read, not be lost.
    await page.waitForFunction(() => globalThis.fixture.snapshot().loading === 'changes');
    const before = requests.filter(r => r.operation === 'page' && !r.input.view && !r.input.anchor).length;
    await page.locator('.hr-chat__jump').evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => !document.querySelector('.hr-chat__jump') && globalThis.fixture.snapshot().loading === null);
    assert.equal(requests.filter(r => r.operation === 'page' && !r.input.view && !r.input.anchor).length, before + 1);
    assert.equal(await page.locator('[data-display-message]').last().getAttribute('data-display-message'), `m${count}`);
    changed = [record(++count, ++revision)];
    await page.waitForFunction(id => document.querySelector('[data-display-message]:last-of-type')?.getAttribute('data-display-message') === id, `m${count}`);
    assert.ok(await page.locator('.hr-chat__transcript').evaluate(e => Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) <= 2));
    // Explicit paging retains disabled/busy semantics and cannot duplicate reads.
    await away(180);
    await page.waitForFunction(() => globalThis.fixture.snapshot().loading === null);
    await page.getByRole('button', { name: 'Load older messages', exact: true }).evaluate(button => button.click());
    await page.waitForFunction(() => globalThis.fixture.snapshot().loading === 'older');
    assert.equal(await page.locator('.hr-chat__jump').isDisabled(), true);
    assert.equal(await page.locator('.hr-chat__jump').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('.hr-chat__transcript').getAttribute('aria-busy'), 'true');
    await page.waitForFunction(() => globalThis.fixture.snapshot().loading === null);
    await sample(`${viewport.width}-after-paging`);
    failNext = true;
    await page.waitForFunction(() => globalThis.fixture.snapshot().error !== null);
    await page.waitForFunction(() => globalThis.fixture.snapshot().error === null);
    await sample(`${viewport.width}-recovered`);
    await page.evaluate(() => globalThis.fixture.dispose());
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`); await ready(); await away(180);
  await page.waitForFunction(() => globalThis.fixture.snapshot().loading === 'changes');
  const oldPages = requests.filter(r => r.operation === 'page' && !r.input.view && r.input.conversationId === 'chat').length;
  await page.evaluate(async () => {
    document.querySelector('.hr-chat__jump').click();
    await globalThis.fixture.select('other');
  });
  await ready();
  assert.equal(await page.evaluate(() => globalThis.fixture.snapshot().conversationId), 'other');
  assert.equal(requests.filter(r => r.operation === 'page' && !r.input.view && r.input.conversationId === 'chat').length, oldPages,
    'Queued navigation must not survive selection replacement');
  await away(180); await page.waitForFunction(() => globalThis.fixture.snapshot().loading === 'changes');
  const beforeDispose = requests.filter(r => r.operation === 'page' && !r.input.view).length;
  await page.evaluate(async () => { document.querySelector('.hr-chat__jump').click(); await globalThis.fixture.dispose(); });
  await delay(400);
  assert.equal(requests.filter(r => r.operation === 'page' && !r.input.view).length, beforeDispose,
    'Queued navigation must not survive account disposal');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', boundary: 'Local delayed HTTP fixtures; real SDK session/transport/styled UI; Chromium only',
    evidence: evidence.map(({ samples, ...item }) => ({ ...item, frames: samples.length })) }, null, 2));
} finally {
  if (artifactDir) await writeFile(`${artifactDir}/timing.json`, JSON.stringify({ evidence, requests, errors }, null, 2));
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
