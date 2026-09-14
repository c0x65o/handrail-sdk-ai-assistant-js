// Qualification fixture only. Owns a disposable cluster; accepts no database URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresAiPersistence, cleanupPostgresConversationFileStaging,
  cleanupPostgresAssistantAttachmentStaging, deletePostgresConversationHistory, postgresFromClient } from '../dist/postgres/index.js';
import { deletePostgresConversationAttachments } from '../dist/postgres/conversation-deletion.js';
import { createConversationFileStorage } from '../dist/server/conversation-files.js';
const require = createRequire(import.meta.url);
if (process.argv.length !== 3 || !process.argv[2].startsWith('/')) {
  throw new Error('Pass the absolute path to an existing postgres.js module. This fixture accepts no database connection settings.');
}
const postgres = require(process.argv[2]);
const bin = process.env.SDK_POSTGRES_TEST_BIN ?? '/usr/lib/postgresql/15/bin';
const work = await mkdtemp('/tmp/sdk-file-staging-');
const run = (command, args) => execFileSync(join(bin, command), args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
let started = false; const pools = []; const releases = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); releases.push(resolve); return { promise, resolve }; };
const adapt = sql => { const client = {
  async query(text, values = []) {
    const result = await sql.unsafe(text, [...values]); return { rows: [...result], rowCount: result.count }; },
  transaction: operation => sql.begin ? sql.begin(tx => operation(adapt(tx))) : operation(client),
}; return client; };
try {
  await mkdir(join(work, 'socket'));
  run('initdb', ['-D', join(work, 'data'), '--no-locale', '-E', 'UTF8', '-A', 'trust', '-U', 'fixture']);
  run('pg_ctl', ['-D', join(work, 'data'), '-l', join(work, 'postgres.log'), '-o',
    `-k ${join(work, 'socket')} -h '' -p 55509 -c shared_buffers=64MB -c max_connections=10`, '-w', 'start']);
  started = true;
  const connection = name => { const sql = postgres({ host: join(work, 'socket'), port: 55509, user: 'fixture', database: 'postgres',
    max: 1, prepare: false, onnotice: () => {}, connection: { application_name: name, statement_timeout: 10000 } }); pools.push(sql); return adapt(sql); };
  const a = connection('sdk-fixture-a'), b = connection('sdk-fixture-b'), control = connection('sdk-fixture-control');
  const persistence = new PostgresAiPersistence(a); await persistence.migrate();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const files = (client, tenantId) => createConversationFileStorage({ persistence: new PostgresAiPersistence(client),
    tenantId, principalId: 'alice', maintenanceScopeId: 'fixture-files', authorizeConversation: async () => {},
    validateFile: input => input, limits: { maximumFiles: 3, maximumBytesPerFile: 100, maximumTotalBytes: 300,
      acceptedMediaTypes: ['application/pdf'] } });
  const stage = storage => storage.stage({ idempotencyKey: 'upload', fileName: 'fixture.pdf', mediaType: 'application/pdf', data: bytes });
  const cleanup = (client, tenantId) => cleanupPostgresConversationFileStaging({ persistence: new PostgresAiPersistence(client),
    maintenanceScopeId: 'fixture-files', tenantId, now: () => Date.now() + 16 * 60_000 });
  const remove = (client, tenantId, conversationId) => client.transaction(async tx => {
    await deletePostgresConversationHistory({ client: tx, tenantId, conversationId, authorize: async () => {} });
    await deletePostgresConversationAttachments(tx, tenantId, conversationId);
  });
  const state = async tenantId => ({
    docs: (await control.query("SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'", [tenantId])).rows,
    blobs: (await control.query('SELECT blob_key FROM handrail_ai_attachment_blobs WHERE tenant_id=$1', [tenantId])).rows,
  });
  const tap = (client, hook) => ({ query: async (sql, values) => { const result = await client.query(sql, values);
    await hook(sql, values, result); return result; }, transaction: operation => client.transaction(tx => operation(tap(tx, hook))) });
  const awaitLock = async application => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await control.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rows.length) return;
      await delay(10);
    }
    throw new Error('Expected fixture database lock was not reached');
  };
  const arrived = (entered, operation) => Promise.race([entered.promise, operation.then(result => {
    throw result.error ?? new Error('Fixture operation ended before its barrier');
  })]);
  const observed = promise => promise.then(value => ({ value }), error => ({ error }));
  const ordinary = (client, tenantId) => postgresFromClient(client).forScope({ tenantId, scopeId: 'alice' },
    { createConversationId: () => 'unused' }).attachments;
  const input = { ownerScopeId: 'alice', conversationId: 'ordinary', idempotencyKey: 'upload',
    fingerprint: 'original', mediaType: 'text/plain', bytes };
  const expireOrdinary = (client, tenantId) => cleanupPostgresAssistantAttachmentStaging({
    persistence: new PostgresAiPersistence(client), tenantId, maintenanceScopeId: 'assistant-uploads',
    now: () => Date.now() + 61 * 60_000,
  });
  {
    const tenant = 'ordinary-expiry-workers'; await ordinary(a, tenant).stage(input);
    const results = await Promise.all([expireOrdinary(a, tenant), expireOrdinary(b, tenant)]);
    assert.equal(results.reduce((sum, value) => sum + value.removed, 0), 1);
    assert.equal(results.reduce((sum, value) => sum + value.blocked, 0), 0);
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    await assert.rejects(ordinary(b, tenant).stage(input), { code: 'expired' });
    console.log('PASS concurrent ordinary expiry workers collect one upload and preserve transaction ownership');
  }
  {
    const tenant = 'ordinary-expiry-active-race', entered = deferred(), release = deferred();
    await ordinary(a, tenant).stage(input);
    const paused = tap(a, async sql => {
      if (sql.includes("payload->'retention'->>'version'='2'")) { entered.resolve(); await release.promise; }
    });
    const expiring = observed(expireOrdinary(paused, tenant)); await arrived(entered, expiring);
    const writes = new PostgresAiPersistence(b);
    const running = await writes.compareAndSetDocument({ tenantId: tenant, kind: 'durable_turn', scopeId: 'ordinary',
      recordId: 'active', expectedVersion: null, value: { status: 'running' } });
    release.resolve(); const result = await expiring; assert.equal(result.error, undefined);
    assert.equal(result.value.removed, 0); assert.equal(result.value.blocked, 1);
    assert.equal((await state(tenant)).blobs.length, 1);
    await writes.compareAndSetDocument({ ...running, expectedVersion: running.version, value: { status: 'completed' } });
    assert.equal((await expireOrdinary(a, tenant)).removed, 1);
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    assert.equal((await writes.getDocument(tenant, 'durable_turn', 'ordinary', 'active')).value.status, 'completed');
    console.log('PASS ordinary expiry checks work admitted after discovery and preserves its completed receipt');
  }
  {
    const tenant = 'ordinary-expiry-renewal-race', entered = deferred(), release = deferred();
    const ref = await ordinary(a, tenant).stage(input);
    const paused = tap(a, async sql => {
      if (sql.includes("payload->'retention'->>'version'='2'")) { entered.resolve(); await release.promise; }
    });
    const expiring = observed(expireOrdinary(paused, tenant)); await arrived(entered, expiring);
    // Fixture-only lease change under normal conversation/blob locks. No public
    // read renews a lease and no production metadata is rewritten by this check.
    const renewed = new Date(Date.now() + 120 * 60_000).toISOString();
    await b.transaction(async tx => {
      const store = new PostgresAiPersistence(tx);
      const row = await store.getDocument(tenant, 'attachment', 'alice', ref.content_ref);
      await store.compareAndSetDocument({ ...row, expectedVersion: row.version, value: { ...row.value, expiresAt: renewed } });
      await tx.query('UPDATE handrail_ai_attachment_blobs SET expires_at=$3::text::timestamptz WHERE tenant_id=$1 AND blob_key=$2',
        [tenant, row.value.blobKey, renewed]);
    });
    release.resolve(); const result = await expiring; assert.equal(result.error, undefined);
    assert.equal(result.value.removed, 0);
    const saved = await state(tenant); assert.equal(saved.docs.length, 1); assert.equal(saved.blobs.length, 1);
    assert.equal(saved.docs[0].payload.expiresAt, renewed);
    assert.equal((await expireOrdinary(a, tenant)).removed, 0);
    console.log('PASS ordinary expiry rereads changed metadata and cannot remove a renewed lease');
  }
  {
    const tenant = 'ordinary-rollback';
    const failing = tap(a, async sql => {
      if (sql.startsWith('INSERT INTO handrail_ai_documents') && sql.includes("'attachment'")) {
        throw new Error('Fixture transaction aborted after metadata insertion');
      }
    });
    await assert.rejects(ordinary(failing, tenant).stage(input), { code: 'unavailable' });
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    const [first, second] = await Promise.all([ordinary(a, tenant).stage(input), ordinary(b, tenant).stage(input)]);
    assert.deepEqual(first, second);
    const stored = await state(tenant); assert.equal(stored.docs.length, 1); assert.equal(stored.blobs.length, 1);
    console.log('PASS ordinary upload rollback removes bytes and metadata; concurrent retries retain one exact upload');
  }
  {
    const tenant = 'ordinary-deletion-first', entered = deferred(), release = deferred();
    // Admission now acquires the conversation lock before allocating bytes.
    // Pause before that transaction so deletion can win without a test deadlock.
    const paused = { query: a.query, transaction: async operation => {
      entered.resolve(); await release.promise; return a.transaction(operation);
    } };
    const uploading = observed(ordinary(paused, tenant).stage(input));
    await arrived(entered, uploading);
    await remove(b, tenant, input.conversationId);
    release.resolve();
    const result = await uploading;
    assert.equal(result.error?.code, 'not_found');
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    console.log('PASS deletion wins before ordinary upload admission; the rejected transaction leaves no bytes or metadata');
  }
  {
    const tenant = 'ordinary-lost-commit'; let loseReply = true;
    const uncertain = { query: a.query, transaction: async operation => {
      const result = await a.transaction(operation);
      if (loseReply) { loseReply = false; throw new Error('Fixture lost commit acknowledgement'); }
      return result;
    } };
    await assert.rejects(ordinary(uncertain, tenant).stage(input), { code: 'unavailable' });
    const committed = await state(tenant);
    assert.equal(committed.docs.length, 1); assert.equal(committed.blobs.length, 1);
    const retry = await ordinary(b, tenant).stage(input);
    assert.equal(retry.content_ref, committed.docs[0].payload.contentRef);
    assert.deepEqual(await state(tenant), committed);
    console.log('PASS lost ordinary upload commit acknowledgement preserves the committed upload and exact retry identity');
  }
  {
    const tenant = 'single-consumption', storage = files(a, tenant), ref = await stage(storage);
    const results = await Promise.allSettled([storage.materialize('first', [ref]), files(b, tenant).materialize('second', [ref])]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1,
      JSON.stringify(results.map(result => result.status === 'rejected' ? { code: result.reason.code, message: result.reason.message, stack: result.reason.stack } : 'fulfilled')));
    assert.equal((await state(tenant)).blobs.length, 1);
    const sweeps = await Promise.all([cleanup(a, tenant), cleanup(b, tenant)]);
    assert.equal(sweeps.reduce((sum, result) => sum + result.removed, 0), 1);
    const retained = await state(tenant); assert.equal(retained.docs.length, 1); assert.equal(retained.blobs.length, 1);
    assert.deepEqual((await storage.download(retained.docs[0].payload.conversationId, ref.attachment_id)).data, bytes);
    await assert.rejects(stage(files(b, tenant)), { code: 'expired' });
    console.log('PASS concurrent materialization admits one conversation; expiry preserves its saved copy and expired retry identity');
  }
  {
    const tenant = 'retained-expiry-retry-race', entered = deferred(), release = deferred();
    await stage(files(a, tenant));
    const paused = tap(a, async sql => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) { entered.resolve(); await release.promise; }
    });
    const expiring = observed(cleanup(paused, tenant)); await arrived(entered, expiring);
    const retrying = observed(stage(files(b, tenant)));
    await awaitLock('sdk-fixture-b'); release.resolve();
    const [expired, retry] = await Promise.all([expiring, retrying]);
    assert.equal(expired.error, undefined); assert.deepEqual(expired.value, { removed: 1, blocked: 0 });
    assert.equal(retry.error?.code, 'expired');
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    console.log('PASS retained upload retry waits for expiry and cannot recreate removed bytes with the old key');
  }
  {
    const tenant = 'expiry-discovery-race', storage = files(a, tenant), ref = await stage(storage);
    const entered = deferred(), release = deferred(); let held = false;
    const sweeper = tap(b, async sql => {
      if (!held && sql.includes("payload->'retention'")) { held = true; entered.resolve(); await release.promise; }
    });
    const sweep = observed(cleanup(sweeper, tenant)); await arrived(entered, sweep);
    await storage.materialize('retained', [ref]); release.resolve();
    assert.deepEqual((await sweep).value, { removed: 0, blocked: 0 });
    assert.deepEqual(await cleanup(b, tenant), { removed: 1, blocked: 0 });
    assert.deepEqual((await files(b, tenant).download('retained', ref.attachment_id)).data, bytes);
    console.log('PASS expiry discovery rereads consumed staging version and safely retries with its committed conversation binding');
  }
  {
    const tenant = 'expiry-first', storage = files(a, tenant), ref = await stage(storage);
    const entered = deferred(), release = deferred(); let held = false;
    const sweeper = tap(b, async sql => {
      if (!held && sql.includes('FOR UPDATE SKIP LOCKED')) { held = true; entered.resolve(); await release.promise; }
    });
    const sweep = observed(cleanup(sweeper, tenant)); await arrived(entered, sweep);
    const materialization = observed(storage.materialize('too-late', [ref]));
    await awaitLock('sdk-fixture-a'); release.resolve();
    assert.deepEqual((await sweep).value, { removed: 1, blocked: 0 });
    assert.equal((await materialization).error?.code, 'unavailable');
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    console.log('PASS expiry locks serialize with materialization; expired upload cannot create a retained orphan');
  }
  {
    const tenant = 'deletion-first', storage = files(a, tenant), ref = await stage(storage);
    const entered = deferred(), release = deferred(); let held = false;
    const deleting = tap(b, async sql => {
      if (!held && sql.includes("VALUES ($1,'conversation_deleted'")) { held = true; entered.resolve(); await release.promise; }
    });
    const deletion = observed(remove(deleting, tenant, 'deleted')); await arrived(entered, deletion);
    const materialization = observed(storage.materialize('deleted', [ref]));
    await awaitLock('sdk-fixture-a'); release.resolve();
    assert.equal((await deletion).error, undefined);
    assert.equal((await materialization).error?.code, 'conversation_deleted');
    assert.equal((await state(tenant)).docs.length, 1); // Unclaimed temporary upload still owns its bytes until TTL.
    assert.deepEqual(await cleanup(a, tenant), { removed: 1, blocked: 0 });
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    console.log('PASS deletion fence rejects late retention; unclaimed staging expires without reviving conversation data');
  }
  {
    const tenant = 'retention-first', storage = files(a, tenant), ref = await stage(storage);
    const entered = deferred(), release = deferred(); let held = false;
    const retaining = tap(a, async (sql, values) => {
      if (!held && sql.startsWith('INSERT INTO handrail_ai_documents') && String(values?.[5]).includes('"retainedConversationId"')) {
        held = true; entered.resolve(); await release.promise;
      }
    });
    const materialization = observed(files(retaining, tenant).materialize('retained-then-deleted', [ref]));
    await arrived(entered, materialization);
    const deletion = observed(remove(b, tenant, 'retained-then-deleted'));
    await awaitLock('sdk-fixture-b'); release.resolve();
    assert.equal((await deletion).error, undefined);
    const result = await materialization;
    // A read after the retention commit may race the newly committed deletion.
    if (result.error) assert.equal(result.error.code, 'unavailable');
    else assert.deepEqual(result.value[0].data, bytes);
    assert.deepEqual(await state(tenant), { docs: [], blobs: [] });
    console.log('PASS deletion waits for retained copy and consumption commit, then removes both saved and linked staging state');
  }
  console.log('PASS twelve native PostgreSQL upload/expiry/retained-file cases; fixture contains no project data');
} finally {
  for (const release of releases) release();
  await Promise.allSettled(pools.map(sql => sql.end({ timeout: 1 })));
  if (started) run('pg_ctl', ['-D', join(work, 'data'), '-m', 'fast', '-w', 'stop']);
  await rm(work, { recursive: true, force: true });
  console.log('Disposable PostgreSQL cluster stopped and removed');
}
