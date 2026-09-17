/** Owns a disposable local cluster; intentionally never accepts a database URL. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresAiPersistence, PostgresDurableApplicationTurnStore, PostgresApprovalRecoveryQueue } from '../dist/postgres/index.js';
import { createDurableApplicationTransport } from '../dist/transports/durable.js';
import { createApplicationTurnTransport } from '../dist/transports/application-turn.js';
const [driver, binaries] = process.argv.slice(2);
if (!driver || !binaries || !isAbsolute(driver) || !isAbsolute(binaries)) throw new Error('Supply absolute pg module and PostgreSQL bin paths');
const { Pool } = (await import(pathToFileURL(driver).href)).default;
const directory = await mkdtemp('/tmp/handrail-recovery-postgres-'), data = join(directory, 'data'), socket = join(directory, 'socket');
await mkdir(socket, { mode: 0o700 });
const run = (name, args) => { const result = spawnSync(join(binaries, name), args, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr ?? result.error}`); return result.stdout.trim(); };
let server, pool, releaseRecovery, releaseAuthorization;
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const pending = id => ({ schemaVersion: 1, conversationId: id, turnId: 'turn', mutationId: 'admission', idempotencyKey: 'start',
  requestFingerprint: 'saved', request: 'saved', delegateTurnId: null, status: 'pending', attempt: 0, events: [], terminal: null,
  cancellation: null, lease: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const adapter = db => {
  const client = { async query(sql, values = []) { const result = await db.query(sql, values); return { rows: result.rows, rowCount: result.rowCount }; },
    async transaction(operation) {
      if (db !== pool) return operation(client);
      const connection = await pool.connect();
      try { await connection.query('BEGIN'); const value = await operation(adapter(connection)); await connection.query('COMMIT'); return value; }
      catch (cause) { await connection.query('ROLLBACK'); throw cause; } finally { connection.release(); }
    } }; return client;
};
const until = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); } throw new Error('Timed out waiting for owned recovery work'); };
const measure = async read => { const start = performance.now(), value = await read(); return { milliseconds: performance.now() - start, bytes: Buffer.byteLength(JSON.stringify(value)) }; };
try {
  run('initdb', ['-D', data, '--auth=trust', '--username=recovery', '--no-locale', '--encoding=UTF8']);
  server = spawn(join(binaries, 'postgres'), ['-D', data, '-k', socket, '-c', 'listen_addresses=', '-c', 'shared_buffers=64MB', '-c', 'work_mem=4MB'], { stdio: 'ignore' });
  let serverError; server.on('error', error => { serverError = error; });
  pool = new Pool({ host: socket, user: 'recovery', database: 'postgres', max: 4, connectionTimeoutMillis: 1000, statement_timeout: 15000 });
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch (cause) {
    if (serverError || server.exitCode !== null || i === 99) throw serverError ?? cause; await delay(100);
  } }
  const sql = adapter(pool), persistence = new PostgresAiPersistence(sql); await persistence.migrate(); await persistence.migrate();
  const sizes = [];
  for (const count of [20_000, 100_000]) {
    const tenant = `frames-${count}`, store = new PostgresDurableApplicationTurnStore(persistence, tenant);
    await store.create(pending('same-chat'));
    await pool.query(`UPDATE handrail_ai_documents SET payload=payload || jsonb_build_object('events',
      (SELECT jsonb_agg(jsonb_build_object('sequence',i,'checkpoint',jsonb_build_object('lastAppliedEventId','frame-'||i,
        'lastAppliedCursor','frame-'||i,'lastAppliedRevision',i),'event',jsonb_build_object('text','saved frame '||i))) FROM generate_series(1,$2::integer) i))
      WHERE tenant_id=$1 AND kind='durable_turn'`, [tenant, count]);
    const before = await measure(() => store.scanRecoverable(25));
    globalThis.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
    const samples = [];
    for (let i = 0; i < 10; i++) samples.push(await measure(() => store.scanRecoveryCandidates(25)));
    globalThis.gc?.(); const heapAfter = process.memoryUsage().heapUsed;
    assert.ok(before.bytes > count * 100); assert.ok(samples.every(sample => sample.bytes < 1024 && sample.milliseconds < 100));
    let bodyLoads = 0;
    const read = store.load.bind(store); store.load = (...args) => { bodyLoads++; return read(...args); };
    const denied = createDurableApplicationTransport({ store, workerId: 'denied', authorizeRecovery: () => false,
      delegate: createApplicationTurnTransport({ execute: async () => { throw new Error('Denied work was dispatched'); } }),
      requestCodec: { encode: value => value, decode: value => value, fingerprint: value => value }, checkpointForEvent: () => checkpoint });
    assert.deepEqual(await denied.recoverPendingPage({ limit: 25 }), { started: [], cursor: null }); assert.equal(bodyLoads, 0);
    sizes.push({ retainedFrames: count, legacySingleRead: before, metadataSamples: samples.length,
      metadataP95Milliseconds: [...samples].sort((a, b) => a.milliseconds - b.milliseconds)[9].milliseconds,
      metadataMaximumBytes: Math.max(...samples.map(sample => sample.bytes)), heapBefore, heapAfter, unauthorizedBodyLoads: bodyLoads });
  }
  const store = new PostgresDurableApplicationTurnStore(persistence, 'worker');
  await store.create(pending('shared'));
  const savedBeforeMigration = await store.load('shared', 'turn');
  await persistence.migrate();
  assert.deepEqual(await store.load('shared', 'turn'), savedBeforeMigration);
  let executions = 0, release;
  const gate = new Promise(resolve => { release = resolve; releaseRecovery = resolve; });
  const worker = id => createDurableApplicationTransport({ store, workerId: id, pollMilliseconds: 25, authorizeRecovery: () => true,
    delegate: createApplicationTurnTransport({ execute: async () => { executions++; await gate; return { status: 'completed', checkpoint }; } }),
    requestCodec: { encode: value => value, decode: value => value, fingerprint: value => value }, checkpointForEvent: () => checkpoint });
  await Promise.all([worker('one').recoverPendingPage(), worker('two').recoverPendingPage()]);
  await until(() => executions > 0); await delay(100); assert.equal(executions, 1); release();
  await until(async () => (await store.load('shared', 'turn'))?.record.status === 'completed');
  // A locked legacy row is skipped during preparation; rollback keeps its durable watermark.
  await store.create(pending('legacy'));
  await pool.query("UPDATE handrail_ai_documents SET durable_status=NULL WHERE tenant_id='worker' AND scope_id='legacy'");
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{status}','\"completed\"'),version=version+1 WHERE tenant_id='worker' AND scope_id='legacy'");
    assert.equal(await store.backfillRecoveryMetadata(10), 0);
    await connection.query('ROLLBACK'); assert.equal(await store.backfillRecoveryMetadata(10), 1);
  } finally { connection.release(); }
  // A writer can resolve the turn after discovery but before authorization returns.
  let authorizeEntered = false, authorizeRelease;
  const authorization = new Promise(resolve => { authorizeRelease = resolve; releaseAuthorization = resolve; });
  let staleExecutions = 0;
  const stale = createDurableApplicationTransport({ store, workerId: 'after-writer', authorizeRecovery: async () => { authorizeEntered = true; await authorization; return true; },
    delegate: createApplicationTurnTransport({ execute: async () => { staleExecutions++; return { status: 'completed', checkpoint }; } }),
    requestCodec: { encode: value => value, decode: value => value, fingerprint: value => value }, checkpointForEvent: () => checkpoint });
  const recovering = stale.recoverPendingPage(); await until(() => authorizeEntered);
  await pool.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{status}','\"completed\"'),version=version+1 WHERE tenant_id='worker' AND scope_id='legacy'");
  authorizeRelease(); assert.deepEqual((await recovering).started, []); assert.equal(staleExecutions, 0);
  assert.deepEqual((await store.scanRecoveryCandidates(25)).candidates, []);
  const approvalQueue = new PostgresApprovalRecoveryQueue(sql, 'approval-workers');
  await pool.query("SELECT handrail_ai_wake_approval_recovery('approval-workers','chat')");
  const approvalCandidate = (await approvalQueue.scan(25)).candidates[0];
  const approvalClaims = await Promise.all([approvalQueue.claim(approvalCandidate),
    new PostgresApprovalRecoveryQueue(sql, 'approval-workers').claim(approvalCandidate)]);
  assert.equal(approvalClaims.filter(Boolean).length, 1);
  const approvalClaim = approvalClaims.find(Boolean);
  // A separate connection commits a new decision before the first worker acks.
  await pool.query("SELECT handrail_ai_wake_approval_recovery('approval-workers','chat')");
  await approvalQueue.finish(approvalClaim, true);
  const newerApproval = (await approvalQueue.scan(25)).candidates[0];
  assert.notEqual(newerApproval.wakeId, approvalCandidate.wakeId);
  const resumedApproval = await approvalQueue.claim(newerApproval);
  assert.ok(resumedApproval);
  await approvalQueue.finish(resumedApproval, true);
  assert.deepEqual((await approvalQueue.scan(25)).candidates, []);
  console.log(JSON.stringify({ environment: { postgres: run('postgres', ['--version']), node: process.version,
    connection: 'owned disposable local Unix socket', nodeMaximumRssKiB: process.resourceUsage().maxRSS }, sizes,
    competingWorkers: 2, effectExecutions: executions, lockedLegacyRowsSkipped: true, repeatedMigrationPreservedState: true,
    postDiscoveryTerminalDispatches: staleExecutions,
    approvalClaimsWon: approvalClaims.filter(Boolean).length, newerApprovalDecisionSurvivedOldAck: true,
    budgets: { metadataPageBytes: 1024, localMetadataReadMaximumMs: 100, unauthorizedBodyLoads: 0, competingWorkerEffects: 1 },
    limitations: ['Synthetic adapter measurements, not HTTP or production latency.', 'Legacy latency is one baseline sample per size; metadata uses ten samples.',
      'The large retained frame fixtures are never executed; competing workers use a separate small admitted record.',
      'Tests local leases/CAS and metadata lifecycle, not host-wide recovery scheduling or graceful process shutdown.'] }, null, 2));
} finally {
  releaseRecovery?.(); releaseAuthorization?.();
  if (pool) await pool.end();
  if (server && server.exitCode === null) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  await rm(directory, { recursive: true, force: true });
}
