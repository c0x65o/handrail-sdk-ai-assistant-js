import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers';
import test from 'node:test';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createHandrailAssistant, openaiResponses } from '@handrail/ai-assistant/server/assistant';
import { createHandrailAiClient, createApplicationGatewayTransport } from '@handrail/ai-assistant/client';
import { createToolPlugin, parseStreamEvent } from '@handrail/ai-assistant';
import { postgres } from '@handrail/ai-assistant/persistence/postgres';
import { createAgentConversationTransport, createAgentCheckpointReader, createJobAdmission, pg, z, baselineAssistant } from './fixtures/agent-cancellation/api.mjs';
import { createPostgresHarness, migrations } from './fixtures/agent-cancellation/database.mjs';
import { services, identity as baseIdentity } from './fixtures/agent-cancellation/host.mjs';

const fact = id => ({ id, source: 'server_derived', trust: 'authoritative' });
const context = { principalId: 'actor', tenantId: 'tenant', scopeId: 'actor', attribution: {
  organization: fact('org'), project: fact('project'), service_environment: fact('fixture'),
  known_user: fact('actor'), session: fact('session'), automation: fact(null) } };
const eventually = async predicate => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > deadline) throw Error('Timed out waiting for persisted state'); await new Promise(r => setTimeout(r, 25)); }
};

