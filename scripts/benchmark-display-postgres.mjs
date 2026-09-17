/** Isolated local PostgreSQL qualification; never accepts a database URL.
 * node --expose-gc scripts/benchmark-display-postgres.mjs /path/to/pg/index.js /path/to/postgres/bin
 * Uses an existing test driver without changing package declarations or locks.
 * Creates and removes its own 0700 temporary cluster, listening only on its socket.
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresAiPersistence, PostgresConversationCatalog, PostgresConversationDisplayHistory } from '../dist/postgres/index.js';

const [driver, binaries] = process.argv.slice(2);
if (!driver || !binaries || !isAbsolute(driver) || !isAbsolute(binaries)) throw new Error('Supply absolute paths to the existing pg module and PostgreSQL bin directory');
const { Pool } = (await import(pathToFileURL(resolve(driver)).href)).default;
const directory = await mkdtemp('/tmp/handrail-display-postgres-');
const data = join(directory, 'data'), socket = join(directory, 'socket');
await mkdir(socket, { mode: 0o700 });
const run = (name, args) => {
  const result = spawnSync(join(binaries, name), args, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr ?? result.error}`);
  return result.stdout.trim();
};
let server, pool;
const scope = new AsyncLocalStorage();
const round = value => Math.round(value * 1000) / 1000;
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const reports = [], memory = [];
const checkpoint = phase => { globalThis.gc?.(); memory.push({ phase, ...process.memoryUsage() }); };
const adapter = db => {
  const client = { async query(sql, values = []) {
    const start = performance.now(), result = await db.query(sql, [...values]);
    const sample = scope.getStore();
    if (sample) {
      sample.queries++; sample.databaseMilliseconds += performance.now() - start;
      sample.databaseBytes += Buffer.byteLength(JSON.stringify(result.rows));
      if (sql.startsWith('/* authorization */')) sample.authorizationQueries++;
      else sample.statements.push({ sql, values });
    }
    return { rows: result.rows, rowCount: result.rowCount };
  }, transaction: async operation => {
    if (db !== pool) return operation(client);
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const value = await operation(adapter(connection));
      await connection.query('COMMIT'); return value;
    } catch (cause) { await connection.query('ROLLBACK'); throw cause; }
    finally { connection.release(); }
  } };
  return client;
};
const summarizePlan = result => {
  const info = result.rows[0]['QUERY PLAN'][0], nodes = [];
  const visit = node => {
    if (node['Relation Name'] || node['Index Name']) nodes.push({ node: node['Node Type'], relation: node['Relation Name'],
      index: node['Index Name'], rows: node['Actual Rows'], loops: node['Actual Loops'],
      sharedHitBlocks: node['Shared Hit Blocks'], sharedReadBlocks: node['Shared Read Blocks'] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(info.Plan); return { executionMilliseconds: info['Execution Time'], nodes };
};
async function measure(read, validate) {
  const sample = { queries: 0, authorizationQueries: 0, databaseMilliseconds: 0, databaseBytes: 0, statements: [] };
  const start = performance.now();
  const value = await scope.run(sample, read);
  const json = JSON.stringify({ ok: true, value });
  sample.milliseconds = performance.now() - start; sample.wireBytes = Buffer.byteLength(json);
  validate(value, sample); return sample;
}
function summary(samples) {
  return { samples: samples.length, p50Milliseconds: round(quantile(samples.map(s => s.milliseconds), .5)),
    p95Milliseconds: round(quantile(samples.map(s => s.milliseconds), .95)),
    databaseP95Milliseconds: round(quantile(samples.map(s => s.databaseMilliseconds), .95)),
    maximumWireBytes: Math.max(...samples.map(s => s.wireBytes)),
    maximumDatabaseBytes: Math.max(...samples.map(s => s.databaseBytes)),
    maximumQueries: Math.max(...samples.map(s => s.queries)),
    maximumAuthorizationQueries: Math.max(...samples.map(s => s.authorizationQueries)) };
}
try {
  run('initdb', ['-D', data, '--auth=trust', '--username=benchmark', '--no-locale', '--encoding=UTF8']);
  server = spawn(join(binaries, 'postgres'), ['-D', data, '-k', socket, '-c', 'listen_addresses=',
    '-c', 'shared_buffers=64MB', '-c', 'work_mem=4MB', '-c', 'max_connections=40'], { stdio: ['ignore', 'ignore', 'ignore'] });
  const closed = new Promise((resolveClose, reject) => { server.once('error', reject); server.once('exit', resolveClose); });
  // Prevent an unhandled rejection while connection readiness is being checked.
  closed.catch(() => {});
  pool = new Pool({ host: socket, user: 'benchmark', database: 'postgres', max: 30,
    connectionTimeoutMillis: 1000, statement_timeout: 30_000 });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await pool.query('SELECT 1'); ready = true; break; }
    catch (cause) { if (server.exitCode !== null || attempt === 99) throw cause; await delay(100); }
  }
  if (!ready) throw new Error('Local cluster did not start');
  const client = adapter(pool), persistence = new PostgresAiPersistence(client);
  await persistence.migrate(); checkpoint('schema-ready');
  const conversation = 'shared-conversation-id', owner = 'same-owner';
  const catalog = tenant => new PostgresConversationCatalog({ persistence, tenantId: tenant,
    table: { name: 'handrail_ai_conversations', includeEventActivity: true },
    scopeId: context => context.owner, authorize: ({ authorizationContext }) => authorizationContext.owner === owner ? 'allow' : 'deny',
    createId: () => { throw new Error('Read benchmark cannot create conversations'); } });
  const display = tenant => new PostgresConversationDisplayHistory(client, tenant, owner, async id => {
    const found = await client.query(`/* authorization */ SELECT 1 FROM handrail_ai_conversations
      WHERE tenant_id=$1 AND scope_id=$2 AND conversation_id=$3`, [tenant, owner, id]);
    if (!found.rows.length) throw new Error('Forbidden');
  });
  const list = tenant => catalog(tenant).list({ authorizationContext: { owner }, lifecycle: 'active', pageSize: 5,
    order: { field: 'updated_at', direction: 'desc' } });
  const validateList = (value, sample) => {
    if (value.items.length !== 5 || sample.queries !== 1 || sample.wireBytes > 8192 ||
      value.items.some(item => item.metadata.marker !== sample.tenant)) throw new Error('Catalog payload, query or tenant budget failed');
  };
  const validatePage = (tenant, value, sample) => {
    if (value.status !== 'ready' || !value.records.length || value.records.length > 30 || sample.queries !== 3 ||
      sample.authorizationQueries !== 2 || sample.wireBytes > 65536 ||
      value.records.some(record => !record.value?.content?.[0]?.text.startsWith(`${tenant}:`))) throw new Error('History payload, query or tenant budget failed');
  };
  const measureList = tenant => measure(() => list(tenant), (value, sample) => { sample.tenant = tenant; validateList(value, sample); });
  const measurePage = tenant => measure(() => display(tenant).page({ conversationId: conversation }), (value, sample) => validatePage(tenant, value, sample));
  async function seed(tenant, count) {
    await pool.query(`INSERT INTO handrail_ai_conversations
      (tenant_id,scope_id,conversation_id,lifecycle,title,created_at,updated_at,version,metadata)
      SELECT $1,$2,CASE WHEN i=0 THEN $3 ELSE 'empty-'||i END,'active','Synthetic chat','2026-09-01','2026-09-01',1,
        jsonb_build_object('marker',$1::text) FROM generate_series(0,4) i`, [tenant, owner, conversation]);
    await pool.query(`INSERT INTO handrail_ai_events(tenant_id,conversation_id,revision,event_id,payload,created_at)
      SELECT $1,$2,i,'event-'||i,jsonb_build_object('version',1,'event_id','event-'||i,'conversation_id',$2::text,
        'revision',i,'occurred_at',to_char('2026-09-01'::timestamp + i*interval '1 millisecond','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'actor',jsonb_build_object('type','system'),'source',jsonb_build_object('type','runtime'),
        'payload',jsonb_build_object('type','message.text_appended','message_id','message-'||((i-1)/100),
          'turn_id','turn-'||((i-1)/100),'text',CASE WHEN (i-1)%100=0 THEN $1||':' ELSE '' END||repeat('x',80))),
        '2026-09-01'::timestamptz + i*interval '1 millisecond'
      FROM generate_series(1,$3::integer) i`, [tenant, conversation, count]);
  }
  // Full event histories and real projectors for both sizes, never a synthetic
  // fake checkpoint. The node process never fetches the full canonical log.
  for (const count of [20_000, 100_000]) {
    const tenant = `template-${count}`; await seed(tenant, count);
    const start = performance.now(); let progress, steps = 0;
    do { progress = await display(tenant).backfill(conversation, 1000); steps++; } while (progress.hasMore);
    const backfillMilliseconds = round(performance.now() - start);
    await pool.query('ANALYZE');
    // Before/after index evidence is confined to this owned disposable cluster.
    await pool.query('DROP INDEX handrail_ai_events_activity');
    const before = await measureList(tenant), statement = before.statements[0];
    const beforePlan = summarizePlan(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + statement.sql, statement.values));
    await pool.query('CREATE INDEX handrail_ai_events_activity ON handrail_ai_events(tenant_id,conversation_id,created_at DESC)');
    const after = await measureList(tenant);
    const afterPlan = summarizePlan(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + statement.sql, statement.values));
    if (!afterPlan.nodes.some(node => node.index === 'handrail_ai_events_activity' && node.rows <= 1)) throw new Error('Catalog activity lookup must use the constant-row index');
    const pages = [], lists = [];
    await measurePage(tenant); await measureList(tenant);
    checkpoint(`prepared-${count}`);
    for (let iteration = 0; iteration < 30; iteration++) { lists.push(await measureList(tenant)); pages.push(await measurePage(tenant)); }
    const pageStatement = pages[0].statements[0];
    const pagePlan = summarizePlan(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + pageStatement.sql, pageStatement.values));
    const report = { events: count, backfill: { steps, milliseconds: backfillMilliseconds }, list: summary(lists), firstPage: summary(pages),
      catalogActivityIndex: { beforeMilliseconds: round(before.milliseconds), afterMilliseconds: round(after.milliseconds), beforePlan, afterPlan }, firstPagePlan: pagePlan };
    reports.push(report);
    if (report.list.p95Milliseconds > 50 || report.firstPage.p95Milliseconds > 50) throw new Error('Local steady-state 50ms p95 read budget failed');
    console.error(`Prepared ${count} events; list p95 ${report.list.p95Milliseconds}ms, page p95 ${report.firstPage.p95Milliseconds}ms`);
  }
  // 30 full isolated event histories (1.8 million events) with identical record
  // IDs and ownership IDs. Copy projection fixtures already checked above;
  // project a fresh unique tenant marker to verify routing, not merely row counts.
  for (let index = 0; index < 30; index++) {
    const count = index % 2 ? 100_000 : 20_000, tenant = `isolated-${index}`, template = `template-${count}`;
    await seed(tenant, count);
    await pool.query(`INSERT INTO handrail_ai_display_heads SELECT $1,conversation_id,revision,generation,active_turn_id
      FROM handrail_ai_display_heads WHERE tenant_id=$2`, [tenant, template]);
    await pool.query(`INSERT INTO handrail_ai_display_records
      SELECT $1,conversation_id,kind,record_id,first_revision,revision,sort_at,turn_id,message_id,source_id,visible,
        replace(payload,$2,$1),octet_length(replace(payload,$2,$1)),deleted,control_payload
      FROM handrail_ai_display_records WHERE tenant_id=$2`, [tenant, template]);
    if ((index + 1) % 5 === 0) console.error(`Prepared ${index + 1}/30 isolated histories`);
  }
  await pool.query('ANALYZE');
  const tenants = Array.from({ length: 30 }, (_, index) => `isolated-${index}`);
  // Hold all 30 backend connections before timed work to verify this is a real
  // pool, not a single-connection driver serializing the tenant tasks.
  const connections = await Promise.all(tenants.map(() => pool.connect()));
  const backendPids = await Promise.all(connections.map(async connection => Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)));
  if (new Set(backendPids).size !== 30) throw new Error('Expected 30 independent PostgreSQL connections');
  connections.forEach(connection => connection.release());
  await Promise.all(tenants.map(async tenant => { await measureList(tenant); await measurePage(tenant); }));
  checkpoint('concurrency-ready');
  const lists = [], pages = [], bursts = [];
  for (let roundIndex = 0; roundIndex < 10; roundIndex++) {
    const start = performance.now();
    await Promise.all(tenants.map(async tenant => { lists.push(await measureList(tenant)); pages.push(await measurePage(tenant)); }));
    bursts.push(performance.now() - start);
  }
  checkpoint('concurrency-complete');
  const preparedHeap = memory.filter(item => item.phase.startsWith('prepared-')).map(item => item.heapUsed);
  const retainedHeapGrowth = memory.at(-1).heapUsed - memory.find(item => item.phase === 'concurrency-ready').heapUsed;
  if (Math.max(...preparedHeap) > 32 * 1024 * 1024 || retainedHeapGrowth > 16 * 1024 * 1024) {
    throw new Error('Retained Node heap budget failed');
  }
  // Cross-owner catalog access is denied, and foreign conversation content is
  // unavailable even though tenant peers reuse all the same record identities.
  let denied = false;
  try { await catalog(tenants[0]).list({ authorizationContext: { owner: 'foreign' }, lifecycle: 'active', pageSize: 5,
    order: { field: 'updated_at', direction: 'desc' } }); } catch { denied = true; }
  if (!denied) throw new Error('Owner isolation failure');
  let cursor;
  const own = await display(tenants[0]).page({ conversationId: conversation }); cursor = own.nextCursor;
  if (!cursor) throw new Error('Expected paginated fixture');
  denied = false;
  try { await display(tenants[1]).page({ conversationId: conversation, cursor }); } catch { denied = true; }
  if (!denied) throw new Error('Cross-tenant cursor accepted');
  const concurrent = { tenants: 30, fullCanonicalEvents: 1_800_000, backendConnections: new Set(backendPids).size,
    rounds: bursts.length, totalMilliseconds: round(bursts.reduce((a, b) => a + b, 0)),
    burstP95Milliseconds: round(quantile(bursts, .95)), list: summary(lists), firstPage: summary(pages) };
  if (concurrent.list.p95Milliseconds > 500 || concurrent.firstPage.p95Milliseconds > 500) throw new Error('Concurrent local 500ms p95 read budget failed');
  const backendMemory = [];
  for (const pid of [server.pid, ...backendPids]) {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = name => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    backendMemory.push({ rssKiB: kb('Rss'), proportionalSetKiB: kb('Pss'), privateDirtyKiB: kb('Private_Dirty') });
  }
  const report = { environment: { engine: run('postgres', ['--version']), node: process.version,
    connection: 'private local Unix socket; disposable cluster', sharedBuffersMiB: 64, workMemMiB: 4,
    durability: 'default fsync and synchronous_commit enabled', nodeMaximumRssKiB: process.resourceUsage().maxRSS },
    reports, concurrent, nodeMemory: memory,
    postgresMemory: { sampledProcesses: backendMemory.length, proportionalSetKiB: backendMemory.reduce((sum, item) => sum + item.proportionalSetKiB, 0),
      privateDirtyKiB: backendMemory.reduce((sum, item) => sum + item.privateDirtyKiB, 0) },
    budgets: { metadataWireBytes: 8192, defaultPageWireBytes: 65536, listQueries: 1, pageQueriesIncludingAuthorization: 3,
      steadyStateReadP95Milliseconds: 50, concurrentReadP95Milliseconds: 500,
      preparedNodeHeapBytes: 32 * 1024 * 1024, retainedConcurrentHeapGrowthBytes: 16 * 1024 * 1024 },
    limitations: ['Synthetic local PostgreSQL adapter timing; excludes HTTP, authentication middleware and production network.',
      '30 real database connections share one host; not a production capacity or 30-server deployment claim.',
      'PostgreSQL PSS samples cover the postmaster and client backends; background workers and OS cache are excluded.',
      'Wire bytes are exact serialized SDK envelopes, not captured HTTP bytes. Browser/Flutter render costs are separate.',
      'Concurrent projection fixtures are copied from the two validated backfills; concurrent writer/recovery correctness is tested separately.'] };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (pool) await pool.end();
  if (server && server.exitCode === null) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  await rm(directory, { recursive: true, force: true });
}
