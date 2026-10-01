// Retained from Agent SDK f6eb0ef10af89a8ecaea0707610d7709483eaa49 installed fixture.
// Only addition: injectable native effect adapter for the gateway regression.
import { Buffer } from 'node:buffer';
import { createSecretKey, randomUUID } from 'node:crypto';
import pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assistanceDigest } from 'handrail-agent-sdk/server/assistance';
import { createAgentRuntime } from 'handrail-agent-sdk/server/agents';
import { createJobLease, createEffects, createJobCancellation, createJobAnswer } from 'handrail-agent-sdk/server';
import { createPostgresAgentStores } from 'handrail-agent-sdk/server/postgres';
export const identity = { jobId: 'agent-job', originTaskRef: 'original-task', requestKey: 'original-request', instructionRevision: 1,
  host: { tenantRef: 'tenant', userRef: 'actor', projectRef: 'project', accountRef: 'account', environmentRef: 'fixture', purposeRef: 'setup' },
  native: { requestRef: 'native-request', rootTaskRef: 'native-root' },
  origin: { channelRef: 'web', routeRef: 'owner-task', correlationRef: 'original-correlation' } };
const defaultIdentity = identity;
export const limits = { maxTurns: 12, maxDispatches: 5, maxToolCalls: 12, maxContextBytes: 24_000,
  maxStateBytes: 65_536, maxOutputBytes: 4096, maxElapsedMs: 5000, leaseTtlMs: 1200, pollMs: 200 };
const equal = isDeepStrictEqual;
export const requirement = kind => ({ kind, requirementRef: `wait-${kind}`, revision: 1, actor: { kind: 'user', actorRef: 'actor' } });
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const call = (name, n, input = {}) => ({ type: 'function_call', callId: `call-${n}`, name, arguments: JSON.stringify(input) });
/** Simulates ONLY the external model boundary. Real Agent, Runner, tool schema
 * parsing, approval, RunState and streaming are used by every test. */
