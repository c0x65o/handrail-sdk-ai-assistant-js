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
let delayDisplayAfterAdmission = false, denyStart = 0, throttleStart = false, dropStart = false;
const savedStarts = [];
let throttleHistory = false, throttledHistory = 0, revokeStart = false;
let assistant, browser, server, page;
const requests = [], errors = [];
try {
  await persistence.persistence.migrate();
  assistant = await createHandrailAssistant({ id: 'reopen', persistence, authorize: (request, action) => {
    if (action === 'start' && revokeStart) revoked = true;
    if (action === 'start' && throttleStart) throw new globalThis.Response('Throttled', { status: 429, headers: { 'Retry-After': '2' } });
    if (action === 'start' && denyStart) throw new globalThis.Response(JSON.stringify({ ok: false, error: {
      code: denyStart === 401 ? 'unauthenticated' : 'forbidden', message: 'Fixture admission denied', retryable: false,
    } }), { status: denyStart, headers: { 'content-type': 'application/json' } });
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
      if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>'); return; }
      if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(code); return; }
      if (!req.url.startsWith('/api/assistant')) { res.writeHead(404).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const input = body ? JSON.parse(body) : null;
      if (req.url.endsWith('/turns/start')) savedStarts.push(input);
      requests.push({ path: req.url, operation: input?.operation, turnId: input?.input?.turnId });
      if (throttleHistory && req.url.endsWith('/conversations/history')) {
        throttledHistory++;
        res.writeHead(429, { 'Retry-After': '3' }).end('Throttled'); return;
      }
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
      if (dropStart && req.url.endsWith('/turns/start')) {
        dropStart = false;
        await response.body?.cancel();
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":'); return;
      }
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
  await page.goto(base + '/?' + new globalThis.URLSearchParams({ ...(process.env.HANDRAIL_REOPEN_PAGE === '1' ? { page: '1' } : {}),
    ...(process.env.HANDRAIL_DENIED_START_TEST === '1' ? { durable: '1' } : {}) }));
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
  if (process.env.HANDRAIL_DENIED_START_TEST === '1') {
    await open();
    for (const status of [403, 401]) {
      denyStart = status;
      await draft().fill(`Saved but denied ${status}`); await ready(); await send().click();
      await eventually(() => requests.filter(r => r.path.endsWith('/turns/start')).length === (status === 403 ? 1 : 2));
      await eventually(() => !page.isClosed() && page.evaluate(() => !window.reopenFixture.session.getSnapshot().submitting));
      console.log('Denied admission snapshot:', await page.evaluate(() => ({ text: document.body.innerText,
        state: window.reopenFixture.session.getSnapshot().control })));
      await eventually(async () => (await pool.query("SELECT count(*)::int AS n FROM handrail_ai_events WHERE payload->'payload'->>'type'='turn.failed'")).rows[0].n === (status === 403 ? 1 : 2));
      assert.equal(calls, 0);
      await eventually(async () => await page.getByRole('button', { name: 'Stop response', exact: true }).count() === 0);
      if (process.env.HANDRAIL_REOPEN_SCREENSHOT && status === 403) await page.screenshot({ path: process.env.HANDRAIL_REOPEN_SCREENSHOT, fullPage: true });
      await page.reload(); await open();
      await page.getByText(`Saved but denied ${status}`, { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Stop response', exact: true }).count(), 0);
      assert.equal(calls, 0);
    }
    assert.equal(await admissions(), 2);
    assert.equal(requests.filter(r => r.path.endsWith('/turns/start')).length, 2);
    assert.equal(requests.filter(r => r.path.endsWith('/cancel')).length, 0);
    console.log('PASS: denied 401/403 retain canonical messages, terminalize without provider calls, and converge on reload.');
    const postStart = async (input, account = 'alice') => page.evaluate(async ({ input, account }) => {
      const response = await globalThis.fetch('/api/assistant/turns/start', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-account': account }, body: JSON.stringify(input) });
      await response.text(); return response.status;
    }, { input, account });
    const first = savedStarts[0];
    denyStart = 403;
    assert.equal(await postStart(first, 'bob'), 403);
    assert.equal(await postStart({ ...first, mutationId: 'foreign-identity' }), 403);
    denyStart = 0;
    assert.equal(await postStart(first), 200); // Terminal replay after authentication changes.
    assert.equal(await postStart(first), 200);
    assert.equal(calls, 0); assert.equal(await admissions(), 2);
    console.log('PASS: denied foreign ownership/mismatched identity do not mutate; repeated authorized replay stays terminal with zero provider calls.');

    throttleHistory = true;
    await eventually(() => throttledHistory === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    await open(); await open();
    await page.getByRole('button', { name: 'Retry conversation', exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(throttledHistory, 1);
    throttleHistory = false;
    await eventually(() => page.evaluate(() => !window.reopenFixture.session.getSnapshot().error));
    assert.equal(calls, 0);
    console.log('PASS: history 429 honors Retry-After across Retry and hide/reopen without a hot loop.');

    const retry = () => page.getByRole('button', { name: 'Retry saved message', exact: true });
    throttleStart = true;
    await draft().fill('Retry throttled admission'); await ready(); await send().click();
    await retry().waitFor();
    await eventually(() => page.evaluate(() => !window.reopenFixture.session.getSnapshot().submitting));
    const throttled = savedStarts.at(-1), beforeRetry = savedStarts.length;
    await retry().evaluate(button => { button.click(); button.click(); });
    assert.equal(savedStarts.length, beforeRetry); assert.equal(calls, 0);
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(savedStarts.length, beforeRetry); // No automatic resubmit.
    throttleStart = false; providerGate.resolve();
    await retry().click(); await revealReply('Synthetic reply 1');
    assert.deepEqual(savedStarts.at(-1), throttled); assert.equal(await admissions(), 3);
    console.log('PASS: HTTP 429 honors Retry-After, repeated Retry does not write, and explicit retry reuses the saved identity.');

    providerGate = deferred(); dropStart = true;
    await draft().fill('Uncertain admitted execution'); await ready(); await send().click();
    await retry().waitFor(); await eventually(() => calls === 2);
    await eventually(() => page.evaluate(() => !window.reopenFixture.session.getSnapshot().submitting));
    const uncertain = savedStarts.at(-1);
    await page.reload(); await open(); await retry().waitFor();
    denyStart = 403; await retry().click();
    await eventually(() => page.evaluate(() => !window.reopenFixture.session.getSnapshot().submitting));
    assert.deepEqual(savedStarts.at(-1), uncertain); assert.equal(calls, 2);
    assert.equal(await admissions(), 4);
    const retained = (await pool.query("SELECT payload FROM handrail_ai_documents WHERE kind='durable_turn' AND record_id=$1", [uncertain.conversationTurnId])).rows[0].payload;
    assert.ok(['pending', 'running'].includes(retained.status));
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await eventually(async () => (await pool.query("SELECT count(*)::int AS n FROM handrail_ai_events WHERE payload->'payload'->>'type'='turn.cancelled'")).rows[0].n === 1);
    providerGate.resolve(); denyStart = 0;
    await page.reload(); await open();
    await page.getByText('Uncertain admitted execution', { exact: true }).waitFor();
    await eventually(async () => await retry().count() === 0);
    assert.equal(calls, 2); assert.equal(await admissions(), 4);
    console.log('PASS: network uncertainty survives reload and later denial without overwriting execution; explicit Stop settles once and reload releases the journal.');
    revokeStart = true; denyStart = 401;
    await draft().fill('Saved before complete revocation'); await ready(); await send().click();
    await page.getByText('Conversation access is unavailable.', { exact: true }).waitFor();
    await eventually(() => page.evaluate(() => !window.reopenFixture.session.getSnapshot().submitting));
    const revokedStart = savedStarts.at(-1), startsBeforeRestore = savedStarts.length;
    assert.equal(calls, 2);
    assert.equal(await page.getByRole('button', { name: 'Stop response', exact: true }).count(), 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM handrail_ai_documents WHERE kind='durable_turn' AND record_id=$1", [revokedStart.conversationTurnId])).rows[0].n, 0);
    revoked = false; revokeStart = false; denyStart = 0;
    await page.reload(); await open(); await retry().waitFor();
    assert.equal(savedStarts.length, startsBeforeRestore); assert.equal(calls, 2);
    await retry().click(); await revealReply('Synthetic reply 3');
    assert.deepEqual(savedStarts.at(-1), revokedStart); assert.equal(await admissions(), 5);
    console.log('PASS: complete revocation denies settlement access, retains the original hold, hides Stop, and requires explicit same-identity Retry after authentication returns.');
    const durableFacts = (await pool.query("SELECT payload->>'status' AS status,payload->>'attempt' AS attempt,payload->>'delegateStartAttempted' AS attempted FROM handrail_ai_documents WHERE kind='durable_turn'")).rows;
    assert.equal(durableFacts.length, 5);
    assert.equal(durableFacts.filter(row => row.status === 'failed' && row.attempt === '0' && row.attempted === 'false').length, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM handrail_ai_events WHERE payload->'payload'->>'type'='message.created' AND payload->'payload'->>'role'='user'")).rows[0].n, 5);
    console.log('PASS: SQL proves five unique user messages/turns, two admission failures with zero dispatch attempts, and no duplicate execution.');



  } else {
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
  }
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
