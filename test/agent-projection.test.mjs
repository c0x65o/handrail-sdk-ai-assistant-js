import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createHandrailAssistant, openaiResponses } from '@handrail/ai-assistant/server/assistant';
import { createHandrailAiClient } from '@handrail/ai-assistant/client';
import { createToolPlugin } from '@handrail/ai-assistant';
import { postgres } from '@handrail/ai-assistant/persistence/postgres';
import { createAgentConversationTransport, createAgentCheckpointReader, createJobAdmission, pg, z, baselineAssistant } from './fixtures/agent-cancellation/api.mjs';
import { createPostgresHarness, migrations } from './fixtures/agent-cancellation/database.mjs';
import { services, modelBoundary, identity as baseIdentity } from './fixtures/agent-cancellation/host.mjs';

const fact = id => ({ id, source: 'server_derived', trust: 'authoritative' });
const baseContext = { principalId: 'actor', tenantId: 'tenant', scopeId: 'actor', attribution: {
  organization: fact('org'), project: fact('project'), service_environment: fact('fixture'),
  known_user: fact('actor'), session: fact('session'), automation: fact(null) } };
const eventually = async predicate => {
  const deadline = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > deadline) throw Error('Timed out waiting for persisted state'); await new Promise(r => setTimeout(r, 25)); }
};

