import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { postgresFromClient, type PostgresSqlClient } from '../src/postgres/index.js';
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from '../src/server/assistant.js';
import { openaiResponses } from '../src/server/openai-responses.js';
import { createToolPlugin } from '../src/tools/plugin.js';
import { createHandrailAiClient } from '../src/client/index.js';
import { replayConversation } from '../src/conversation/replay.js';
import { AI_RUNTIME_PROTOCOL_VERSION } from '../src/protocol.js';
import { createAiApplication } from '../src/server/application.js';
import { createAssistantToolRuntime, assistantToolArgumentReference } from '../src/server/assistant-tool-runtime.js';
import { createApprovalExecutionCoordinator } from '../src/tools/approval-execution.js';

const fact = <T extends string | null>(id: T) => ({ id, source: 'server_derived' as const, trust: 'authoritative' as const });
const context: HandrailAssistantAuthorizationContext = { principalId: 'user', tenantId: 'tenant', scopeId: 'user',
  attribution: { organization: fact('org'), project: fact('project'), service_environment: fact('test'),
    known_user: fact('user'), session: fact('session'), automation: fact(null) } };

it.each(['confirmed', 'rejected'] as const)('HTTP decisions resume an external %s proposal after restart without reopening its provider', async status => {
  const database = new PGlite();
  const adapt = (db: Pick<PGlite, 'query'>): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: operation => operation(client) }; return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query,
    transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, 'query'>))) };
  const persistence = postgresFromClient(sql);
  await persistence.persistence.migrate();
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, {
    createConversationId: () => 'conversation' as never, authorizeConversation: () => 'allow', authorizeApproval: () => 'allow' });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: 'new' as never });
  const effect = vi.fn(async () => ({ saved: true }));
  const plugin = createToolPlugin({ pluginId: 'external', version: '1.0.0', displayName: 'External',
    registrations: [{ definition: { name: 'save', description: 'Save', input_schema: { type: 'object', properties: {} } }, executor: effect }],
    approvals: [{ toolName: 'save', mode: 'always', summarize: () => 'Save reviewed change' }] });
  const providerRequest = vi.fn(async function* () { throw new Error('External approval must not open a provider'); yield {}; });
  const location = { conversationId: 'conversation', turnId: 'saved-voice-call' };
  const call = { tool_call_id: 'voice-action', name: 'save', arguments: {} };
  const lease = new AbortController();
  const freshAuthorization = vi.fn(async () => {});
  const runtime = async (authorize: () => void | Promise<void>) => createAssistantToolRuntime({ context,
    events: bundle.events, proposalStore: bundle.approvals, authorizeLocation: authorize,
    application: await createAiApplication({ installContext: context, plugins: [plugin], policy: () => ({ outcome: 'allow' }),
      toolExecutionLedger: bundle.toolLedger,
      approvalCoordinator: createApprovalExecutionCoordinator({ proposalStore: bundle.approvals, eventStore: bundle.events,
        authorize: async () => { await authorize(); return 'allow' as const; },
        verifyArguments: ({ binding, reviewedArguments, arguments: args }) => binding.type === 'opaque_reference' &&
          reviewedArguments.type === 'opaque_reference' && binding.argumentReference === reviewedArguments.argument_ref &&
          binding.argumentReference === assistantToolArgumentReference(args) ? 'match' : 'mismatch' }) }) });
  const create = () => createHandrailAssistant({ id: 'external', authorize: () => context, persistence, automaticTitles: false,
    externalApprovalRuntimeFor: async input => {
      expect(input).toMatchObject(location);
      return runtime(freshAuthorization);
    }, provider: openaiResponses({ model: 'fixture', request: providerRequest, supportsToolSearch: false }) });
  let assistant = await create();
  try {
    const live = await runtime(() => lease.signal.throwIfAborted());
    await live.execute(call, lease.signal, location);
    expect(await live.awaitApproval({ ...location, call, signal: lease.signal })).toMatchObject({ status: 'external_approval_required' });
    const proposal = (await bundle.approvals.listGroup({ permissionContext: context, groupId: 'conversation' as never }))[0]!;
    lease.abort();
    await assistant.stopBackgroundWorkers(); assistant = await create();
    const decide = () => assistant.handle(new Request('https://app.test/approvals/transition', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'conversation',
        proposalId: proposal.proposal_id, expectedVersion: 1, status, idempotencyKey: 'decision', idempotencyFingerprint: 'decision' }) }));
    expect((await decide()).status).toBe(200);
    await assistant.stopBackgroundWorkers(); assistant = await create();
    expect((await decide()).status).toBe(200);
    expect(freshAuthorization).toHaveBeenCalled();
    expect(effect).toHaveBeenCalledTimes(status === 'confirmed' ? 1 : 0);
    expect(providerRequest).not.toHaveBeenCalled();
    expect(await bundle.durableTurns.load('conversation', location.turnId)).toBeNull();
    expect((await bundle.events.read({ conversationId: 'conversation' as never })).entries
      .filter(entry => entry.event.payload.type === 'tool_call.result_recorded')).toHaveLength(1);
  } finally { await assistant.stopBackgroundWorkers(); await database.close(); }
}, 30_000);