// Mirrors Mills nativeDecision('stop'): actual canonical client + gateway +
// durable wrapper + actual Agent/Runner + PostgreSQL. Only model responses and
// the external business effect are simulated. No deployed application is used.
for (const restart of (process.env.HANDRAIL_STOP_BASELINE === '1' ? [false] : [false, true, 'completed', 'generating', 'projector'])) test(`native Stop preserves the original Agent after observation ends (mode=${restart})`, { timeout: 25000 }, async t => {
  const completed = restart === 'completed', generating = restart === 'generating' || restart === 'projector';
  let releaseModel, enterModel, followup = false, revoked = false;
  const modelEntered = new Promise(r => enterModel = r), modelHeld = new Promise(r => releaseModel = r);
  t.after(() => releaseModel());
  const harness = await createPostgresHarness();
  const pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, max: 4 });
  const persistence = postgres(pool);
  let assistant, browser, agent;
  t.after(async () => { await browser?.dispose(); await agent?.close(); await assistant?.stopBackgroundWorkers(); await pool.end(); await harness.cleanup(); });
  await migrations(t, harness); await persistence.persistence.migrate();
  const sql = await harness.client();
  await sql.query(`CREATE TABLE ${harness.table('synthetic_provider')}(id text PRIMARY KEY,receipt text NOT NULL,attempts integer NOT NULL DEFAULT 1)`);
  await sql.query(`CREATE TABLE ${harness.table('bindings')}(conversation_id text, turn_id text, mutation_id text, identity jsonb, PRIMARY KEY(conversation_id,turn_id))`);
  const key = randomBytes(32).toString('hex');
  let activeScope, nativeCall, location, calls = 0;
  const externalEffects = [];
  const plugin = createToolPlugin({ pluginId: 'fixture', version: '1.0.0', displayName: 'Fixture',
    registrations: [{ definition: { name: 'reserve', description: 'Reserve synthetic item', input_schema: {
      type: 'object', properties: { itemRef: { type: 'string' } }, required: ['itemRef'], additionalProperties: false } },
      executor: async input => { externalEffects.push(input); return { saved: true }; } }],
    approvals: completed ? [] : [{ toolName: 'reserve', mode: 'always', summarize: () => 'Reserve synthetic item' }] });
  let jobIdentity = { ...baseIdentity, jobId: randomUUID(), requestKey: randomUUID(), originTaskRef: randomUUID() };
  const buildAgent = async () => {
    const instance = await services(harness.schema, key, {
      identity: jobIdentity,
      ...(followup ? { model: { async getResponse() { throw Error('STREAM_EXPECTED'); }, async *getStreamedResponse() {
        yield { type: 'response_started' };
        yield { type: 'response_done', response: { id: 'subsequent-response', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Subsequent authorized reply.' }] }], usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
      } } } : generating ? { modelHooks: { before: async () => { enterModel(); await modelHeld; } } } : {}),
      host: { requirement: call => ({ kind: 'approval', requirementRef: call.effectRef, revision: 1, actor: { kind: 'user', actorRef: 'actor' } }) },
      reserve: { name: 'reserve', description: 'Reserve synthetic item', kind: 'effect',
        // Valid controlled schema; catalog-wide repair is a separate assignment.
        parameters: z.object({ itemRef: z.string() }).strict(),
        bind: async call => {
          nativeCall = { name: call.toolName, tool_call_id: call.effectRef, arguments: call.input };
          return { identity: call.identity, effectRef: call.effectRef, idempotencyRef: call.effectRef,
            actionRef: 'reserve', operationRef: 'synthetic-reserve', providerRef: 'fixture', requestDigest: `sha256:${createHash('sha256').update(JSON.stringify(call)).digest('hex')}` };
        } },
      effectAdapter: {
        async dispatch(_request, signal) {
          calls++;
          let result = await activeScope.tools.execute(nativeCall, signal, location);
          if (result.status === 'external_approval_required') result = await activeScope.tools.awaitApproval({ ...location, call: nativeCall, signal });
          if (completed) { assert.equal(result.status, 'completed'); return { outcome: 'verified', receiptRef: 'native-execution' }; }
          assert.equal(result.status, 'external_approval_required'); return { outcome: 'unknown' };
        },
        async reconcile() { return calls === 0 ? { outcome: 'not_applied', evidenceRef: 'controlled-fixture-before-dispatch' } : { outcome: 'unknown' }; },
      },
    });
    return instance;
  };
  agent = await buildAgent();
  const make = () => (process.env.HANDRAIL_STOP_BASELINE === '1' ? baselineAssistant : createHandrailAssistant)({ id: 'agent-stop', authorize: () => { if (revoked) throw Error('Fixture scope revoked'); return context; }, persistence, automaticTitles: false, tools: [plugin],
    diagnostics: e => { if(e.phase === 'failed') console.log('gateway fixture diagnostic',e.operation,e.code, e.cause instanceof TypeError ? e.cause.message : ''); },
    provider: { metadata: openaiResponses({ model: 'fixture', request: () => { throw Error('unused'); } }).metadata, async createTransport(scope) {
      activeScope = scope;
      const admission = createJobAdmission({ newJobId: () => jobIdentity.jobId,
        authorizeSubmit: async () => ({ namespaceRef: 'fixture', host: jobIdentity.host, grantRevision: 1,
          native: jobIdentity.native, origin: jobIdentity.origin }) }, agent.admission);
      const read = createAgentCheckpointReader({ runtime: agent.runtime, attribution: async () => context.attribution,
        pendingToolCallIds: async () => [nativeCall.tool_call_id] });
      return createAgentConversationTransport({ runtime: agent.runtime, pollMs: 5,
        capabilities: { documentInput: { supported: false }, attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
        host: {
          async admit(input) {
            location = { conversationId: input.conversationId, turnId: input.conversationTurnId };
            const result = await admission.submit({ originTaskRef: jobIdentity.originTaskRef, requestKey: jobIdentity.requestKey,
              instructionRevision: 1, operation: { operationRef: 'fixture-agent-v1', inputRefs: { inputRef: 'fixture' } } });
            assert.equal(result.ok, true, JSON.stringify(result));
            assert.equal(result.value.jobId, jobIdentity.jobId);
            await sql.query(`INSERT INTO ${harness.table('bindings')} VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
              [input.conversationId, input.conversationTurnId, input.mutationId, JSON.stringify(jobIdentity)]);
            return { identity: jobIdentity, turnId: input.conversationTurnId, mutationId: input.mutationId };
          },
          async lookup(input) {
            if (revoked) throw Error('Fixture scope revoked');
            const row = (await sql.query(`SELECT * FROM ${harness.table('bindings')} WHERE conversation_id=$1 AND turn_id=$2`, [input.conversationId, input.turnId])).rows[0];
            if (!row) throw Error('not authorized');
            return { identity: row.identity, turnId: row.turn_id, mutationId: row.mutation_id };
          }, read,
          async cancel(binding) {
            if (restart === true) throw Error('Simulated unavailable Stop receiver before process exit');
            const snapshot = (await agent.runtime.inspect(binding.identity)).value.snapshot;
            if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) return 'already_terminal';
            const result = await agent.cancel.stop({ command: 'cancel', identity: binding.identity,
              expectedRevision: snapshot.revision, reason: 'explicit_stop' }, 'actor');
            assert.equal(result.ok, true, JSON.stringify(result)); return 'cancellation_requested';
          },
        } });
    } } });
  assistant = await make();
  const post = (path, body) => assistant.handle(new globalThis.Request(`https://fixture.test/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const response = await post('conversations/create', { title: 'Controlled native Stop', idempotencyKey: randomUUID() });
  assert.equal(response.status, 200);
  const conversationId = (await response.json()).value.descriptor.conversationId;
  browser = await createHandrailAiClient({ baseUrl: 'https://fixture.test', startActivityPolling: false, restoreActiveTurns: false, decodeEvent: parseStreamEvent,
    fetch: (url, init) => assistant.handle(new globalThis.Request(url, init)), conversations: { mode: 'multiple', clientId: 'fixture', authorize: () => 'allow' } });
  const runtime = await browser.registry.open({ conversationId, authorizationContext: null }); await runtime.synchronize();
  let turnId;
  const content = 'Read synthetic stock and reserve an item';
  const observing = runtime.sendMessage({ content, request: { protocol_version: 'handrail.ai-runtime.v1', continuation_of: null,
    messages: [{ role: 'user', content: [{ type: 'text', text: content }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 8000, temperature: 0.2 }, correlation_hints: {} }, onAccepted: accepted => { turnId = accepted.turnId; } });
  void observing.catch(() => {});
  if (generating) await modelEntered;
  else {
    await eventually(async () => (await agent.runtime.inspect(jobIdentity)).value?.snapshot.state === (completed ? 'succeeded' : 'waiting'));
    assert.equal((await observing).status, completed ? 'completed' : 'waiting_for_approval');
  }
  const before = (await sql.query(`SELECT * FROM ${harness.table('bindings')}`)).rows;
  const beforeAgent = (await agent.runtime.inspect(jobIdentity)).value;
  const effectRefs = beforeAgent.snapshot.effects.map(effect => effect.effectRef);
  if (!generating) assert.ok(effectRefs.includes(nativeCall.tool_call_id));
  if (completed) {
    assert.equal((await post('turns/cancel', { conversationId, turnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user' })).status, 200);
    const afterAgent = (await agent.runtime.inspect(jobIdentity)).value;
    assert.equal(afterAgent.snapshot.state, 'succeeded');
    assert.deepEqual(afterAgent.snapshot.effects, beforeAgent.snapshot.effects);
    assert.equal(afterAgent.checkpoint.output, beforeAgent.checkpoint.output);
    assert.equal(externalEffects.length, 1); assert.equal(calls, 1);
    assert.deepEqual((await sql.query(`SELECT * FROM ${harness.table('bindings')}`)).rows, before);
    console.log('Completed native effect/result preserved; Stop did not relabel or replay it.');
    return;
  }
  if (!generating) {
  const proposals = await pool.query("SELECT payload FROM handrail_ai_approvals WHERE group_id=$1", [conversationId]);
  assert.equal(proposals.rows.length, 1); assert.equal(proposals.rows[0].payload.status, 'pending');
  assert.equal(externalEffects.length, 0); assert.equal(calls, 1);
  await runtime.resumeTurn(turnId);
  assert.equal((await agent.runtime.inspect(jobIdentity)).value.snapshot.state, 'waiting');
  }
  if (restart === true) {
    assert.equal((await post('turns/cancel', { conversationId, turnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user' })).status, 200);
    await eventually(async () => {
      const record = (await activeScope.persistence.durableTurns.load(conversationId, turnId))?.record;
      return record?.status === 'pending' && record.cancellation?.mutationId === 'stop' && record.lease === null;
    });
    assert.equal((await agent.runtime.inspect(jobIdentity)).value.snapshot.state, 'waiting');
    await assistant.stopBackgroundWorkers(); await agent.close();
    const child = spawnSync(process.execPath, ['test/agent-stop-process.mjs'], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HANDRAIL_STOP_FIXTURE: JSON.stringify({ schema: harness.schema, key, identity: jobIdentity,
        context, conversationId, turnId, effectRef: nativeCall.tool_call_id }) } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    console.log(child.stdout.trim());
    agent = await buildAgent();
    assistant = await make();
  } else if (restart === 'projector') {
    // Independent authorized Stop reaches the actual Agent; the observing
    // gateway must persist the checkpoint reader's explicit_stop frame.
    const snapshot = (await agent.runtime.inspect(jobIdentity)).value.snapshot;
    const stopped = await agent.cancel.stop({ command: 'cancel', identity: jobIdentity,
      expectedRevision: snapshot.revision, reason: 'explicit_stop' }, 'actor');
    assert.equal(stopped.ok, true);
  } else {
    const stopped = await post('turns/cancel', { conversationId, turnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user' });
    assert.equal(stopped.status, 200);
  }
  await eventually(async () => (await agent.runtime.inspect(jobIdentity)).value.snapshot.state === 'cancelled');
  releaseModel();
  if (generating) assert.equal((await observing).status, 'cancelled');
  assert.deepEqual((await sql.query(`SELECT * FROM ${harness.table('bindings')}`)).rows, before);
  const retained = (await sql.query(`SELECT snapshot FROM ${harness.table('job_checkpoints')} WHERE job_id=$1`, [jobIdentity.jobId])).rows[0];
  assert.equal(retained.snapshot.state, 'cancelled');
  assert.deepEqual(retained.snapshot.effects.map(effect => effect.effectRef), effectRefs);
  assert.equal(externalEffects.length, 0); assert.equal(calls, generating ? 0 : 1);
  assert.equal(retained.snapshot.cancellation.reason, 'explicit_stop');
  await eventually(async () => (await activeScope.persistence.durableTurns.load(conversationId, turnId))?.record.status === 'cancelled');
  await eventually(async () => (await pool.query("SELECT 1 FROM handrail_ai_events WHERE conversation_id=$1 AND payload->'payload'->>'type'='turn.cancelled'", [conversationId])).rowCount === 1);
  if (restart === 'projector') {
    const record = (await activeScope.persistence.durableTurns.load(conversationId, turnId)).record;
    assert.equal(record.cancellation, null);
    assert.equal(record.events.filter(({ event }) => event.type === 'response.cancelled' && event.reason === 'explicit_stop').length, 1);
    const wire = createApplicationGatewayTransport({ baseUrl: 'https://fixture.test', decodeEvent: parseStreamEvent,
      fetch: (url, init) => assistant.handle(new globalThis.Request(url, init)) });
    const resumed = await wire.resumeTurn({ conversationId, turnId,
      resumeFrom: { lastAppliedCursor: null, lastAppliedEventId: null, lastAppliedRevision: null } });
    assert.equal(resumed.ok, true);
    const decoded = []; for await (const event of resumed.value.events) decoded.push(event);
    assert.equal(decoded.at(-1).reason, 'explicit_stop');
    const terminal = await resumed.value.result; assert.equal(terminal.status, 'cancelled');
    const replay = await wire.resumeTurn({ conversationId, turnId, resumeFrom: terminal.checkpoint });
    assert.equal(replay.ok, true);
    const duplicates = []; for await (const event of replay.value.events) duplicates.push(event);
    assert.deepEqual(duplicates, []);
    revoked = true;
    assert.equal((await wire.resumeTurn({ conversationId, turnId, resumeFrom: terminal.checkpoint })).ok, false);
    revoked = false;
  }
  const stop = { conversationId, turnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user' };
  assert.equal((await post('turns/cancel', stop)).status, 200);
  await browser.dispose();
  browser = await createHandrailAiClient({ baseUrl: 'https://fixture.test', startActivityPolling: false, restoreActiveTurns: false, decodeEvent: parseStreamEvent,
    fetch: (url, init) => assistant.handle(new globalThis.Request(url, init)), conversations: { mode: 'multiple', clientId: 'reload', authorize: () => 'allow' } });
  const fresh = await browser.registry.open({ conversationId, authorizationContext: null });
  await fresh.synchronize();
  const stoppedTurn = fresh.getSnapshot().turns.find(t => t.turn_id === turnId);
  assert.equal(stoppedTurn.status, 'cancelled');
  assert.equal(stoppedTurn.cancellation_reason, 'user');
  assert.equal(stoppedTurn.remote_may_still_be_running, false);
  assert.equal(fresh.getSnapshot().active_turn_id, null);
  const history = () => pool.query("SELECT payload FROM handrail_ai_events WHERE conversation_id=$1 AND payload->'payload'->>'type'='turn.cancelled'", [conversationId]);
  const terminalRows = await history(); assert.equal(terminalRows.rowCount, 1);
  await fresh.synchronize();
  assert.deepEqual((await history()).rows, terminalRows.rows);
  revoked = true;
  assert.notEqual((await post('turns/cancel', stop)).status, 200);
  assert.deepEqual((await history()).rows, terminalRows.rows);
  revoked = false;

  // A fresh Dart process decodes real HTTP gateway history from this PostgreSQL
  // fixture. The package-config override qualifies source, never an installed app.
  if (process.env.HANDRAIL_PROJECTION_DART) {
    const server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await assistant.handle(new globalThis.Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) }));
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const child = spawn(process.env.HANDRAIL_PROJECTION_DART, [
        `--packages=${process.env.HANDRAIL_PROJECTION_DART_PACKAGES ?? 'test/fixtures/agent-cancellation/dart/.dart_tool/package_config.json'}`,
        'test/fixtures/agent-cancellation/dart/projection.dart', `http://127.0.0.1:${server.address().port}`, conversationId, turnId, 'cancelled', 'user'],
        { timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
      const [code] = await once(child, 'exit'); assert.equal(code, 0, output); console.log(output.trim());
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  await assistant.stopBackgroundWorkers(); await agent.close(); followup = true;
  jobIdentity = { ...baseIdentity, jobId: randomUUID(), requestKey: randomUUID(), originTaskRef: randomUUID() };
  agent = await buildAgent();
  assistant = await make();
  const next = await fresh.sendMessage({ content: 'A new authorized turn', request: { protocol_version: 'handrail.ai-runtime.v1', continuation_of: null,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A new authorized turn' }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 8000, temperature: 0.2 }, correlation_hints: {} } });
  assert.equal(next.status, 'completed'); await fresh.synchronize();
  assert.equal(fresh.getSnapshot().turns.find(t => t.turn_id === turnId).cancellation_reason, 'user');
  assert.ok(JSON.stringify(fresh.getSnapshot().messages).includes('Subsequent authorized reply.'));
  assert.equal(externalEffects.length, 0);
  assert.equal((await history()).rowCount, 1);
  console.log('PostgreSQL Agent Stop -> canonical user cancellation -> browser/Dart reload; replay and scope fencing; subsequent authorized reply, no cancelled effect.');
});
