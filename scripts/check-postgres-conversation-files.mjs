// Qualification fixture only. Owns a disposable cluster; accepts no database URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresAiPersistence, cleanupPostgresConversationFileStaging,
  deletePostgresConversationHistory } from '../dist/postgres/index.js';
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
    console.log('PASS concurrent materialization admits one conversation; two expiry workers remove one staging row and preserve its saved copy');
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
  console.log('PASS five native PostgreSQL retained-file concurrency cases; fixture contains no project data');
} finally {
  for (const release of releases) release();
  await Promise.allSettled(pools.map(sql => sql.end({ timeout: 1 })));
  if (started) run('pg_ctl', ['-D', join(work, 'data'), '-m', 'fast', '-w', 'stop']);
  await rm(work, { recursive: true, force: true });
  console.log('Disposable PostgreSQL cluster stopped and removed');
}