// Mirrors Mills nativeDecision('stop'): actual canonical client + gateway +
// durable wrapper + actual Agent/Runner + PostgreSQL. Only model responses and
// the external business effect are simulated. No deployed application is used.
for (const scenario of (process.env.HANDRAIL_STOP_BASELINE === '1' ? ['quota-stop'] : ['quota-stop', 'interrupted-quota-stop', 'completed', 'interrupted-completed', 'unknown-stop'])) test(`canonical projection after native approval and restart (${scenario})`, { timeout: 45000 }, async t => {
  const context = globalThis.structuredClone(baseContext);
  const interrupted = scenario.startsWith('interrupted-');
  let blockTerminalWrites = false, blockedWrites = 0, revoked = false;
  const completed = scenario.endsWith('completed');
  const expected = completed ? 'completed' : 'cancelled';
  const unknown = scenario === 'unknown-stop';
  const harness = await createPostgresHarness();
  const pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, max: 4 });
  const wrap = client => ({query: async (sql, values) => {
    if (blockTerminalWrites && sql.startsWith('INSERT INTO handrail_ai_events') && JSON.parse(values.at(-1)).payload.type === `turn.${expected}`) {
      blockedWrites++; throw Error('Simulated projection storage interruption');
    }
    return client.query(sql, values);
  }, release: () => client.release()});
  const persistence = postgres({query: (...args) => pool.query(...args), connect: async () => wrap(await pool.connect())});
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
    registrations: [{ definition: { name: 'lookup', description: 'Read fixture', input_schema: {type: 'object', properties: {topic: {type: 'string'}}, required: ['topic'], additionalProperties: false} }, executor: async () => ({value: 7}) }, { definition: { name: 'reserve', description: 'Reserve synthetic item', input_schema: {
      type: 'object', properties: { itemRef: { type: 'string' } }, required: ['itemRef'], additionalProperties: false } },
      executor: async input => { externalEffects.push(input); return { saved: true }; } }],
    approvals: [{ toolName: 'reserve', mode: 'always', summarize: () => 'Reserve synthetic item' }] });
  const jobIdentity = { ...baseIdentity, jobId: randomUUID(), requestKey: randomUUID(), originTaskRef: randomUUID() };
  const buildAgent = async () => {
    const instance = await services(harness.schema, key, {
      identity: jobIdentity,
      model: modelBoundary('inventory', { before: async request => { if (scenario.endsWith('quota-stop') && Array.isArray(request.input) && request.input.filter(i => i.type === 'function_call_result').length >= 2) throw Error('insufficient_quota:credit_balance_exhausted (simulated)'); } }),
      read: async (call, signal) => { const result = await activeScope.tools.execute({name: call.toolName, tool_call_id: call.effectRef, arguments: call.input}, signal, location); assert.equal(result.status, 'completed'); return JSON.stringify(result.result); },
      host: { resolveWait: async snapshot => snapshot.answer ? {receiptRef: snapshot.answer.responseRef} : null, requirement: call => ({ kind: unknown && externalEffects.length ? 'reconciliation' : 'approval', requirementRef: call.effectRef, revision: 1, actor: { kind: 'user', actorRef: 'actor' } }) },
      reserve: { name: 'reserve', description: 'Reserve synthetic item', kind: 'effect',
        // Controlled tool input; the full Mills catalog is outside this fixture.
        parameters: z.object({ itemRef: z.string() }).strict(),
        bind: async call => {
          nativeCall = { name: call.toolName, tool_call_id: call.effectRef, arguments: call.input };
          return { identity: call.identity, effectRef: call.effectRef, idempotencyRef: call.effectRef,
            actionRef: 'reserve', operationRef: 'synthetic-reserve', providerRef: 'fixture', requestDigest: `sha256:${createHash('sha256').update(JSON.stringify(call)).digest('hex')}` };
        } },
      effectAdapter: {
        async dispatch(request, signal) {
          assert.equal(request.effectRef, nativeCall.tool_call_id);
          calls++;
          const proposals = await activeScope.persistence.approvals.listGroup({permissionContext: context, groupId: location.conversationId});
          let result = proposals.length ? await activeScope.tools.awaitApproval({...location, call: nativeCall, signal}) : await activeScope.tools.execute(nativeCall, signal, location);
          if (result.status === 'external_approval_required') result = await activeScope.tools.awaitApproval({ ...location, call: nativeCall, signal });
          if (result.status === 'completed') return unknown ? {outcome: 'unknown'} : { outcome: 'verified', receiptRef: 'native-execution' };
          assert.equal(result.status, 'external_approval_required'); return { outcome: 'unknown' };
        },
        async reconcile() {
          if (externalEffects.length) return unknown ? {outcome: 'unknown'} : {outcome: 'verified', receiptRef: 'native-execution'};
          const proposals = await activeScope.persistence.approvals.listGroup({permissionContext: context, groupId: location.conversationId});
          return calls === 0 || proposals.some(p => p.status === 'confirmed') ? {outcome: 'not_applied', evidenceRef: 'native-no-dispatch'} : {outcome: 'unknown'};
        },
      },
    });
    return instance;
  };
  agent = await buildAgent();
  const answerNative = async () => {
    const inspected = await agent.runtime.inspect(jobIdentity);
    if (!inspected.ok || inspected.value.snapshot.state !== 'waiting' || inspected.value.snapshot.requirement.kind !== 'approval' || inspected.value.snapshot.answer) return;
    const snapshot = inspected.value.snapshot;
    const proposals = await activeScope.persistence.approvals.listGroup({permissionContext: context, groupId: location.conversationId});
    const proposal = proposals.find(p => p.status === 'confirmed' || p.status === 'executed');
    if (!proposal) return;
    const responseRef = `native:${proposal.proposal_id}`;
    assert.equal((await agent.answer.issue({identity: jobIdentity, requirement: snapshot.requirement, jobRevision: snapshot.revision, expiresAt: Date.now() + 300000, resolverRef: 'actor'})).ok, true);
    assert.equal((await agent.answer.complete({identity: jobIdentity, requirementRef: snapshot.requirement.requirementRef, requirementRevision: snapshot.requirement.revision, resolverRef: 'actor', deliveryKey: responseRef, status: 'verified', responseRef})).ok, true);
  };
  const make = () => (process.env.HANDRAIL_STOP_BASELINE === '1' ? baselineAssistant : createHandrailAssistant)({ id: 'agent-stop', authorize: request => request.headers.get('x-fixture-user') === 'other'
      ? {...context, principalId: 'other', scopeId: 'other', attribution: {...context.attribution, known_user: fact('other')}} : context, persistence, automaticTitles: false, tools: [plugin],
    authorizeConversation: ({authorizationContext}) => !revoked && authorizationContext.principalId === context.principalId ? 'allow' : 'deny',
    diagnostics: e => { if(e.phase === 'failed') console.log('gateway fixture diagnostic',e.operation,e.code);  },
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
            await answerNative();
            return { identity: jobIdentity, turnId: input.conversationTurnId, mutationId: input.mutationId };
          },
          async lookup(input) {
            const row = (await sql.query(`SELECT * FROM ${harness.table('bindings')} WHERE conversation_id=$1 AND turn_id=$2`, [input.conversationId, input.turnId])).rows[0];
            if (!row) throw Error('not authorized');
            await answerNative();
            return { identity: row.identity, turnId: row.turn_id, mutationId: row.mutation_id };
          }, read,
          async cancel(binding) {
            const snapshot = (await agent.runtime.inspect(binding.identity)).value.snapshot;
            if (['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) return 'already_terminal';
            const result = await agent.cancel.stop({ command: 'cancel', identity: binding.identity,
              expectedRevision: snapshot.revision, reason: 'explicit_stop' }, 'actor');
            assert.equal(result.ok, true, JSON.stringify(result)); return 'cancellation_requested';
          },
        } });
    } } });
  assistant = await make();
  const post = (path, body, headers = {}) => assistant.handle(new globalThis.Request(`https://fixture.test/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  const response = await post('conversations/create', { title: 'Controlled native Stop', idempotencyKey: randomUUID() });
  assert.equal(response.status, 200);
  const conversationId = (await response.json()).value.descriptor.conversationId;
  browser = await createHandrailAiClient({ baseUrl: 'https://fixture.test', startActivityPolling: false, restoreActiveTurns: false,
    fetch: (url, init) => assistant.handle(new globalThis.Request(url, init)), conversations: { mode: 'multiple', clientId: 'fixture', authorize: () => 'allow' } });
  const runtime = await browser.registry.open({ conversationId, authorizationContext: null }); await runtime.synchronize();
  let turnId;
  const content = 'Read synthetic stock and reserve an item';
  const observing = runtime.sendMessage({ content, request: { protocol_version: 'handrail.ai-runtime.v1', continuation_of: null,
    messages: [{ role: 'user', content: [{ type: 'text', text: content }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 8000, temperature: 0.2 }, correlation_hints: {} }, onAccepted: accepted => { turnId = accepted.turnId; } });
  void observing.catch(() => {});
  await eventually(async () => (await agent.runtime.inspect(jobIdentity)).value?.snapshot.state === 'waiting');
  assert.equal((await observing).status, 'waiting_for_approval');
  const before = (await sql.query(`SELECT * FROM ${harness.table('bindings')}`)).rows;
  const beforeAgent = (await agent.runtime.inspect(jobIdentity)).value;
  const effectRefs = beforeAgent.snapshot.effects.map(effect => effect.effectRef);
  assert.ok(effectRefs.includes(nativeCall.tool_call_id));
  const proposals = await pool.query("SELECT payload FROM handrail_ai_approvals WHERE group_id=$1", [conversationId]);
  assert.equal(proposals.rows.length, 1); assert.equal(proposals.rows[0].payload.status, 'pending');
  assert.equal(externalEffects.length, 0); assert.equal(calls, 1);
  if (process.env.HANDRAIL_STOP_BASELINE !== '1') {
    const unauthorizedStop = {conversationId, turnId, mutationId: 'isolation-stop', idempotencyKey: 'isolation-stop', reason: 'user'};
    assert.notEqual((await post('turns/cancel', unauthorizedStop, {'x-fixture-user': 'other'})).status, 200);
    revoked = true;
    try { assert.notEqual((await post('turns/cancel', unauthorizedStop)).status, 200); }
    finally { revoked = false; }
    const other = await post('conversations/create', {title: 'Other controlled conversation', idempotencyKey: randomUUID()});
    const otherId = (await other.json()).value.descriptor.conversationId;
    assert.notEqual((await post('turns/cancel', {...unauthorizedStop, conversationId: otherId})).status, 200);
    assert.equal((await activeScope.persistence.durableTurns.load(conversationId, turnId)).record.cancellation, null);
  }
  await runtime.resumeTurn(turnId);
  assert.equal((await agent.runtime.inspect(jobIdentity)).value.snapshot.state, 'waiting');
  await browser.dispose(); await assistant.stopBackgroundWorkers(); await agent.close();
  if (!completed) context.attribution.session = fact('refreshed-session');
  agent = await buildAgent(); assistant = await make();
  blockTerminalWrites = interrupted;
  const proposal = proposals.rows[0].payload;
  const approved = await post('approvals/transition', {conversationId, proposalId: proposal.proposal_id, status: 'confirmed', expectedVersion: proposal.proposal_version,
    idempotencyKey: `approve:${conversationId}`, idempotencyFingerprint: `approve:${conversationId}`, attribution: {actor: {type: 'user', id: 'actor'}, source: {type: 'runtime'}}});
  assert.equal(approved.status, 200, await approved.text());
  await eventually(async () => externalEffects.length === 1);
  if (scenario.endsWith('quota-stop')) await eventually(async () => agent.events.some(e => e.code === 'execution_failed'));
  if (unknown) await eventually(async () => (await agent.runtime.inspect(jobIdentity)).value?.snapshot.state === 'waiting');
  if (completed) await eventually(async () => (await agent.runtime.inspect(jobIdentity)).value?.snapshot.state === 'succeeded');
  const prefix = (await pool.query('SELECT revision::int, event_id, payload FROM handrail_ai_events WHERE conversation_id=$1 ORDER BY revision', [conversationId])).rows;
  const beforeStop = (await agent.runtime.inspect(jobIdentity)).value.snapshot;
  const stop = {conversationId, turnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user'};
  const stopped = await post('turns/cancel', stop);
  assert.equal(stopped.status, 200);
  assert.equal((await post('turns/cancel', stop)).status, 200);
  await eventually(async () => (await activeScope.persistence.durableTurns.load(conversationId, turnId))?.record.status === (completed ? 'completed' : 'cancelled'));
  assert.deepEqual((await sql.query(`SELECT * FROM ${harness.table('bindings')}`)).rows, before);
  const retained = (await sql.query(`SELECT snapshot FROM ${harness.table('job_checkpoints')} WHERE job_id=$1`, [jobIdentity.jobId])).rows[0];
  assert.equal(retained.snapshot.state, completed ? 'succeeded' : 'cancelled');
  assert.deepEqual(retained.snapshot.effects, beforeStop.effects);
  if (unknown) assert.ok(retained.snapshot.effects.some(e => e.outcome === 'unknown')); 
  assert.deepEqual(retained.snapshot.effects.map(effect => effect.effectRef), effectRefs);
  assert.equal(externalEffects.length, 1); assert.equal(calls, 2);
  await assistant.stopBackgroundWorkers();
  if (interrupted) {
    assert.ok(blockedWrites > 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM handrail_ai_events WHERE conversation_id=$1 AND payload->'payload'->>'type'=$2", [conversationId, `turn.${expected}`])).rows[0].count, 0);
    const child = spawn(process.execPath, ['test/agent-projection-client.mjs', 'https://fixture.test', conversationId, turnId, expected],
      {timeout: 20000, env: {...process.env, HANDRAIL_PROJECTION_RECOVERY: JSON.stringify(context)}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const [code] = await once(child, 'exit'); assert.equal(code, 0, output);
    console.log('Fresh gateway process recovered interrupted projection without provider execution.');
  }
  assistant = await make();
  browser = await createHandrailAiClient({baseUrl: 'https://fixture.test', startActivityPolling: false, restoreActiveTurns: false, fetch: (url, init) => assistant.handle(new globalThis.Request(url, init)), conversations: {mode:'multiple',clientId:'fresh',authorize:()=> 'allow'}});
  const fresh = await browser.registry.open({conversationId,authorizationContext:null}); await fresh.synchronize();
  const turn = fresh.getSnapshot().turns.find(t => t.turn_id === turnId);
  assert.equal(turn.status, expected);
  assert.equal(turn.remote_may_still_be_running, false);
  assert.equal(fresh.getSnapshot().tool_calls.filter(call => call.name === 'reserve' && call.result).length, 1);
  const durable = await activeScope.persistence.durableTurns.load(conversationId, turnId);
  if (!completed) assert.ok(durable.record.cancellation.acceptedAt);
  const log = await pool.query('SELECT revision::int, event_id, payload FROM handrail_ai_events WHERE conversation_id=$1 ORDER BY revision', [conversationId]);
  assert.deepEqual(log.rows.map(r => r.revision), log.rows.map((_, i) => i + 1));
  assert.equal(new Set(log.rows.map(r => r.event_id)).size, log.rowCount);
  assert.deepEqual(log.rows.slice(0, prefix.length), prefix);
  // Fresh processes use the ordinary HTTP gateway and public JS / Dart clients.
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await assistant.handle(new globalThis.Request(`http://127.0.0.1${req.url}`, {method: req.method, headers: req.headers,
        ...(['GET', 'HEAD'].includes(req.method) ? {} : {body: Buffer.concat(chunks)})}));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const args = [`http://127.0.0.1:${server.address().port}`, conversationId, turnId, expected];
  const child = async (command, argv) => {
    const subprocess = spawn(command, argv, {timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']});
    let output = ''; subprocess.stdout.on('data', chunk => output += chunk); subprocess.stderr.on('data', chunk => output += chunk);
    const [code] = await once(subprocess, 'exit'); assert.equal(code, 0, output); console.log(output.trim());
  };
  await child(process.execPath, ['test/agent-projection-client.mjs', ...args]);
  if (process.env.HANDRAIL_PROJECTION_DART) await child(process.env.HANDRAIL_PROJECTION_DART,
    ['--packages=test/fixtures/agent-cancellation/dart/.dart_tool/package_config.json', 'test/fixtures/agent-cancellation/dart/projection.dart', ...args]);
  assert.equal(externalEffects.length, 1); assert.equal(calls, 2);
  assert.deepEqual((await agent.runtime.inspect(jobIdentity)).value.snapshot.effects, beforeStop.effects);
  console.log(JSON.stringify({scenario, status: turn.status, remoteMayBeRunning: turn.remote_may_still_be_running,
    effects: externalEffects.length, dispatches: calls, durableEvents: durable.record.events.length,
    canonicalEvents: log.rowCount, acknowledged: Boolean(durable.record.cancellation?.acceptedAt), unknownEffects: retained.snapshot.effects.filter(e => e.outcome === 'unknown').length}));
});
