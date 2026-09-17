/* global attachmentFixture, Request, document, performance */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { write: false, lib: { entry: fileURLToPath(new URL('../test/fixtures/attachment-draft-browser.tsx', import.meta.url)), name: 'AttachmentDraftFixture', formats: ['iife'] } } });
const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output).find(item => item.type === 'chunk').code;
// Playwright's function poll treats an async predicate's Promise as truthy.
// Await IndexedDB reads explicitly so assertions observe completed transactions.
async function waitForStored(page, predicate) {
  const deadline = Date.now() + 15000;
  while (!await page.evaluate(predicate)) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for durable local state');
    await delay(25);
  }
}
const uploads = [], errors = [];
const admissions = [], turns = new Map();
const descriptor = id => ({ conversationId: id, title: `Chat ${id}`, lifecycle: 'active', archivedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', version: 1, metadata: {} });
const server = createServer(async (request, response) => {
  try {
    if (!request.url.startsWith('/api/')) {
      response.setHeader('content-type', request.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
      response.end(request.url === '/app.js' ? code : '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/app.js"></script>'); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks); let value;
    if (request.url === '/api/upload') {
      const form = await new Request('http://localhost/upload', { method: 'POST', headers: request.headers, body }).formData();
      const file = form.get('file'), bytes = [...new Uint8Array(await file.arrayBuffer())];
      uploads.push({ key: form.get('idempotencyKey'), conversation: form.get('conversationId'), filename: file.name, bytes });
      value = { attachment_id: 'att_local_fixture', content_ref: 'ref_local_fixture', media_type: file.type, byte_size: file.size, filename: file.name };
    } else {
      const parsed = JSON.parse(body.toString()), input = parsed.input ?? parsed;
      if (request.url.endsWith('/conversations/list')) value = { items: ['first', 'second'].map(descriptor), order: input.order, hasMore: false, nextCursor: null };
      else if (request.url.endsWith('/conversations/get')) value = { operation: 'get', status: 'found', descriptor: descriptor(input.conversationId) };
      else if (request.url.endsWith('/conversations/history')) {
        const turn = turns.get(input.conversationId) ?? null, revision = turn?.revision ?? 0;
        const header = { schemaVersion: 1, status: 'ready', conversationId: input.conversationId, generation: 0, revision, canonicalRevision: revision, activeTurnId: null };
        value = parsed.operation === 'control' ? { ...header, activeTurn: null, latestTurn: turn, requestedTurn: turn?.turnId === input.turnId ? turn : null }
          : { ...header, records: [], nextCursor: null, ...(parsed.operation === 'changes' ? { throughRevision: revision } : {}) };
      }
      else if (request.url.endsWith('/synchronization') && parsed.operation === 'append_mutations') {
        const duplicate = turns.has(input.conversationId), payload = input.mutations.at(-1).events[0].payload;
        assert.equal(payload.type, 'turn.started'); admissions.push(input);
        const revision = (input.expectedRevision ?? 0) + input.mutations.length;
        // Synthetic durable worker has already completed by the receipt read.
        turns.set(input.conversationId, { turnId: payload.turn_id, revision, status: 'completed', remoteMayStillBeRunning: false, error: null });
        value = { status: 'mutations', latestRevision: revision, acknowledgements: input.mutations.map(mutation => ({
          status: duplicate ? 'duplicate' : 'accepted', mutationId: mutation.mutationId, events: mutation.events,
        })) };
      }
      else throw new Error(`Unexpected local route ${request.url}`);
    }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, value }));
  } catch (error) { errors.push(error.message); response.statusCode = 500; response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 980, height: 760 } });
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWkAAAAASUVORK5CYII=', 'base64');
  await page.goto(url); await page.waitForFunction(() => !!globalThis.attachmentFixture);
  await page.waitForFunction(() => document.querySelector('input[type="file"]')?.disabled === false);
  // Text ownership shares the same account-scoped store as the real workspace.
  // Rejection must reach both the displayed textarea and durable storage.
  await page.getByRole('textbox').fill('Keep this valid draft');
  await page.evaluate(() => attachmentFixture.flushText());
  const originalText = await page.evaluate(() => attachmentFixture.draft());
  const debuggerSession = await page.context().newCDPSession(page);
  await debuggerSession.send('HeapProfiler.collectGarbage');
  const heapBeforeRejectedEdits = (await debuggerSession.send('Runtime.getHeapUsage')).usedSize;
  const rejectionMilliseconds = [];
  for (let index = 0; index < 10; index++) {
    const started = performance.now();
    await page.getByRole('textbox').fill('x'.repeat(1024 * 1024));
    rejectionMilliseconds.push(performance.now() - started);
    assert.equal(await page.getByRole('textbox').inputValue(), originalText.text);
  }
  await page.getByRole('alert').filter({ hasText: '64 KiB' }).waitFor();
  await debuggerSession.send('HeapProfiler.collectGarbage');
  const heapAfterRejectedEdits = (await debuggerSession.send('Runtime.getHeapUsage')).usedSize;
  assert.ok(heapAfterRejectedEdits - heapBeforeRejectedEdits < 8 * 1024 * 1024, 'Rejected drafts accumulated beyond the 8 MiB warmup budget');
  assert.deepEqual(await page.evaluate(() => attachmentFixture.draft()), originalText);
  await page.evaluate(() => attachmentFixture.holdTextBudget());
  await page.getByRole('textbox').fill('y'.repeat(65536));
  await page.evaluate(() => attachmentFixture.flushText());
  await page.evaluate(() => attachmentFixture.captureAcceptedText());
  await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
  await page.getByRole('textbox').fill('Next edit');
  assert.equal(await page.getByRole('textbox').inputValue(), '');
  await page.getByRole('alert').filter({ hasText: 'account’s text limit' }).waitFor();
  await page.evaluate(() => attachmentFixture.releaseCapturedText());
  await page.getByRole('textbox').fill('Next edit');
  assert.equal(await page.getByRole('textbox').inputValue(), 'Next edit');
  await page.evaluate(() => attachmentFixture.clearTextBudget());
  await page.getByRole('textbox').fill(''); await page.evaluate(() => attachmentFixture.flushText());
  await page.evaluate(() => attachmentFixture.failTextWrites(true));
  await page.getByRole('textbox').fill('Unstored draft survives transcript eviction');
  await page.evaluate(() => attachmentFixture.flushText().catch(() => undefined));
  await page.getByRole('button', { name: 'Retry saving draft', exact: true }).waitFor();
  for (let index = 0; index < 7; index++) await page.evaluate(index => attachmentFixture.select(`text-other-${index}`), index);
  await page.waitForFunction(() => attachmentFixture.retainedThreads() <= 4);
  await page.evaluate(() => attachmentFixture.select('first'));
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'Unstored draft survives transcript eviction');
  await page.evaluate(() => attachmentFixture.failTextWrites(false));
  await page.getByRole('button', { name: 'Retry saving draft', exact: true }).click();
  await waitForStored(page, async () => (await attachmentFixture.draft())?.text === 'Unstored draft survives transcript eviction');
  await page.getByRole('textbox').fill(''); await page.evaluate(() => attachmentFixture.flushText());


  await page.locator('input[type=file]').setInputFiles({ name: 'saved.png', mimeType: 'image/png', buffer: bytes });
  await page.getByRole('button', { name: 'Remove saved.png', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled === false);
  await page.evaluate(() => attachmentFixture.flush());
  const saved = await page.evaluate(() => attachmentFixture.saved());
  assert.equal(uploads.length, 1); assert.deepEqual(saved.bytes, [...bytes]); assert.equal(saved.reference, true);
  assert.equal(saved.key, uploads[0].key); assert.equal(uploads[0].conversation, 'first'); assert.deepEqual(uploads[0].bytes, [...bytes]);
  for (let index = 0; index < 7; index++) await page.evaluate(index => attachmentFixture.select(`other-${index}`), index);
  assert.equal(await page.getByRole('button', { name: 'Remove saved.png', exact: true }).count(), 0);
  await page.waitForFunction(() => attachmentFixture.retainedThreads() <= 4);
  await page.evaluate(() => attachmentFixture.select('first'));
  await page.getByRole('button', { name: 'Remove saved.png', exact: true }).waitFor();
  assert.equal(uploads.length, 1);
  await page.reload(); await page.getByRole('button', { name: 'Remove saved.png', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => attachmentFixture.saved()), saved); assert.equal(uploads.length, 1);
  await page.goto(`${url}/?account=b`); await page.waitForFunction(() => !!globalThis.attachmentFixture);
  await page.evaluate(() => attachmentFixture.flush());
  assert.equal(await page.getByRole('button', { name: 'Remove saved.png', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => attachmentFixture.saved()), null);
  await page.goto(url); await page.getByRole('button', { name: 'Remove saved.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove saved.png', exact: true }).click();
  await page.evaluate(() => attachmentFixture.flush()); assert.equal(await page.evaluate(() => attachmentFixture.saved()), null);
  await page.reload(); await page.waitForFunction(() => !!globalThis.attachmentFixture); await page.evaluate(() => attachmentFixture.flush());
  assert.equal(await page.getByRole('button', { name: 'Remove saved.png', exact: true }).count(), 0);
  const retentionUploadCount = uploads.length;
  // Crash after remote admission and partial device cleanup. The new process
  // replays the exact request while preserving independently edited local work.
  await page.locator('input[type=file]').setInputFiles({ name: 'sent.png', mimeType: 'image/png', buffer: bytes });
  await page.getByRole('textbox').fill('Sent before process loss');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled === false);
  await page.evaluate(() => attachmentFixture.failNextFileCleanup());
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await waitForStored(page, async () => !!await attachmentFixture.pending());
  await page.getByText('Your message was saved, but its local draft could not be cleared. Retry the saved message.', { exact: true }).first().waitFor();
  const pending = await page.evaluate(() => attachmentFixture.pending());
  assert.equal(pending.localDraft.fileIds.length, 1); assert.equal(typeof pending.localDraft.textVersion, 'string');
  await page.reload(); await page.getByRole('button', { name: 'Retry saved message', exact: true }).waitFor();
  await page.getByRole('textbox').fill('Newer draft after restart');
  await page.waitForFunction(() => document.querySelector('input[type="file"]')?.disabled === false);
  await page.locator('input[type=file]').setInputFiles({ name: 'newer.png', mimeType: 'image/png', buffer: bytes });
  await waitForStored(page, async () => { const files = await attachmentFixture.files(); return files.length === 2 && files.every(file => file.ready); });
  await page.evaluate(() => attachmentFixture.flushText());
  await page.getByRole('button', { name: 'Retry saved message', exact: true }).click();
  await waitForStored(page, async () => await attachmentFixture.pending() === null);
  assert.equal(await page.evaluate(() => attachmentFixture.pending()), null, "Retry must finish durable acknowledgement");
  assert.deepEqual((await page.evaluate(() => attachmentFixture.files())).map(file => file.filename), ['newer.png']);
  assert.equal((await page.evaluate(() => attachmentFixture.draft())).text, 'Newer draft after restart');
  assert.equal(admissions.length, 2); assert.deepEqual(admissions[0], admissions[1]);
  assert.ok(!JSON.stringify(admissions).includes('localDraft')); assert.ok(!JSON.stringify(admissions).includes('textVersion'));
  assert.equal(uploads.length - retentionUploadCount, 2);
  await page.reload(); await page.getByRole('button', { name: 'Remove newer.png', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').inputValue(), 'Newer draft after restart');
  assert.equal(await page.evaluate(() => attachmentFixture.pending()), null);
  assert.equal(uploads.length - retentionUploadCount, 2);
  await page.evaluate(() => attachmentFixture.dispose()); assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), source: 'built public client, standard React workspace, real IndexedDB and local HTTP uploads',
    textRetention: { heapBeforeRejectedEdits, heapAfterRejectedEdits, heapGrowthBudgetBytes: 8 * 1024 * 1024,
      rejectedPasteBytes: 1024 * 1024, rejectionMilliseconds: rejectionMilliseconds.map(value => Math.round(value)) },
    checks: { oversizedTextRejectedBeforeStorage: true, validDraftAndRevisionPreserved: true, failedTextSaveSurvivesTranscriptEviction: true,
      acceptedTextRetainedUntilSendSettles: true, accountTextBytes: 524288, maximumEditorTextBytes: 65536,
      repeatedOversizedPastes: 10,
      uploadedExactlyOnceAcrossSwitchesAndReloads: retentionUploadCount === 1, originalBytesAndUploadKeyPreserved: true,
      survivesRuntimeCacheEviction: true, accountIsolation: true, explicitRemovalSurvivesReload: true,
      admittedDraftCleanupAfterReload: true, newerTextAndFilePreserved: true, exactAdmissionReplayWithoutDeviceMetadata: true,
      pageAndServerErrors: errors.length },
    limitations: ['Synthetic local Chromium; no application preview, production data, published SDK adoption, or device testing.'] };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.HANDRAIL_ATTACHMENT_BROWSER_REPORT) await writeFile(process.env.HANDRAIL_ATTACHMENT_BROWSER_REPORT, JSON.stringify(report, null, 2) + '\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
