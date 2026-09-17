import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium } from 'playwright';
import { APPLICATION_GATEWAY_PROTOCOL_VERSION } from '../dist/client/index.js';
import { createConversationCatalogCursor } from '../dist/index.js';

// Production SDK React assembly, actual browser HTTP, synthetic server fixtures.
// This never contacts an application, provider, production database or preview.
const output = await build({ configFile: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { write: false, lib: { entry: fileURLToPath(new URL('../test/fixtures/paged-workspace-browser.tsx', import.meta.url)),
    name: 'PagedWorkspaceFixture', formats: ['iife'] } } });
const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code;
const requests = [], failures = [];
const descriptor = (messages, index) => ({ conversationId: `chat-${messages}-${index}`, title: `Chat ${index}`,
  lifecycle: 'active', archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', version: 1, metadata: {} });
const disabled = { supported: false, reason: 'not_implemented' };
const capabilities = { protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION, authoritativeCancellation: false,
  attachments: false, presence: false, activity: false, synchronization: false,
  resources: { conversations: { rename: disabled, clear: disabled, archive: disabled, restore: disabled, permanentDelete: disabled },
    approvals: false, titleGeneration: false }, displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144, control: true } };
const text = (conversation, id) => `${conversation}: message ${id}\n\n**Formatted answer** with [a safe link](https://example.invalid/reference).\n\n` +
  '```ts\nconst answer = 42;\n```\n\n' + 'Variable height message content. '.repeat(id % 4 + 1);
const record = (id, conversation) => ({ kind: 'message', id: `message-${id}`, turnId: null, revision: id * 100,
  bytes: 600, deferred: false, value: { message_id: `message-${id}`, role: id % 2 ? 'user' : 'assistant',
    attachments: [], created_at: null, attribution: null, content: [{ type: 'text', text: text(conversation, id) }] } });
const server = createServer(async (request, response) => {
  try {
    if (!request.url.startsWith('/api/')) {
      response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/app.js' ? code : '<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/app.js"></script>');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const input = body.input ?? body, messages = Number(request.url.split('/')[2]);
    assert.ok([200, 1000].includes(messages));
    let value;
    if (request.url.endsWith('/capabilities')) value = request.url.includes('/pending/') ? { ...capabilities,
      displayHistory: { ...capabilities.displayHistory, pendingApprovals: true } } : capabilities;
    else if (request.url.endsWith('/conversations/list')) {
      const start = input.cursor ? Number(decodeURIComponent(input.cursor.split('|').at(-1)).split('-').at(-1)) + 1 : 0;
      const count = request.url.includes('/single/') ? 1 : 25, end = Math.min(count, start + input.pageSize);
      const items = Array.from({ length: end - start }, (_, i) => descriptor(messages, start + i));
      value = { items, order: input.order, hasMore: end < count,
        nextCursor: end < count ? createConversationCatalogCursor(items.at(-1), input.order) : null };
    } else if (request.url.endsWith('/conversations/get')) {
      value = { operation: 'get', status: 'found', descriptor: descriptor(messages, Number(input.conversationId.split('-').at(-1))) };
    } else if (request.url.endsWith('/conversations/history')) {
      const header = { schemaVersion: 1, status: 'ready', conversationId: input.conversationId, generation: 0,
        revision: messages * 100, canonicalRevision: messages * 100, activeTurnId: null };
      if (body.operation === 'control') value = { ...header, activeTurn: null, latestTurn: null, requestedTurn: null,
        ...(request.url.includes('/pending/') ? { hasPendingApprovals: true } : {}) };
      else if (body.operation === 'changes') value = { ...header, records: [], nextCursor: null, throughRevision: messages * 100 };
      else if (body.operation === 'page') {
        if (['pending_approvals', 'approval'].includes(input.view?.type)) {
          const id = input.view.proposalId ?? (input.cursor ? 'old-action' : 'new-action');
          value = { ...header, records: [{ kind: 'approval', id, revision: 2, turnId: 'old-turn', bytes: 300, deferred: false,
            value: { proposal_id: id, proposal_version: 1, tool_call_id: 'tool', tool_name: id, turn_id: 'old-turn', group_id: input.conversationId,
              status: 'pending', expires_at: null, reviewed_arguments: { type: 'redacted_json', value: { amount: 42 } } } }],
            nextCursor: input.view.type === 'pending_approvals' && !input.cursor ? 'old' : null };
        }
        else if (input.view) value = { ...header, records: [], nextCursor: null };
        else {
          const anchor = input.anchor, edge = anchor ? Number(anchor.messageId.split('-').at(-1)) : messages + 1;
          const start = anchor?.direction === 'newer' ? edge + (anchor.inclusive ? 0 : 1) : Math.max(1, edge - input.limit);
          const end = anchor?.direction === 'newer' ? Math.min(messages, start + input.limit - 1) : edge - 1;
          value = { ...header, records: Array.from({ length: end - start + 1 }, (_, i) => record(start + i, input.conversationId)),
            nextCursor: (anchor?.direction === 'newer' ? end < messages : start > 1) ? 'more' : null };
        }
      } else throw new Error('Unexpected history operation');
    } else throw new Error(`Unexpected endpoint ${request.url}`);
    const json = JSON.stringify({ ok: true, value });
    requests.push({ path: request.url, operation: body.operation, input, bytes: Buffer.byteLength(json) });
    response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'private, no-store');
    response.end(json);
  } catch (cause) { failures.push(cause.message); response.statusCode = 500; response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => failures.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`, metrics = [];
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const readMetrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  const ready = (id, count = 30) => page.waitForFunction(({ id, count }) => globalThis.fixture?.snapshot().selected === id &&
    globalThis.fixture.snapshot().records === count && document.querySelectorAll('[data-display-message]').length === count &&
    document.querySelector('[data-display-message]')?.textContent.includes(id), { id, count });
  for (const messages of [200, 1000]) {
    requests.length = 0;
    await page.goto(`${base}/?messages=${messages}`); await ready(`chat-${messages}-0`);
    assert.equal(requests.filter(request => request.path.endsWith('/conversations/list')).length, 1);
    assert.equal(requests.filter(request => request.operation === 'page' && !request.input.view).length, 1);
    assert.equal(await page.evaluate(() => globalThis.fixture.snapshot().loadedThreads), 1);
    const initialHttp = requests.map(({ path, operation, bytes }) => ({ path, operation, bytes }));
    const samples = [], before = await readMetrics();
    for (let iteration = 1; iteration <= 12; iteration++) {
      samples.push(await page.evaluate(async ({ messages, iteration }) => {
        const id = `chat-${messages}-${iteration}`, start = performance.now(); await globalThis.fixture.select(iteration);
        for (;;) { await new Promise(requestAnimationFrame);
          if (performance.now() - start > 10000) throw new Error(`Timed out rendering ${id}`);
          if (globalThis.fixture.snapshot().selected === id && globalThis.fixture.snapshot().records === 30 &&
            document.querySelector('[data-display-message]')?.textContent.includes(id)) break; }
        await new Promise(requestAnimationFrame); return performance.now() - start;
      }, { messages, iteration }));
    }
    const after = await readMetrics(); await cdp.send('HeapProfiler.collectGarbage');
    const heap = await readMetrics();
    const state = await page.evaluate(() => { const { state: _state, ...summary } = globalThis.fixture.snapshot(); return summary; });
    assert.equal(state.loadedThreads, 1); assert.equal(state.threads, 4); assert.equal(state.records, 30);
    const transcript = page.locator('.hr-chat__transcript');
    await transcript.evaluate(element => { element.scrollTop = 320; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    const anchor = () => transcript.evaluate(element => { const top = element.getBoundingClientRect().top;
      const item = [...element.querySelectorAll('[data-display-message]')].find(item => item.getBoundingClientRect().bottom > top);
      return { id: item.dataset.displayMessage, offset: item.getBoundingClientRect().top - top }; });
    const old = await anchor();
    await page.getByRole('button', { name: 'Load older messages', exact: true }).evaluate(button => button.click());
    await ready(`chat-${messages}-12`, 60); await page.waitForTimeout(50); const next = await anchor();
    assert.equal(old.id, next.id); assert.ok(Math.abs(old.offset - next.offset) <= 2);
    for (let i = 0; i < 3; i++) {
      const first = await page.locator('[data-display-message]').first().getAttribute('data-display-message');
      await page.getByRole('button', { name: 'Load older messages', exact: true }).evaluate(button => button.click());
      await page.waitForFunction(first => document.querySelector('[data-display-message]')?.getAttribute('data-display-message') !== first, first);
      assert.ok(await page.locator('[data-display-message]').count() <= 90);
    }
    await page.getByRole('button', { name: 'Jump to latest', exact: true }).click(); await ready(`chat-${messages}-12`);
    const listRequests = requests.filter(request => request.path.endsWith('/conversations/list'));
    assert.equal(listRequests.length, 1, 'Switching chats must not fetch all catalog pages');
    const navigation = requests.filter(request => request.operation === 'page' && !request.input.view);
    const maximumHttpBodyBytes = Math.max(...requests.map(request => request.bytes));
    assert.ok(maximumHttpBodyBytes <= 65536); assert.ok(Math.max(...samples) < 1000); assert.ok(heap.JSHeapUsedSize < 32 * 1024 * 1024);
    samples.sort((a, b) => a - b);
    const httpResources = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/'))
      .map(entry => ({ path: new URL(entry.name).pathname, bodyBytes: entry.decodedBodySize, transferBytes: entry.transferSize, durationMs: entry.duration })));
    const completedHistory = httpResources.filter(entry => entry.path.endsWith('/conversations/history') && entry.bodyBytes > 0);
    // Switching cancels stale requests before their bodies finish. Resource
    // Timing may retain a zero-byte entry for those; count them separately.
    assert.ok(completedHistory.length >= navigation.length, JSON.stringify(httpResources));
    assert.ok(completedHistory.every(entry => entry.bodyBytes <= 65536));
    metrics.push({ sourceMessages: messages, equivalentStreamingEvents: messages * 100, samples: samples.length,
      selectionToPaintP50Ms: samples[5], selectionToPaintP95Ms: samples[11],
      scriptMeanMs: (after.ScriptDuration - before.ScriptDuration) * 1000 / samples.length,
      layoutMeanMs: (after.LayoutDuration - before.LayoutDuration) * 1000 / samples.length,
      browserHeapAfterGcBytes: heap.JSHeapUsedSize, retained: state, prependAnchorDriftPixels: Math.abs(old.offset - next.offset),
      initialHttp, catalogPagesFetched: listRequests.length, messagePagesFetchedIncludingNavigation: navigation.length,
      browserResourcesWithoutCompletedBody: httpResources.filter(entry => entry.bodyBytes === 0).length,
      maximumHttpBodyBytes, maximumBrowserMeasuredBodyBytes: Math.max(...httpResources.map(entry => entry.bodyBytes)),
      maximumBrowserTransferBytes: Math.max(...httpResources.map(entry => entry.transferBytes)) });
    await page.evaluate(() => globalThis.fixture.dispose());
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 }); await page.goto(`${base}/?messages=200&single=true`); await ready('chat-200-0');
    assert.equal(await page.getByRole('button', { name: 'New', exact: true }).count(), 0);
    assert.equal(await page.getByRole('complementary', { name: 'Conversation history' }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.locator('.hr-chat__transcript').focus();
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('hr-chat__transcript')));
    await page.evaluate(() => globalThis.fixture.dispose());
  }
  for (const width of [320, 390]) {
    requests.length = 0;
    await page.setViewportSize({ width, height: 844 }); await page.goto(`${base}/?messages=1000&single=true&pending=true`); await ready('chat-1000-0');
    assert.equal(requests.filter(request => request.input.view?.type === 'pending_approvals').length, 0);
    await page.getByRole('button', { name: 'Review pending approvals', exact: true }).click();
    await page.getByRole('button', { name: 'Older pending approvals', exact: true }).click();
    await page.getByRole('button', { name: 'Review old-action', exact: true }).click();
    await page.getByText('Review required', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.input.view?.type === 'approval').length, 1);
    assert.equal(requests.filter(request => request.operation === 'page' && !request.input.view).length, 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const pane = await page.getByRole('region', { name: 'Pending approvals', exact: true }).boundingBox();
    assert.ok(pane && pane.y >= 0 && pane.y + pane.height <= 844);
    await page.getByRole('button', { name: 'Close pending approvals', exact: true }).click();
    assert.equal(await page.getByText('Review required', { exact: true }).count(), 0);
    await page.evaluate(() => globalThis.fixture.dispose());
  }
  assert.deepEqual(failures, []);
  const report = { browser: await browser.version(), reactBuild: 'production, public dist exports', desktopWidth: 1280,
    pendingApprovalWidths: [320, 390], pendingApprovalExtraMessagePages: 0,
    singleConversationWidths: [320, 390], maximumRenderedMessages: 90, maximumIdleSessions: 4,
    budgets: { selectionToPaintMaximumMs: 1000, browserHeapAfterGcBytes: 32 * 1024 * 1024, maximumHttpBodyBytes: 65536 }, metrics,
    limitations: ['Local synthetic HTTP server; no production network, database, provider or business payloads.',
      '200/1000 complete-message fixtures represent 20k/100k streaming events; the browser never receives event logs.',
      'Real PostgreSQL adapter/concurrency timing is measured separately; these results are not summed into a production estimate.',
      'No file upload, voice session or concurrent writer is exercised by this render benchmark.'] };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.HANDRAIL_WORKSPACE_BROWSER_REPORT) await writeFile(process.env.HANDRAIL_WORKSPACE_BROWSER_REPORT, JSON.stringify(report, null, 2) + '\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