it.each([['confirmed', 'complete'], ['rejected', 'complete'], ['confirmed', 'running'], ['confirmed', 'none'], ['rejected', 'none']] as const)('rests across comments and restart, then resumes %s once (comment=%s)', async (decision, commentMode) => {
  const commentRunning = commentMode === 'running';
  const hasComment = commentMode !== 'none';
  const database = new PGlite();
  const adapt = (db: Pick<PGlite, 'query'>): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: operation => operation(client) }; return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query,
    transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, 'query'>))) };
  const persistence = postgresFromClient(sql);
  await persistence.persistence.migrate();
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, {
    createConversationId: () => 'conversation' as never, authorizeConversation: () => 'allow', authorizeApproval: () => 'allow' });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: 'new' as never });
  const effect = vi.fn(async () => ({ saved: true }));
  const plugin = createToolPlugin({ pluginId: 'test', version: '1.0.0', displayName: 'Test',
    registrations: [{ definition: { name: 'save', description: 'Save', input_schema: { type: 'object', properties: {} } }, executor: effect }],
    approvals: [{ toolName: 'save', mode: 'always', summarize: () => 'Save the change' }] });
  let physical = 0;
  let releaseComment!: () => void;
  const commentGate = new Promise<void>(resolve => { releaseComment = resolve; });
  const providerRequest = vi.fn(async function* () {
    const current = ++physical;
    if (current === 2 && commentRunning) await commentGate;
    if (current === 1) {
      yield { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'save', arguments: '' } };
      yield { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc', arguments: '{}' };
    } else yield { type: 'response.output_text.delta', delta: current === 2 ? 'Comment received.' : 'Decision received.' };
    yield { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
  });
  const diagnostics = vi.fn();
  const create = () => createHandrailAssistant({ id: 'test', authorize: () => context, persistence, tools: [plugin], diagnostics, automaticTitles: false,
    provider: openaiResponses({ model: 'fixture', request: providerRequest, supportsToolSearch: false, savedConversation: true }) });
  let assistant = await create();
  const post = (path: string, value: unknown) => assistant.handle(new Request(`https://app.test/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }));
  const state = async () => { const replay = await replayConversation({ conversationId: 'conversation' as never, eventStore: bundle.events });
    replay.store.destroy(); return replay.state; };
  const browser = await createHandrailAiClient({ baseUrl: 'https://app.test', startActivityPolling: false,
    fetch: (url, init) => assistant.handle(new Request(url, init)),
    conversations: { mode: 'multiple', clientId: 'browser' as never, authorize: () => 'allow' } });
  const runtime = await browser.workspace!.open({ authorizationContext: context, conversationId: 'conversation' as never });
  const turnIds: Record<string, string> = {};
  const send = async (label: string, text: string) => {
    const result = await runtime.sendMessage({ content: text,
      onAccepted: ({ turnId }) => { turnIds[label] = turnId; },
      request: { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], tool_results: [],
        generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} } });
    return JSON.stringify(result);
  };
  try {
    const pending = await send('original', 'Save a change');
    expect(pending).toContain('waiting_for_approval');
    expect(browser.workspace!.getSnapshot().runningCount).toBe(0);
    expect(await state()).toMatchObject({ active_turn_id: null, turns: [{ status: 'waiting_for_approval', remote_may_still_be_running: false }] });
    const proposal = (await bundle.approvals.listGroup({ permissionContext: context, groupId: 'conversation' as never }))[0]!;
    expect(proposal).toMatchObject({ status: 'pending', expires_at: null });
    expect((await bundle.durableTurns.load('conversation', turnIds.original!))?.record.lease).toBeNull();
    await assistant.stopBackgroundWorkers(); assistant = await create();
    await assistant.handle(new Request('https://app.test/capabilities'));
    expect(physical).toBe(1);
    const comment = hasComment ? send('comment', 'I need more time to think about this.') : Promise.resolve('completed');
    if (commentRunning) await vi.waitFor(() => expect(physical).toBe(2));
    else expect(await comment).toContain('completed');
    expect((await bundle.approvals.get({ permissionContext: context, proposalId: proposal.proposal_id }))?.status).toBe('pending');
    expect(physical).toBe(hasComment ? 2 : 1); expect(effect).not.toHaveBeenCalled();
    const decisionInput = { conversationId: 'conversation', proposalId: proposal.proposal_id, expectedVersion: 1,
      status: decision, idempotencyKey: 'decide', idempotencyFingerprint: 'decide' };
    expect((await post('approvals/transition', decisionInput)).status).toBe(200);
    if (commentRunning) {
      expect((await state()).active_turn_id).toBe(turnIds.comment);
      expect(effect).not.toHaveBeenCalled();
      releaseComment(); expect(await comment).toContain('completed');
    }
    await vi.waitFor(async () => {
      const current = await state();
      expect(current.turns.find(turn => turn.turn_id === turnIds.original)?.status,
        JSON.stringify(diagnostics.mock.calls)).toBe('completed');
    }, { timeout: 10_000 });
    expect(physical).toBe(hasComment ? 3 : 2);
    expect(effect).toHaveBeenCalledTimes(decision === 'confirmed' ? 1 : 0);
    expect((await post('approvals/transition', decisionInput)).status).toBe(200);
    expect(physical).toBe(hasComment ? 3 : 2);
    expect((await state()).active_turn_id).toBeNull();
    expect((await bundle.durableTurns.load('conversation', turnIds.original!))?.record).toMatchObject({ attempt: 2, approvalResumes: 1, lease: null });
  } finally { releaseComment(); await browser.dispose(); await assistant.stopBackgroundWorkers(); await database.close(); }
}, 30_000);