export function modelBoundary(scenario = 'inventory', hooks = {}) {
  let requests = 0;
  return { get requests() { return requests; },
    async getResponse() { throw Error('STREAM_EXPECTED'); },
    async *getStreamedResponse(request) {
      requests++;
      if (hooks.before) await hooks.before(request);
      const input = typeof request.input === 'string' ? [] : request.input;
      const outputs = input.filter(i => i.type === 'function_call_result');
      const n = outputs.length;
      let output;
      if (scenario === 'research') {
        output = n === 0 ? call('lookup', 0, { topic: 'unavailable' })
          : n === 1 ? call('lookup', 1, { topic: 'fallback' })
          : n === 2 ? call('calculate', 2, { quantity: 3, price: 7 }) : message('Fallback quote: 21');
      } else {
        output = n === 0 ? call('lookup', 0, { topic: 'inventory' })
          : n === 1 ? call('reserve', 1, { itemRef: 'synthetic-item' })
          : n === 2 ? call('lookup', 2, { topic: 'receipt' }) : message('Reserved synthetic item.');
      }
      if (scenario === 'invalid') output = call('reserve', 0, { itemRef: 42 });
      yield { type: 'response_started' };
      yield { type: 'response_done', response: { id: `response-${n}`, output: [output],
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 } } };
    },
  };
}
export async function services(schema, keyHex, options = {}) {
  if (!/^sdk_test_[a-f0-9]{32}$/.test(schema)) throw Error('FIXTURE_SCHEMA');
  // Installed-consumer qualification supplies factories from its public exports.
  const identity = options.identity ?? defaultIdentity;
  const sdk = { createAgentRuntime, createJobLease, createEffects, createJobCancellation, createJobAnswer };
  const pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL,
    options: '-c search_path=pg_catalog', max: 5, statement_timeout: 4000 });
  const key = createSecretKey(Buffer.from(keyHex,'hex'));
  const stores = createPostgresAgentStores({ client: pool, schema, keys: { current: async () => ({ ref: 'fixture-key', key }), resolve: async ref => { if (ref !== 'fixture-key') throw Error('UNKNOWN_KEY'); return key; } } });
  const state = { denied: false, grantRevision: 1, approved: false, resolution: null, uncertain: false, ...options.state };
  const authority = () => ({ host: identity.host, grantRevision: state.grantRevision, cancellationRevision: 0 });
  const { journal, admission, states } = stores;
  const host = { now: Date.now, newOwnerToken: () => `agent-${randomUUID()}`,
    recover: async () => [identity],
    authorize: async id => !state.denied && equal(id,identity) ? { namespaceRef: 'fixture', host: identity.host, grantRevision: state.grantRevision } : null,
    withAuthority: async (id, _op, run) => !state.denied && equal(id.identity ?? id,identity) ? run(authority()) : { ok: false, code: 'not_authorized' },
    withStopAuthority: async (id,actor,run) => !state.denied && equal(id,identity) && actor === identity.host.userRef ? run(authority()) : { ok: false, code: 'not_authorized' },
    withEvidenceAuthority: async (_id,_actor,run) => run(authority()),
    withAnswerAuthority: async (id,actor,_op,run) => !state.denied && equal(id,identity) && actor === identity.host.userRef ? run(authority()) : { ok: false, code: 'not_authorized' },
    input: async () => options.scenario === 'research' ? 'Find a fallback price and calculate a quote.' : 'Check stock, reserve one synthetic item, then verify the receipt.',
    decide: async c => {
      if (state.denied) throw Error('revoked');
      if (options.wait && c.toolName === 'reserve' && !state.approved) return requirement('approval');
      return 'approve';
    },
    withToolAuthority: async (_c,run) => { if (state.denied) throw Error('revoked'); return run(); },
    requirement: (_call,kind) => requirement(kind),
    resolveWait: async snapshot => snapshot.requirement.kind === 'approval'
      ? (snapshot.answer?.responseRef === state.resolution?.receiptRef ? state.resolution : null) : state.resolution,
    output: async (_id,text) => ({ text, receiptRef: 'verified-output' }),
    ...options.host,
  };
  const lease = sdk.createJobLease(host,stores.lease);
  const providerTable = `"${schema}"."synthetic_provider"`;
  const adapter = {
    async dispatch(r) {
      await pool.query(`INSERT INTO ${providerTable}(id,receipt) VALUES ($1,'fixture-receipt') ON CONFLICT (id) DO UPDATE SET attempts = synthetic_provider.attempts + 1`,[r.idempotencyRef]);
      await options.afterEffect?.();
      return state.uncertain ? { outcome: 'unknown' } : { outcome: 'verified', receiptRef: 'fixture-receipt' };
    },
    async reconcile(r) {
      if (state.uncertain) return { outcome: 'unknown' };
      const result = await pool.query(`SELECT receipt FROM ${providerTable} WHERE id=$1`,[r.idempotencyRef]);
      return result.rowCount ? { outcome: 'verified', receiptRef: result.rows[0].receipt }
        : { outcome: 'not_applied', evidenceRef: 'synthetic-serial-provider-proof' };
    },
  };
  const effects = sdk.createEffects(host,stores.effects,options.effectAdapter ?? adapter,3000);
  const events = [], calls = [];
  const tools = [
    { name: 'lookup', description: 'Read synthetic fixture facts.', kind: 'read', parameters: z.object({ topic: z.string().max(40) }).strict(),
      execute: async (c,signal) => { calls.push(c); if (options.read) return options.read(c,signal);
        if (c.input.topic === 'unavailable') throw Error('CONFIDENTIAL_PROVIDER_FAILURE');
        return JSON.stringify({ value: 7 }); } },
    { name: 'calculate', description: 'Calculate a quote.', kind: 'read', parameters: z.object({ quantity: z.number(), price: z.number() }).strict(),
      execute: async c => { calls.push(c); return String(c.input.quantity * c.input.price); } },
    { name: 'reserve', description: 'Reserve a synthetic item.', kind: 'effect', parameters: z.object({ itemRef: z.literal('synthetic-item') }).strict(),
      bind: async c => ({ identity: c.identity, effectRef: c.effectRef, idempotencyRef: c.effectRef,
        actionRef: 'reserve', operationRef: 'synthetic-reserve', providerRef: 'fixture-provider',
        requestDigest: `sha256:${assistanceDigest([c.identity,c.input])}` }) },
  ];
  if (options.reserve) tools[2] = options.reserve;
  if (options.readEffectResult) tools[2] = { ...tools[2], readResult: options.readEffectResult };
  const model = options.model ?? modelBoundary(options.scenario,options.modelHooks);
  const runtime = sdk.createAgentRuntime({ definitionRef: 'fixture-agent-v1', instructions: 'Use only the synthetic tools. Recover from read errors.',
    model, sampling: options.sampling, tools: options.transformTools?.(tools) ?? options.tools ?? tools, host, admission, journal, lease, states, effects, limits: {...limits,...options.limits}, observe: e => { events.push(e); options.observe?.(e); } });
  return { identity, tools, runtime, pool, journal, admission, lease, states, effects, authority, host, state, events, calls, model,
    cancel: sdk.createJobCancellation(host,stores.cancellation),
    answer: sdk.createJobAnswer(host,stores.answer),
    close: async () => { await runtime.stop(); await pool.end(); } };
}
