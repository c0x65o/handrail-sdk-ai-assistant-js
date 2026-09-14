// Qualification fixture only. Owns a disposable cluster; accepts no database URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresAiPersistence, PostgresConversationCatalog, PostgresConversationEventStore, PostgresProviderOperationStore,
  PostgresRealtimeCallStore, PostgresRealtimeToolActivityStore, postgresRealtimeToolActivityScope,
  enqueuePostgresConversationFileCleanup, drainPostgresConversationFileCleanup } from '../dist/postgres/index.js';
import { parseConversationEvent } from '../dist/index.js';
const require = createRequire(import.meta.url);
if (process.argv.length !== 3 || !process.argv[2].startsWith('/')) {
  throw new Error('Pass the absolute path to an existing postgres.js module. This fixture accepts no database connection settings.');
}
const postgres = require(process.argv[2]);
const bin = process.env.SDK_POSTGRES_TEST_BIN ?? '/usr/lib/postgresql/15/bin';
const work = await mkdtemp('/tmp/sdk-concurrency-');
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
  await control.query('CREATE TABLE mapped_conversations (LIKE handrail_ai_conversations INCLUDING ALL)');
  const catalog = (client, extras = {}) => new PostgresConversationCatalog({ persistence: new PostgresAiPersistence(client), tenantId: 'fixture',
    scopeId: context => context.owner, authorize: () => 'allow', createId: () => { throw new Error('Explicit fixture identity required'); }, ...extras });
  const actor = { owner: 'owner' };
  const create = (store, conversationId, authorizationContext = actor) => store.create({ authorizationContext, conversationId, idempotencyKey: `create-${conversationId}` });
  const event = conversationId => parseConversationEvent({ version: 1, event_id: `${conversationId}-event`, conversation_id: conversationId,
    revision: 1, occurred_at: '2026-09-13T00:00:00.000Z', actor: { type: 'system' }, source: { type: 'runtime' },
    payload: { type: 'conversation.metadata_updated', metadata: { note: 'Disposable concurrency fixture' } } });
  const append = (client, conversationId) => new PostgresAiPersistence(client).appendEvents({ tenantId: 'fixture', conversationId,
    expectedRevision: null, events: [event(conversationId)] });
  const awaitLock = async application => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await control.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application]);
      if (rows.rows.length) return;
      await delay(10);
    }
    throw new Error(`${application} did not reach the expected database lock`);
  };
  {
    const value = { nested: { text: 'Fixture "quoted" text', list: [1, true, null] } };
    await persistence.compareAndSetDocument({ tenantId: 'fixture', kind: 'sync_state', scopeId: 'json-fixture',
      recordId: 'json-fixture', expectedVersion: null, value });
    assert.deepEqual((await persistence.getDocument('fixture', 'sync_state', 'json-fixture', 'json-fixture')).value, value);
    let executions = 0;
    const execute = async () => { executions += 1; return value; };
    assert.deepEqual(await persistence.getOrExecuteTool('fixture', 'json-tool', execute, 'json-tool'), value);
    assert.deepEqual(await persistence.getOrExecuteTool('fixture', 'json-tool', execute, 'json-tool'), value);
    assert.equal(executions, 1);
    assert.deepEqual(await persistence.getToolResults('fixture', ['json-tool']), [{ toolCallId: 'json-tool', result: value }]);
    console.log('PASS postgres.js JSON contract: decoded nested state, effect receipt and array-query replay without a host workaround');
  }
  for (const mapped of [false, true]) {
    const conversationId = mapped ? 'cross-storage' : 'cross-owner';
    const results = await Promise.allSettled([create(catalog(a), conversationId),
      create(catalog(b, mapped ? { table: { name: 'mapped_conversations' } } : {}), conversationId, { owner: 'other-owner' })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'idempotency_conflict');
    assert.equal((await control.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id='fixture' AND kind='catalog_identity' AND scope_id=$1", [conversationId])).rows.length, 1);
    console.log(`PASS concurrent ${conversationId}: exactly one catalog identity acquired`);
  }
  {
    // Deterministically commit a second event just after the page query returns.
    // READ COMMITTED transactions do not make separate page/head queries atomic.
    const conversationId = 'concurrent-page-head'; await create(catalog(a), conversationId); await append(a, conversationId);
    let advanced = false;
    const tap = client => ({
      async query(sql, values) {
        const result = await client.query(sql, values);
        if (!advanced && sql.includes('handrail_ai_events') && sql.includes('payload')) {
          advanced = true;
          await new PostgresAiPersistence(b).appendEvents({ tenantId: 'fixture', conversationId, expectedRevision: 1,
            events: [parseConversationEvent({ ...event(conversationId), event_id: 'concurrent-second', revision: 2 })] });
        }
        return result;
      },
      transaction: operation => client.transaction(tx => operation(tap(tx))),
    });
    const events = new PostgresConversationEventStore(new PostgresAiPersistence(tap(a)), 'fixture');
    const page = await events.read({ conversationId });
    assert.equal(advanced, true); assert.equal(page.entries.length, 1); assert.equal(page.hasMore, false);
    assert.equal(page.latestRevision, 1, 'A page must not report a head committed after its snapshot');
    const next = await events.read({ conversationId, after: { cursor: page.nextCursor } });
    assert.equal(next.entries.length, 1); assert.equal(next.latestRevision, 2);
    console.log('PASS concurrent page/head: one database snapshot, next read sees the concurrent append without a false history gap');
  }
  {
    const conversationId = 'delete-vs-late-append';
    const entered = deferred(), release = deferred();
    const store = catalog(a, { permanentlyDeleteContents: async () => { entered.resolve(); await release.promise; } });
    const current = (await create(store, conversationId)).descriptor;
    const deletion = store.permanentlyDelete({ authorizationContext: actor, conversationId, expectedVersion: current.version, idempotencyKey: 'delete-late' })
      .then(value => ({ value }), error => ({ error }));
    await Promise.race([entered.promise, deletion.then(result => { if (result.error) throw result.error; })]);
    const late = append(b, conversationId).then(value => ({ value }), error => ({ error }));
    await awaitLock('sdk-fixture-b'); release.resolve();
    assert.equal((await deletion).value.status, 'deleted');
    assert.equal((await late).error.code, 'conversation_deleted');
    assert.deepEqual(await persistence.readEvents('fixture', conversationId), []);
    console.log('PASS delete vs late append: writer waits then receives permanent deletion fence');
  }
  {
    const conversationId = 'admission-vs-delete'; const entered = deferred(), release = deferred();
    const store = catalog(b); const current = (await create(store, conversationId)).descriptor;
    await append(b, conversationId);
    const admission = a.transaction(async tx => {
      await new PostgresAiPersistence(tx).compareAndSetDocument({ tenantId: 'fixture', kind: 'durable_turn', scopeId: conversationId,
        recordId: 'pending-turn', expectedVersion: null, value: { conversationId, status: 'pending' } });
      entered.resolve(); await release.promise;
    }).then(value => ({ value }), error => ({ error }));
    await Promise.race([entered.promise, admission.then(result => { if (result.error) throw result.error; })]);
    const deletion = store.permanentlyDelete({ authorizationContext: actor, conversationId, expectedVersion: current.version,
      idempotencyKey: 'delete-admitted' }).then(value => ({ value }), error => ({ error }));
    await awaitLock('sdk-fixture-b'); release.resolve(); assert.equal((await admission).error, undefined);
    assert.equal((await deletion).error.code, 'unavailable');
    assert.equal((await store.get({ authorizationContext: actor, conversationId })).status, 'found');
    assert.equal((await persistence.readEvents('fixture', conversationId)).length, 1);
    assert.equal(await persistence.getDocument('fixture', 'conversation_deleted', conversationId, 'deleted'), null);
    console.log('PASS admitted turn vs delete: deletion waits and refuses pending work, retaining history');
  }
  {
    const conversationId = 'concurrent-rename'; const current = (await create(catalog(a), conversationId)).descriptor;
    const results = await Promise.allSettled([a, b].map((client, index) => catalog(client).rename({ authorizationContext: actor,
      conversationId, expectedVersion: current.version, title: `Title ${index}`, idempotencyKey: `rename-${index}` })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'version_conflict');
    console.log('PASS concurrent rename: exactly one expected-version mutation commits');
  }
  {
    const conversationId = 'external-files-after-commit';
    const entered = deferred(), release = deferred();
    const store = catalog(a, { permanentlyDeleteContents: async input => {
      await enqueuePostgresConversationFileCleanup({ ...input, scopeId: 'fixture-files', jobId: 'immutable-file',
        target: { key: 'immutable-chat-file' } });
      entered.resolve(); await release.promise;
    } });
    const current = (await create(store, conversationId)).descriptor;
    const deletion = store.permanentlyDelete({ authorizationContext: actor, conversationId, expectedVersion: current.version,
      idempotencyKey: 'delete-with-file' }).then(value => ({ value }), error => ({ error }));
    await Promise.race([entered.promise, deletion.then(result => { if (result.error) throw result.error; })]);
    let remoteDeletes = 0;
    const options = { scopeId: 'fixture-files', parseTarget: target => {
      assert.deepEqual(target, { key: 'immutable-chat-file' }); return target;
    }, deleteFile: async () => { remoteDeletes += 1; } };
    assert.deepEqual(await drainPostgresConversationFileCleanup({ ...options, client: b }), { completed: 0, retrying: 0, blocked: 0 });
    assert.equal(remoteDeletes, 0); release.resolve(); assert.equal((await deletion).value.status, 'deleted');
    const deleting = deferred(), acknowledge = deferred();
    const worker = drainPostgresConversationFileCleanup({ ...options, client: a, deleteFile: async () => {
      remoteDeletes += 1; deleting.resolve(); await acknowledge.promise;
    } }).then(value => ({ value }), error => ({ error }));
    await Promise.race([deleting.promise, worker.then(result => { if (result.error) throw result.error; })]);
    assert.deepEqual(await drainPostgresConversationFileCleanup({ ...options, client: b }), { completed: 0, retrying: 0, blocked: 0 });
    assert.equal(remoteDeletes, 1); acknowledge.resolve();
    assert.deepEqual((await worker).value, { completed: 1, retrying: 0, blocked: 0 });
    const receipt = (await control.query("SELECT payload FROM handrail_ai_documents WHERE kind='conversation_file_cleanup' AND record_id='immutable-file'")).rows[0].payload;
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.target, undefined); assert.equal(receipt.conversationId, undefined);
    console.log('PASS external-file cleanup: invisible before commit, two workers dispatch once, completed receipt removes file identity');
  }
  {
    const conversationId = 'upload-dispatch-vs-delete'; const store = catalog(b);
    const current = (await create(store, conversationId)).descriptor;
    const entered = deferred(), release = deferred(); let puts = 0;
    const operations = new PostgresProviderOperationStore(persistence, 'fixture', 'fixture-uploads', conversationId);
    const upload = operations.run({ operationId: 'immutable-upload', requestFingerprint: 'fixture-body-fingerprint',
      execute: async () => { puts += 1; entered.resolve(); await release.promise; return { written: true }; },
      parseResult: value => value }).then(value => ({ value }), error => ({ error }));
    await Promise.race([entered.promise, upload.then(result => { if (result.error) throw result.error; })]);
    const request = { authorizationContext: actor, conversationId, expectedVersion: current.version, idempotencyKey: 'delete-after-upload' };
    await assert.rejects(store.permanentlyDelete(request), { code: 'unavailable' });
    release.resolve(); assert.equal((await upload).error, undefined);
    assert.equal((await store.permanentlyDelete(request)).status, 'deleted');
    await assert.rejects(operations.run({ operationId: 'late-upload', requestFingerprint: 'late',
      execute: async () => { puts += 1; return { written: true }; }, parseResult: value => value }), { code: 'conversation_deleted' });
    assert.equal(puts, 1);
    console.log('PASS external upload vs delete: admitted dispatch blocks deletion, completed dispatch permits deletion, late dispatch never runs');
  }
  {
    const conversationId = 'late-voice-tool-vs-delete'; const store = catalog(b);
    const current = (await create(store, conversationId)).descriptor;
    const calls = new PostgresRealtimeCallStore(new PostgresAiPersistence(b), 'fixture', 'voice-owner');
    await calls.admit({ callId: 'voice-call', conversationId, workerId: 'worker', fingerprint: 'settings' });
    await calls.beginCreation('voice-call', 'worker'); await calls.attachProviderCall('voice-call', 'worker', 'provider-call');
    const observed = deferred(), release = deferred(); let paused = false;
    const delayed = {
      async query(sql, values) {
        const result = await a.query(sql, values);
        if (!paused && sql.startsWith('SELECT') && values?.[1] === 'realtime_call') {
          paused = true; observed.resolve(); await release.promise;
        }
        return result;
      },
      transaction: a.transaction,
    };
    const late = new PostgresRealtimeToolActivityStore(
      new PostgresRealtimeCallStore(new PostgresAiPersistence(delayed), 'fixture', 'voice-owner'), 'voice-call')
      .record({ workerId: 'worker', toolCallId: 'late-tool', name: 'business_write', status: 'running' })
      .then(value => ({ value }), error => ({ error }));
    await Promise.race([observed.promise, late.then(result => { if (result.error) throw result.error; })]);
    await calls.requestEnd('voice-call'); await calls.confirmEnded('voice-call', 'provider-call');
    assert.equal((await store.permanentlyDelete({ authorizationContext: actor, conversationId,
      expectedVersion: current.version, idempotencyKey: 'delete-ended-voice' })).status, 'deleted');
    release.resolve(); assert.equal((await late).error.code, 'conversation_deleted');
    assert.equal((await control.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id='fixture' AND kind='realtime_tool_activity' AND scope_id=$1",
      [postgresRealtimeToolActivityScope('voice-owner', 'voice-call')])).rows.length, 0);
    assert.equal((await calls.get('voice-call')).status, 'ended');
    console.log('PASS voice activity vs delete: stale active-call read cannot admit a tool after hangup+deletion; termination receipt remains');
  }
  console.log('PASS native JSON contract and nine PostgreSQL concurrency cases; fixture contains no project data');
} finally {
  for (const release of releases) release();
  await Promise.allSettled(pools.map(sql => sql.end({ timeout: 1 })));
  if (started) run('pg_ctl', ['-D', join(work, 'data'), '-m', 'fast', '-w', 'stop']);
  await rm(work, { recursive: true, force: true });
  console.log('Disposable PostgreSQL cluster stopped and removed');
}
