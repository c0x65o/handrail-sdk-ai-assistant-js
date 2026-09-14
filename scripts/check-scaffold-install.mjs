// Qualification fixture only: a built scaffold with a real public Git install,
// an owned disposable PostgreSQL cluster, and synthetic provider/auth/usage seams.
// Accepts no database URL and imports no candidate SDK source or local alias.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const { Response, Headers, fetch } = globalThis;

if (process.argv.length !== 3 || !process.argv[2].startsWith('/')) {
  throw new Error('Pass the absolute path to a built, npm-installed standard scaffold. No database connection settings are accepted.');
}
const root = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const name = '@handrail/ai-assistant';
const source = manifest.dependencies[name];
assert.match(source, /^git\+https:\/\/github\.com\/c0x65o\/handrail-sdk-ai-assistant-js\.git#[0-9a-f]{40}$/u);
assert.equal(lock.packages[''].dependencies[name], source);
assert.equal(lock.packages[`node_modules/${name}`].resolved, source);
assert.equal(lock.packages[`node_modules/${name}`].link, undefined);
// npm 10 can leave the checked-in HTTPS lock unchanged while recording an SSH
// source in the installed tree. Qualification must check both resolutions.
const installedLock = JSON.parse(await readFile(join(root, 'node_modules/.package-lock.json'), 'utf8'));
assert.equal(installedLock.packages[`node_modules/${name}`].resolved, source);
assert.equal(installedLock.packages[`node_modules/${name}`].link, undefined);
const installedPackage = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
assert.equal(installedPackage.name, name);
assert.equal(installedPackage.version, lock.packages[`node_modules/${name}`].version);
assert.equal(await realpath(join(root, 'node_modules', name)), join(root, 'node_modules', name));
const installedRequire = createRequire(join(root, 'package.json'));
const installed = (specifier) => import(pathToFileURL(installedRequire.resolve(specifier)).href);
const generated = (path) => import(pathToFileURL(join(root, 'dist/server', path)).href);
const { AI_RUNTIME_PROTOCOL_VERSION } = await installed(name);
const { openaiResponses } = await installed(`${name}/server/assistant`);
const { createHandrailAiClient } = await installed(`${name}/client`);
const { createDatabase } = await generated('assistant/host/database.js');
const { createApplicationAssistant, stopAssistant } = await generated('assistant/server.js');
const { readConfig } = await generated('config.js');
const express = installedRequire('express');

const bin = process.env.SDK_POSTGRES_TEST_BIN ?? '/usr/lib/postgresql/15/bin';
const work = await mkdtemp('/tmp/sdk-scaffold-pg-');
const run = (command, args) => execFileSync(join(bin, command), args,
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
const context = (user, tenant = 'fixture-tenant') => ({ principalId: user, tenantId: tenant, scopeId: user,
  attribution: Object.fromEntries(Object.entries({ organization: 'fixture-org', project: 'fixture-project',
    service_environment: 'fixture-environment', known_user: user, session: 'fixture-session', automation: null })
    .map(([key, id]) => [key, { id, source: 'server_derived', trust: 'authoritative' }])) });
const contexts = { alice: context('alice'), bob: context('bob'), otherTenant: context('alice', 'other-tenant') };
// This injected seam exists ONLY in the fixture. The generated host ships no header login.
let permission = true;
const authorize = (request) => {
  const identity = request.headers.get('x-fixture-identity');
  const selected = Object.hasOwn(contexts, identity) ? contexts[identity] : null;
  if (!selected) throw new Response('Authentication required', { status: 401 });
  if (!permission) throw new Response('Permission denied', { status: 403 });
  return selected;
};
const environment = { APP_ORIGIN: 'http://127.0.0.1:3000', PORT: '3000',
  DATABASE_URL: 'configured-fixture', OPENAI_API_KEY: 'fixture-only-never-used', OPENAI_MODEL: 'fixture-model' };
for (const key of ['APP_ORIGIN', 'DATABASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL']) {
  assert.throws(() => readConfig({ ...environment, [key]: '' }), new RegExp(key));
}
for (const origin of ['bad-secret-value', 'https://user:secret@example.test', 'https://example.test/path']) {
  assert.throws(() => readConfig({ ...environment, APP_ORIGIN: origin }), (error) =>
    error.message.includes('APP_ORIGIN') && !error.message.includes(origin));
}
const doctor = spawnSync(process.execPath, [join(root, 'dist/server/doctor.js')],
  { cwd: root, encoding: 'utf8', env: { ...environment, APP_ORIGIN: '' }, timeout: 10_000 });
assert.equal(doctor.status, 1); assert.match(doctor.stderr, /APP_ORIGIN/u);
assert.doesNotMatch(doctor.stderr, /fixture-only-never-used/u);
console.log('PASS generated diagnostics identify missing/invalid settings without printing values or connecting');

const clients = new Set(); const hosts = new Set(); const pools = new Set();
let started = false; let providerCalls = 0; const delivered = new Map();
let usageAvailable = false;
const usage = { client: {
  async admit(input) { return { contract_version: 'v1', replayed: false,
    request: { id: input.idempotency_key, status: 'observing', project_id: 'fixture-project', capability_id: '',
      service_id: 'fixture', environment: 'fixture', provider: input.provider, model: input.model },
    policy_decision: { id: input.idempotency_key, policy_id: null, policy_version: null, enforcement_mode: 'observe',
      decision: 'allow', reason_code: 'fixture', created_at: new Date().toISOString() }, reservation: null }; },
  async settle(input) {
    if (!usageAvailable) throw new Error('Synthetic telemetry outage');
    for (const receipt of input.receipts) delivered.set(receipt.usage_receipt_id, receipt);
    return { contract_version: 'v1', request: {}, reservation: null, accepted_receipts: input.receipts.length, replayed_receipts: 0 };
  },
} };
function provider() {
  return openaiResponses({ model: 'fixture-model', transcription: false, request: async function* () {
    providerCalls += 1;
    yield { type: 'response.output_text.delta', delta: 'Synthetic persisted reply.' };
    yield { type: 'response.completed', response: { id: `fixture-response-${providerCalls}`, status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Synthetic persisted reply.' }] }],
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } };
  } });
}
async function close(host) {
  for (const client of clients) await client.dispose(); clients.clear();
  await new Promise((resolve, reject) => { host.server.close(error => error ? reject(error) : resolve());
    host.server.closeAllConnections(); });
  await stopAssistant(host.assistant); hosts.delete(host);
  await host.database.pool.end(); pools.delete(host.database.pool);
}
try {
  await mkdir(join(work, 'socket'));
  run('initdb', ['-D', join(work, 'data'), '--no-locale', '-E', 'UTF8', '-A', 'trust', '-U', 'fixture']);
  run('pg_ctl', ['-D', join(work, 'data'), '-l', join(work, 'postgres.log'), '-o',
    `-k ${join(work, 'socket')} -h '' -p 55519 -c shared_buffers=64MB -c max_connections=12`, '-w', 'start']);
  started = true;
  const connectionString = `postgresql://fixture@localhost:55519/postgres?host=${encodeURIComponent(join(work, 'socket'))}`;
  for (let pass = 0; pass < 2; pass += 1) {
    execFileSync(process.execPath, [join(root, 'dist/server/migrate.js')], { cwd: root,
      env: { DATABASE_URL: connectionString }, timeout: 30_000, stdio: 'pipe' });
  }
  console.log('PASS generated migration creates fresh SDK storage and can run again without importing legacy state');
  const host = async (auth) => {
    const database = createDatabase(connectionString); pools.add(database.pool);
    const assistant = await createApplicationAssistant({ persistence: database.persistence, provider: provider(), usage,
      diagnostics: diagnostic => { if (diagnostic.phase === 'failed') console.error('Fixture diagnostic:', diagnostic); },
      ...(auth ? { authorize: auth } : {}) });
    const app = express(); app.use('/api/assistant', assistant.express({ origin: environment.APP_ORIGIN }));
    const server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); listening.once('error', reject);
    });
    const value = { database, assistant, server, baseUrl: `http://127.0.0.1:${server.address().port}/api/assistant` };
    hosts.add(value); return value;
  };
  const denied = await host();
  const missingAuth = await fetch(`${denied.baseUrl}/capabilities`);
  assert.equal(missingAuth.status, 503); assert.match(await missingAuth.text(), /host_auth_not_configured/u);
  assert.equal(providerCalls, 0); await close(denied);
  console.log('PASS generated authentication seam fails closed through the real Express adapter');
  const client = async (owner, identity = 'alice') => {
    const value = await createHandrailAiClient({ baseUrl: owner.baseUrl, startActivityPolling: false,
      protectedRequest: input => ({ ...input, headers: { ...Object.fromEntries(new Headers(input.headers)), 'x-fixture-identity': identity } }),
      conversations: { mode: 'multiple', clientId: `fixture-${identity}`, authorize: () => 'allow' },
      buildRequest: ({ content }) => ({ protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
        messages: [{ role: 'user', content: [{ type: 'text', text: content }] }], tools: [], tool_results: [],
        generation: { max_output_tokens: 256, temperature: 0.2 }, correlation_hints: {} }),
    });
    clients.add(value); return value;
  };
  const first = await host(authorize);
  assert.equal((await fetch(`${first.baseUrl}/capabilities`)).status, 401);
  permission = false;
  assert.equal((await fetch(`${first.baseUrl}/capabilities`, { headers: { 'x-fixture-identity': 'alice' } })).status, 403);
  permission = true;
  const alice = await client(first); assert.equal(alice.capabilities.synchronization, true);
  const created = await alice.resources.createConversation({ title: 'Fresh fixture conversation', idempotencyKey: 'fixture-create' });
  const conversationId = created.descriptor.conversationId;
  for (const identity of ['bob', 'otherTenant']) {
    const foreign = await client(first, identity);
    assert.equal((await foreign.resources.listConversations({})).items.length, 0);
    await assert.rejects(foreign.resources.getConversation({ conversationId }), { resourceCode: 'not_found' });
  }
  const runtime = await alice.workspace.open({ conversationId, authorizationContext: {} });
  const sent = await runtime.sendMessage({ content: 'Fresh fixture question', request: alice.buildRequest({ content: 'Fresh fixture question' }) });
  if (sent.status !== 'completed') console.error('Synthetic fixture durable records:',
    JSON.stringify((await first.database.pool.query("SELECT payload FROM handrail_ai_documents WHERE kind='durable_turn'")).rows));
  assert.equal(sent.status, 'completed', JSON.stringify({ sent, turns: runtime.store.getSnapshot().turns }));
  assert.equal(runtime.store.getSnapshot().messages.at(-1).content[0].text, 'Synthetic persisted reply.');
  permission = false;
  await assert.rejects(alice.resources.getConversation({ conversationId }));
  permission = true;
  const flushed = await first.assistant.flushUsage(); assert.ok(flushed.pending > 0);
  await close(first);
  console.log('PASS authenticated create/send, user+tenant isolation, live permission revocation and durable usage during an outage');
  usageAvailable = true;
  const second = await host(authorize); const reopened = await client(second);
  const loaded = await reopened.workspace.open({ conversationId, authorizationContext: {} });
  assert.deepEqual(loaded.store.getSnapshot().messages.map(message => message.content[0].text),
    ['Fresh fixture question', 'Synthetic persisted reply.']);
  const callsBeforeReload = providerCalls;
  const found = await reopened.resources.getConversation({ conversationId });
  await reopened.resources.archiveConversation({ conversationId, expectedVersion: found.descriptor.version, idempotencyKey: 'fixture-archive' });
  const archived = await reopened.resources.getConversation({ conversationId });
  assert.equal(archived.descriptor.lifecycle, 'archived');
  await reopened.resources.restoreConversation({ conversationId, expectedVersion: archived.descriptor.version, idempotencyKey: 'fixture-restore' });
  assert.equal((await reopened.resources.getConversation({ conversationId })).descriptor.lifecycle, 'active');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await second.assistant.flushUsage(); if (delivered.size > 0) break; await delay(20);
  }
  assert.ok(delivered.size > 0); assert.equal(providerCalls, callsBeforeReload);
  console.log('PASS a new server+pool+client reloads canonical history, archive/restore and queued usage without re-executing the provider');
  await close(second);
  console.log(JSON.stringify({ qualification: 'installed-public-scaffold-synthetic-runtime', sdkSource: source,
    sdkVersion: lock.packages[`node_modules/${name}`].version, providerCalls, usageReceipts: delivered.size,
    liveProviderOrAudio: false, candidateDeletionQualified: false }));
} finally {
  for (const client of clients) await client.dispose().catch(() => {});
  for (const value of hosts) {
    value.server.closeAllConnections(); await new Promise(resolve => value.server.close(resolve));
    await stopAssistant(value.assistant).catch(() => {});
  }
  for (const pool of pools) await pool.end();
  if (started) run('pg_ctl', ['-D', join(work, 'data'), '-m', 'fast', '-w', 'stop']);
  await rm(work, { recursive: true, force: true });
  console.log('Disposable PostgreSQL cluster, clients, HTTP listeners and pools stopped and removed');
}
