/** Local storage/API benchmark, not a production-network or browser benchmark.
 * Run after npm run build: node --expose-gc scripts/benchmark-display-history.mjs */
import { PGlite } from '@electric-sql/pglite';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import { PostgresAiPersistence, PostgresConversationDisplayHistory } from '../dist/postgres/index.js';

const database = new PGlite();
let measured = null;
const adapt = db => {
  const client = { async query(sql, values = []) {
    const start = performance.now();
    const result = await db.query(sql, [...values]);
    if (measured) {
      measured.queries++;
      measured.databaseMs += performance.now() - start;
      measured.databaseBytes += Buffer.byteLength(JSON.stringify(result.rows));
    }
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) };
  return client;
};
const client = { query: adapt(database).query, transaction: operation => database.transaction(tx => operation(adapt(tx))) };
const persistence = new PostgresAiPersistence(client);
const round = value => Math.round(value * 1000) / 1000;
const quantile = (values, p) => [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const reports = [];
const memoryPhases = [];
const memory = phase => { globalThis.gc?.(); memoryPhases.push({ phase, ...process.memoryUsage() }); };
try {
  await persistence.migrate();
  memory('schema-ready');
  for (const count of [20_000, 100_000]) {
    const tenant = `tenant-${count}`, conversation = 'history';
    await database.query(`INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,payload)
      SELECT $1,$2,i,'event-' || i,jsonb_build_object('version',1,'event_id','event-' || i,'conversation_id',$2::text,
        'revision',i,'occurred_at',to_char('2026-09-01'::timestamp + i*interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'actor',jsonb_build_object('type','system'),'source',jsonb_build_object('type','runtime'),
        'payload',jsonb_build_object('type','message.text_appended','message_id','message-' || ((i-1)/100),
          'turn_id','turn-' || ((i-1)/100),'text',repeat('x',80)))
      FROM generate_series(1,$3::integer) AS i`, [tenant, conversation, count]);
    memory(`seeded-${count}`);
    const display = new PostgresConversationDisplayHistory(client, tenant, 'owner', async () => {});
    const preparing = await display.page({ conversationId: conversation });
    if (preparing.status !== 'preparing' || preparing.records.length) throw new Error('Unprepared history leaked partial state');
    const start = performance.now();
    let steps = 0, progress;
    do { progress = await display.backfill(conversation, 1000); steps++; } while (progress.hasMore);
    const backfillMs = performance.now() - start;
    memory(`backfilled-${count}`);
    await database.query('ANALYZE handrail_ai_display_records');
    // Warm the database before recording repeatable steady-state reads.
    await display.page({ conversationId: conversation });
    const elapsed = [], databaseMs = [], databaseBytes = [], heapDelta = [];
    let bytes = 0, messages = 0;
    for (let i = 0; i < 30; i++) {
      globalThis.gc?.();
      const heapBefore = process.memoryUsage().heapUsed;
      measured = { queries: 0, databaseMs: 0, databaseBytes: 0 };
      const before = performance.now();
      const page = await display.page({ conversationId: conversation });
      const json = JSON.stringify({ ok: true, value: page });
      elapsed.push(performance.now() - before);
      databaseMs.push(measured.databaseMs); databaseBytes.push(measured.databaseBytes);
      heapDelta.push(process.memoryUsage().heapUsed - heapBefore);
      bytes = Buffer.byteLength(json); messages = page.records.length;
      if (measured.queries !== 1 || bytes > 65_536 || messages > 30 || page.status !== 'ready') {
        throw new Error('Display budget failed');
      }
      measured = null;
    }
    memory(`read-${count}`);
    const additionalReads = {};
    for (const [name, read] of [
      ['olderAnchor', () => display.page({ conversationId: conversation, anchor: {
        messageId: `message-${Math.floor(count / 200)}`, generation: 0, direction: 'older' } })],
      ['newerAnchor', () => display.page({ conversationId: conversation, anchor: {
        messageId: `message-${Math.floor(count / 200)}`, generation: 0, direction: 'newer', inclusive: true } })],
      ['recentChanges', () => display.changes({ conversationId: conversation, generation: 0, afterRevision: count - 100 })],
      ['idleChanges', () => display.changes({ conversationId: conversation, generation: 0, afterRevision: count })],
    ]) {
      const times = []; let largest = 0;
      for (let iteration = 0; iteration < 15; iteration++) {
        measured = { queries: 0, databaseMs: 0, databaseBytes: 0 };
        const start = performance.now(), page = await read();
        const wire = Buffer.byteLength(JSON.stringify({ ok: true, value: page }));
        times.push(performance.now() - start); largest = Math.max(largest, wire);
        if (measured.queries !== 1 || wire > 65536 || page.records.length > 30 || page.status !== 'ready') throw new Error(`${name} budget failed`);
        measured = null;
      }
      additionalReads[name] = { samples: times.length, queries: 1, maximumWireBytes: largest,
        p50Milliseconds: round(quantile(times, .5)), p95Milliseconds: round(quantile(times, .95)) };
    }
    const total = await database.query(`SELECT sum(octet_length(payload::text)) AS bytes
      FROM handrail_ai_events WHERE tenant_id=$1`, [tenant]);
    reports.push({ events: count, projectedMessages: count / 100, canonicalEventBytes: Number(total.rows[0].bytes),
      backfill: { steps, milliseconds: round(backfillMs) },
      firstPage: { messages, wireBytes: bytes, queries: 1, samples: elapsed.length,
        p50Milliseconds: round(quantile(elapsed, .5)), p95Milliseconds: round(quantile(elapsed, .95)),
        databaseP95Milliseconds: round(quantile(databaseMs, .95)), databaseBytes: Math.max(...databaseBytes),
        heapDeltaP95Bytes: quantile(heapDelta, .95) }, additionalReads });
    if (reports.at(-1).firstPage.p95Milliseconds > 50 || Object.values(additionalReads).some(read => read.p95Milliseconds > 50)) {
      throw new Error('Local steady-state display read exceeded the 50ms p95 smoke-test ceiling');
    }
    console.log(JSON.stringify({ completed: count, firstPage: reports.at(-1).firstPage }));
  }
  // Scope isolation pressure uses 30 independent partitions. PGlite executes on
  // one local connection, so this is explicitly not a PostgreSQL capacity claim.
  await database.query(`INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,payload)
    SELECT 'isolated-' || i,'same-id',1,'same-event',jsonb_build_object('version',1,'event_id','same-event',
      'conversation_id','same-id','revision',1,'occurred_at','2026-09-01T00:00:00Z',
      'actor',jsonb_build_object('type','system'),'source',jsonb_build_object('type','runtime'),
      'payload',jsonb_build_object('type','message.created','message_id','same-message','role','user',
        'content',jsonb_build_array(jsonb_build_object('type','text','text','Tenant ' || i))))
    FROM generate_series(1,30) i`);
  for (let index = 1; index <= 30; index++) {
    await new PostgresConversationDisplayHistory(client, `isolated-${index}`, 'same-owner', async () => {}).backfill('same-id');
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const store = new PostgresConversationDisplayHistory(client, `isolated-${index + 1}`, 'same-owner', async () => {});
    const page = await store.page({ conversationId: 'same-id' });
    if (page.status !== 'ready' || page.records.length !== 1 || page.revision !== 1 ||
      page.records[0].value.content[0].text !== `Tenant ${index + 1}`) throw new Error('Tenant isolation failure');
  }));
  console.log(JSON.stringify({ environment: { node: process.version, engine: 'PGlite, one connection, in-process',
    rssBytes: process.memoryUsage().rss, maximumRssKiB: process.resourceUsage().maxRSS }, reports, memoryPhases,
    isolatedPartitions: { count: 30, totalMilliseconds: round(performance.now() - start) },
    limits: { defaultWireBytes: 65536, maximumWireBytes: 262144, maximumPageRecords: 50, queriesPerPage: 1,
      localReadP95SmokeCeilingMilliseconds: 50 },
    limitations: ['Synthetic local storage only; not production HTTP timing.',
      'Heap/RSS include the database engine; browser rendering and Flutter memory are not measured.',
      'Backfill is a one-time migration cost; provider-context replay is a separate path.'] }, null, 2));
} finally { await database.close(); }
