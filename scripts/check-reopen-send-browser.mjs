/* global document, window, Event */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import ts from 'typescript';
import { chromium } from 'playwright';
import { createHandrailAssistant, openaiResponses } from '../dist/server/assistant.js';
import { postgres } from '../dist/postgres/index.js';

// Reuse the locked pg dependency and disposable-cluster runner. No shared DB.
assert.equal(process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE, '1');
const { Pool } = createRequire(new URL('../test/fixtures/agent-cancellation/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, max: 4 });
const persistence = postgres(pool);
const fact = id => ({ id, source: 'server_derived', trust: 'authoritative' });
const context = { tenantId: 'fixture', scopeId: 'alice', principalId: 'alice', attribution: {
  organization: fact('fixture'), project: fact('fixture'), service_environment: fact('test'),
  known_user: fact('alice'), session: fact('fixture-session'), automation: fact(null) } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const eventually = async predicate => {
  for (let i = 0; i < 300; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('Fixture condition did not settle');
};
let providerGate = deferred(), observerGate = deferred(), holdObserver = false, observerHeld = 0, calls = 0;
let displayGate = deferred(), holdDisplay = false, displayHeld = 0;
let admissionGate = deferred(), holdAdmission = false, admissionHeld = 0, dropAdmission = false, revoked = false;
let delayDisplayAfterAdmission = false;
let assistant, browser, server, page;
const requests = [], errors = [];
try {
  await persistence.persistence.migrate();
  assistant = await createHandrailAssistant({ id: 'reopen', persistence, authorize: request => {
    if (revoked) throw Error('Fixture session revoked');
    const user = request.headers.get('x-fixture-account');
    if (!['alice', 'bob'].includes(user)) throw Error('Fixture authentication required');
    return { ...context, principalId: user, scopeId: user, attribution: { ...context.attribution, known_user: fact(user) } };
  },
    automaticTitles: false, attachmentCleanup: false, recoverPendingOnContext: false,
    provider: openaiResponses({ model: 'synthetic', request: async function* (_request, { signal }) {
      const call = ++calls;
      const aborted = deferred(), onAbort = () => aborted.resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (signal.aborted) onAbort();
        await Promise.race([providerGate.promise, aborted.promise]);
      } finally { signal.removeEventListener('abort', onAbort); }
      // Even output arriving as Stop aborts the provider must not be projected.
      yield { type: 'response.output_text.delta', delta: `Synthetic reply ${call}` };
      yield { type: 'response.completed', response: { status: 'completed', output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
    } }),
  });
  // Optional read-only negative control: compile only the assigned baseline
  // composer in memory. Never overwrite source/dist or change any Git pin.
  const baseline = process.env.HANDRAIL_REOPEN_BASELINE === '1' ? ts.transpileModule(execFileSync('git',
    ['show', '704b6599f37dce7255e345c8132bf81856bdb6bf:src/react/use-conversation-composer.ts'], { encoding: 'utf8' }),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : null;
  const output = await build({ configFile: false, logLevel: 'error',
    plugins: baseline ? [{ name: 'frozen-composer-negative-control', enforce: 'pre',
      load: id => id.endsWith('/dist/react/use-conversation-composer.js') ? baseline : null }] : [],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, lib: { entry: fileURLToPath(new URL('../test/fixtures/reopen-send-browser.tsx', import.meta.url)),
      name: 'ReopenFixture', formats: ['iife'] } } });
  const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code;
  server = createServer(async (req, res) => {
    try {
      if (req.url === '/' || req.url === '/?page=1') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>'); return; }
      if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(code); return; }
      if (!req.url.startsWith('/api/assistant')) { res.writeHead(404).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const input = body ? JSON.parse(body) : null;
      requests.push({ path: req.url, operation: input?.operation, turnId: input?.input?.turnId });
      // Delay only the external HTTP observation, while display polling converges.
      if (holdObserver && req.url.endsWith('/conversations/history') && input?.operation === 'control' && input.input?.turnId) {
        observerHeld++; await observerGate.promise;
      }
      if (holdDisplay && req.url.endsWith('/conversations/history') && !input?.input?.turnId) {
        displayHeld++; await displayGate.promise;
      }
      if (holdAdmission && req.url.endsWith('/synchronization') && input?.operation === 'append_mutations') {
        admissionHeld++; await admissionGate.promise;
      }
      const response = await assistant.handle(new globalThis.Request(`http://127.0.0.1${req.url}`, {
        method: req.method, headers: { 'content-type': 'application/json',
          'x-fixture-account': req.headers['x-fixture-account'] ?? '' }, ...(body ? { body } : {}),
      }));
      if (delayDisplayAfterAdmission && req.url.endsWith('/synchronization') && input?.operation === 'append_mutations') {
        delayDisplayAfterAdmission = false; holdDisplay = true;
      }
      if (dropAdmission && req.url.endsWith('/synchronization') && input?.operation === 'append_mutations') {
        dropAdmission = false; await response.arrayBuffer();
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":'); return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        res.on('close', () => { void reader.cancel().catch(() => {}); });
        try { for (;;) { const next = await reader.read(); if (next.done) break; res.write(next.value); } }
        finally { reader.releaseLock(); }
      }
      res.end();
    } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  page = await browser.newPage(process.env.HANDRAIL_REOPEN_MOBILE === '1'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base + (process.env.HANDRAIL_REOPEN_PAGE === '1' ? '/?page=1' : '/'));
  const open = () => page.getByRole('button', { name: /Open chat/ }).click();
  const send = () => page.getByRole('button', { name: 'Send message', exact: true });
  const draft = () => page.getByRole('textbox');
  const ready = () => page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Send message"]'); return button && !button.disabled;
  });
  const admissions = async () => (await pool.query("SELECT count(*)::int AS n FROM handrail_ai_events WHERE payload->'payload'->>'type'='turn.started'")).rows[0].n;
  const revealReply = async text => eventually(async () => {
    if (await page.getByText(text, { exact: true }).isVisible()) return true;
    // Polling may remove this button while Playwright is waiting for stability.
    await page.evaluate(() => {
      const jump = [...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Jump to latest'));
      if (jump && !jump.disabled) jump.click();
    });
    return false;
  });
  await open(); await draft().fill('First turn'); await send().click();
  await eventually(() => calls === 1);
  holdObserver = true;
  await eventually(() => observerHeld > 0);
  await draft().fill('Next draft');
  await open(); // The launcher disclosure toggles closed without cancelling.
  providerGate.resolve();
  await eventually(async () => (await pool.query("SELECT count(*)::int AS n FROM handrail_ai_events WHERE payload->'payload'->>'type'='turn.completed'")).rows[0].n === 1);
  await open();
  await page.getByText('Synthetic reply 1', { exact: true }).waitFor();
  await page.waitForFunction(() => window.reopenFixture.session.getSnapshot().control?.activeTurnId === null);
  assert.equal(await draft().inputValue(), 'Next draft');
  const snapshot = await page.evaluate(() => ({ submitting: window.reopenFixture.session.getSnapshot().submitting,
    active: window.reopenFixture.session.getSnapshot().control.activeTurnId }));
  console.log('Reopened after canonical completion with delayed observer:', snapshot);
  // Exact old failure: enabled Send rejects locally before any admission.
  if (await send().isEnabled()) {
    await send().click();
    await page.getByText('The message could not be sent. Check your connection and try again.', { exact: true }).waitFor();
    console.log('REPRODUCED', await page.evaluate(() => window.reopenFixture.errors));
    assert.fail('Send enabled while previous session submission is still settling');
  }
  if (process.env.HANDRAIL_REOPEN_SCREENSHOT) await page.screenshot({ path: process.env.HANDRAIL_REOPEN_SCREENSHOT, fullPage: true });
  // Enter/programmatic form submission must also respect the shared session.
  await draft().press('Enter');
  await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(calls, 1);
  assert.deepEqual(await page.evaluate(() => window.reopenFixture.errors), []);
  holdObserver = false; observerGate.resolve();
  await ready();
  await send().evaluate(button => { button.click(); button.click(); });
  await page.getByText('Synthetic reply 2', { exact: true }).waitFor();
  await eventually(() => calls === 2);
  assert.equal(await admissions(), 2);
  assert.equal(requests.filter(r => r.path.endsWith('/cancel')).length, 0);
  console.log('PASS: rendered launcher close/reopen, delayed observer, retained next draft, Enter/form guards, repeated Send; two PostgreSQL admissions, zero cancellations.');

  // Reopened hydration cannot expose Send against stale/empty session controls.
  await draft().fill('Slow network draft'); await open();
  holdDisplay = true; await open(); await eventually(() => displayHeld > 0);
  assert.equal(await send().isEnabled(), false);
  await draft().press('Enter'); assert.equal(await admissions(), 2);
  assert.equal(await draft().inputValue(), 'Slow network draft');
  holdDisplay = false; displayGate.resolve(); await ready();
  // Close with an admission request still in flight, then repeat Send on return.
  holdAdmission = true; await send().click(); await eventually(() => admissionHeld > 0);
  await open(); await open();
  assert.equal(await send().isEnabled(), false);
  await draft().press('Enter'); assert.equal(await admissions(), 2);
  holdAdmission = false; admissionGate.resolve();
  await page.getByText('Synthetic reply 3', { exact: true }).waitFor();
  assert.equal(await admissions(), 3);
  console.log('PASS: delayed reopen hydration and slow admission preserve the draft and prevent duplicate admissions.');

  // A lost admission acknowledgement must retry its saved identity, never mint a new turn.
  await draft().fill('Uncertain acknowledgement'); await ready(); dropAdmission = true; await send().click();
  const retry = page.getByRole('button', { name: 'Retry saved message', exact: true });
  await retry.waitFor();
  await open(); await open();
  assert.ok(await send().count() === 0 || !await send().isEnabled());
  await retry.click(); await revealReply('Synthetic reply 4');
  assert.equal(await admissions(), 4);
  console.log('PASS: lost admission acknowledgement retries the saved identity exactly once after reopen.');

  // Explicit Stop remains authoritative; a close is only an observation change.
  providerGate = deferred();
  displayGate = deferred(); delayDisplayAfterAdmission = true;
  await draft().fill('Stop this turn'); await ready(); await send().click();
  await eventually(() => calls === 5);
  const stop = page.getByRole('button', { name: 'Stop response', exact: true });
  await stop.waitFor();
  console.log('Stop before delayed display control:', await stop.evaluate(button => {
    const state = window.reopenFixture.session.getSnapshot();
    button.click(); button.click();
    return { active: state.control?.activeTurnId, submitting: state.submitting };
  }));
  await eventually(async () => (await pool.query("SELECT count(*)::int AS n FROM handrail_ai_events WHERE payload->'payload'->>'type'='turn.cancelled'")).rows[0].n === 1);
  providerGate.resolve(); holdDisplay = false; displayGate.resolve();
  await draft().fill('After explicit Stop'); await ready(); await send().click();
  await page.getByText('Synthetic reply 6', { exact: true }).waitFor();
  assert.equal(await admissions(), 6);
  assert.equal(await page.getByText('Synthetic reply 5', { exact: true }).count(), 0);
  assert.ok(requests.some(r => r.path.endsWith('/cancel')));
  console.log('PASS: repeated explicit Stop persists one cancellation, suppresses late output, and permits the next turn.');

  // Account replacement during hydration discards the old view and next draft.
  await draft().fill('Alice private next draft'); await open();
  displayGate = deferred(); displayHeld = 0; holdDisplay = true; await open();
  await eventually(() => displayHeld > 0);
  await page.evaluate(() => window.reopenFixture.setAccount('bob'));
  holdDisplay = false; displayGate.resolve();
  if (process.env.HANDRAIL_REOPEN_PAGE !== '1') await open();
  await draft().waitFor(); assert.equal(await draft().inputValue(), '');
  await draft().fill('Bob first turn'); await ready();
  assert.equal(await page.getByText('Synthetic reply 6', { exact: true }).count(), 0);
  await send().click(); await page.getByText('Synthetic reply 7', { exact: true }).waitFor();
  assert.equal(await admissions(), 7);
  // Authorization is still checked at admission, including revocation after ready.
  await draft().fill('Retain after revocation'); await ready(); revoked = true;
  await send().evaluate(button => button.click());
  await page.getByText('Conversation access is unavailable.', { exact: true }).waitFor();
  assert.equal(await draft().inputValue(), 'Retain after revocation');
  assert.equal(await admissions(), 7); assert.equal(calls, 7);
  console.log('PASS: account replacement during delayed hydration isolates history; revoked authorization retains draft with zero admissions.');
  assert.ok(!(await page.evaluate(() => window.reopenFixture.errors)).includes('pending_send_exists'));
  assert.deepEqual(errors, []);
} catch (error) {
  console.log('Fixture failure details:', { calls, errors, recentRequests: requests.slice(-8),
    browser: await page?.evaluate(() => ({ text: document.body.innerText,
      errors: window.reopenFixture?.errors, state: window.reopenFixture?.session?.getSnapshot() })).catch(() => null) });
  throw error;
} finally {
  providerGate.resolve(); observerGate.resolve(); displayGate.resolve(); admissionGate.resolve();
  await browser?.close();
  await assistant?.stopBackgroundWorkers();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
}
