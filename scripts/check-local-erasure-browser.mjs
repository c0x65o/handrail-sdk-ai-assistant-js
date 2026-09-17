/* global LocalErasureFixture, indexedDB, IDBObjectStore, TextEncoder, DOMException */
// Real browser IndexedDB, local synthetic data, built public SDK exports only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { build } from 'vite';
import { chromium } from 'playwright';

const output = await build({ configFile: false, logLevel: 'error', build: { write: false,
  lib: { entry: fileURLToPath(new URL('../test/fixtures/local-erasure-browser.ts', import.meta.url)),
    name: 'LocalErasureFixture', formats: ['iife'] } } });
const code = (Array.isArray(output) ? output : [output]).flatMap(bundle => bundle.output)
  .find(item => item.type === 'chunk').code;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? code : '<title>Local erasure qualification</title><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
  const context = await browser.newContext(), errors = [];
  const first = await context.newPage(), oldTab = await context.newPage();
  for (const page of [first, oldTab]) page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await first.goto(url);
  // Upgrade a real v2 database with existing pending, draft and position rows.
  await first.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('handrail-ai-pending-v1', 2);
      opening.onupgradeneeded = () => {
        for (const name of ['pending', 'drafts', 'positions']) {
          const store = opening.result.createObjectStore(name, { keyPath: ['scope', 'conversation'] });
          store.createIndex('scope', 'scope');
        }
      };
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    const tx = db.transaction(['pending', 'drafts', 'positions'], 'readwrite');
    const scope = 'account:api', conversation = 'chat', json = JSON.stringify(LocalErasureFixture.submission());
    const complete = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    tx.objectStore('pending').put({ scope, conversation, json, bytes: new TextEncoder().encode(json).length });
    tx.objectStore('drafts').put({ scope, conversation, text: 'Legacy draft', version: 'v2', bytes: 12 });
    tx.objectStore('positions').put({ scope, conversation, messageId: 'message', generation: 0, offset: 12, following: false });
    await complete; db.close();
  });
  const before = await first.evaluate(async () => {
    const store = globalThis.localStore = LocalErasureFixture.createStore('account:api');
    const other = LocalErasureFixture.createStore('other-account:api');
    await store.writeDraft('keep', 'Other conversation', null);
    await store.writeAttachmentDraft('chat', [LocalErasureFixture.draftFile('selected')], null);
    await store.writeAttachmentDraft('keep', [LocalErasureFixture.draftFile('kept', 'keep')], null);
    await other.writeAttachmentDraft('chat', [LocalErasureFixture.draftFile('other-account')], null);
    await other.writeDraft('chat', 'Other account', null); other.close();
    return { draft: (await store.readDraft('chat')).text, pending: !!await store.load('chat'),
      position: (await store.readPosition('chat')).offset };
  });
  assert.deepEqual(before, { draft: 'Legacy draft', pending: true, position: 12 });
  await first.reload();
  const restoredFile = await first.evaluate(async () => {
    globalThis.localStore = LocalErasureFixture.createStore('account:api');
    const saved = await globalThis.localStore.readAttachmentDraft('chat');
    return { bytes: [...new Uint8Array(await saved.files[0].selection.source.arrayBuffer())],
      uploadKey: saved.files[0].selection.idempotencyKey };
  });
  assert.deepEqual(restoredFile, { bytes: [11, 22, 33], uploadKey: 'upload:selected' });
  await oldTab.goto(url);
  await oldTab.evaluate(async () => {
    globalThis.localStore = LocalErasureFixture.createStore('account:api');
    globalThis.oldDraft = await globalThis.localStore.readDraft('chat');
    globalThis.oldFiles = await globalThis.localStore.readAttachmentDraft('chat');
  });
  // Synchronous storage failure must abort all deletes in the same transaction.
  const atomic = await first.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'deleted') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
    let rejected = false;
    try { await globalThis.localStore.eraseConversation('chat'); } catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = original; }
    return { rejected, draft: (await globalThis.localStore.readDraft('chat')).text,
      pending: !!await globalThis.localStore.load('chat'), position: !!await globalThis.localStore.readPosition('chat'),
      files: (await globalThis.localStore.readAttachmentDraft('chat')).files.length };
  });
  assert.deepEqual(atomic, { rejected: true, draft: 'Legacy draft', pending: true, position: true, files: 1 });
  await first.evaluate(() => globalThis.localStore.eraseConversation('chat'));
  const denied = await oldTab.evaluate(async () => {
    const store = globalThis.localStore;
    const attempts = [
      () => store.writeDraft('chat', 'Late save', globalThis.oldDraft.version),
      () => store.writeDraft('chat', 'Late empty-version save', null),
      () => store.writePosition('chat', { messageId: 'late', generation: 0, offset: 0, following: true }),
      () => store.retain(LocalErasureFixture.submission()),
      () => store.writeAttachmentDraft('chat', globalThis.oldFiles.files, globalThis.oldFiles.version),
    ];
    const results = [];
    for (const attempt of attempts) {
      try { await attempt(); results.push(false); } catch (error) { results.push(error.message.includes('permanently deleted')); }
    }
    store.close(); return results;
  });
  assert.deepEqual(denied, [true, true, true, true, true]);
  await first.reload();
  const after = await first.evaluate(async () => {
    const store = LocalErasureFixture.createStore('account:api'), other = LocalErasureFixture.createStore('other-account:api');
    const result = { draft: await store.readDraft('chat'), pending: await store.load('chat'), position: await store.readPosition('chat'),
      files: await store.readAttachmentDraft('chat'), keptFiles: (await store.readAttachmentDraft('keep')).files.length,
      otherFiles: (await other.readAttachmentDraft('chat')).files.length,
      keptDraft: (await store.readDraft('keep')).text, otherAccount: (await other.readDraft('chat')).text, fence: false };
    try { await store.retain(LocalErasureFixture.submission()); } catch { result.fence = true; }
    await store.eraseConversation('chat'); store.close(); other.close(); return result;
  });
  assert.deepEqual(after, { draft: null, pending: null, position: null, files: null, keptFiles: 1, otherFiles: 1,
    keptDraft: 'Other conversation', otherAccount: 'Other account', fence: true });
  const erasedAccount = await first.evaluate(async () => {
    const store = LocalErasureFixture.createStore('account:api'), other = LocalErasureFixture.createStore('other-account:api');
    await store.eraseAccount();
    const value = { keptDraft: await store.readDraft('keep'), keptFiles: await store.readAttachmentDraft('keep'),
      otherFiles: (await other.readAttachmentDraft('chat')).files.length, otherAccount: (await other.readDraft('chat')).text };
    store.close(); other.close(); return value;
  });
  assert.deepEqual(erasedAccount, { keptDraft: null, keptFiles: null, otherFiles: 1, otherAccount: 'Other account' });
  assert.deepEqual(errors, []);
  const report = { browser: await browser.version(), source: 'built public SDK, real Chromium IndexedDB',
    checks: { version2UpgradePreservesRows: true, attachmentBytesAndUploadIdentitySurviveReload: true,
      failedFenceRollsBackErasure: true, oldTabLateWritesRejected: denied.length,
      deletionSurvivesReload: true, otherConversationPreserved: true, otherAccountPreserved: true,
      explicitAccountErasurePreservesOtherScope: true, pageErrors: errors.length },
    limitations: ['Synthetic local browser storage only; no app preview, deployment or production data.'] };
  if (process.env.HANDRAIL_ERASURE_BROWSER_REPORT) await writeFile(process.env.HANDRAIL_ERASURE_BROWSER_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
