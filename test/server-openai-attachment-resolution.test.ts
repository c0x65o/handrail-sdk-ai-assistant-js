import { expect, it, vi } from 'vitest';
import { AI_RUNTIME_PROTOCOL_VERSION, type AttachmentReference, type AuthoritativeAttribution, type ChatRequest } from '../src/protocol.js';
import type { PostgresAssistantPersistenceBundle } from '../src/postgres/index.js';
import { InMemoryOpenAIResponsesContinuationStore } from '../src/providers/openai-responses.js';
import { openaiResponses, type HandrailOpenAIResponsesOptions } from '../src/server/openai-responses.js';
import type { HandrailAssistantAuthorizationContext, HandrailAssistantProvider } from '../src/server/assistant.js';

const attribution: AuthoritativeAttribution = {
  organization: { id: 'org', source: 'server_derived', trust: 'authoritative' },
  project: { id: 'project', source: 'server_derived', trust: 'authoritative' },
  service_environment: { id: 'env', source: 'server_derived', trust: 'authoritative' },
  known_user: { id: 'user', source: 'server_derived', trust: 'authoritative' },
  session: { id: 'session', source: 'server_derived', trust: 'authoritative' },
  automation: { id: null, source: 'server_derived', trust: 'authoritative' },
};
const context: HandrailAssistantAuthorizationContext = { principalId: 'user', tenantId: 'tenant', scopeId: 'owner', attribution };
const bytes = Uint8Array.from([1, 2, 3, 4]);
const request: ChatRequest = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, messages: [{ role: 'user', content: [{ type: 'text', text: 'Client text' }] }],
  tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, continuation_of: null, correlation_hints: {} };
async function setup(options: Partial<HandrailOpenAIResponsesOptions> = {}, mediaType = 'application/pdf', maxElapsedMs = 10_000) {
  const providerRequest = vi.fn<NonNullable<HandrailOpenAIResponsesOptions['request']>>(async function* () {
    yield { type: 'response.output_text.delta', delta: 'Read authorized content.' };
    yield { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Read authorized content.' }] }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } };
  });
  const resolve = vi.fn(async (input: { ownerScopeId: string; conversationId: string; contentRef: string }) => {
    if (input.ownerScopeId !== 'owner' || input.conversationId !== 'conversation-1') throw new Error('not owned');
    return { record: { mediaType }, bytes };
  });
  const provider = openaiResponses({ model: 'test-model', request: providerRequest, supportsToolSearch: false,
    document_input: { supported_mime_types: ['application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      max_document_count: 2, max_document_bytes: 1_000, requires_host_resolution: true }, ...options });
  const persistence = { continuation: new InMemoryOpenAIResponsesContinuationStore(), usageAdmissions: null, usageReceiptSink: null,
    attachments: { resolve } } as unknown as PostgresAssistantPersistenceBundle<HandrailAssistantAuthorizationContext>;
  const input = { context, persistence, instructions: [], tools: { definitions: [], execute: vi.fn(), awaitApproval: vi.fn() },
    limits: { maxIterations: 4, maxTotalToolCalls: 4, maxElapsedMs, parallelism: 1 },
    toolActivity: { waitForApproval: async () => { throw new Error('Unexpected approval'); },
      observe: async (_location, execute) => (await execute(async () => {})).value },
  } satisfies Parameters<HandrailAssistantProvider<HandrailAssistantAuthorizationContext>['createTransport']>[0];
  const transport = await provider.createTransport(input);
  return { transport, providerRequest, resolve, async run(value = request, conversationId = 'conversation-1') {
    const started = await transport.startTurn({ conversationId, conversationTurnId: 'turn-1' as never, mutationId: 'mutation-1' as never,
      idempotencyKey: 'request-1', request: value });
    if (!started.ok) throw new Error(started.error.message);
    for await (const event of started.value.observation.events) { void event; }
    return started.value.observation.result;
  } };
}
function withAttachment(media_type: AttachmentReference['media_type'], kind: 'image' | 'document') {
  return { ...request, messages: [{ role: 'user', content: [{ type: kind, attachment: {
    attachment_id: 'att_file', content_ref: 'ref_file', media_type, byte_size: bytes.byteLength,
  } }] }] } as ChatRequest;
}

it.each([
  { media: 'image/png', kind: 'image', native: 'input_image' },
  { media: 'application/pdf', kind: 'document', native: 'input_file' },
  { media: 'text/csv', kind: 'document', native: 'input_file' },
  { media: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document', native: 'input_file' },
] as const)('resolves $media with its stored media type through the SDK-owned provider loop', async ({ media, kind, native }) => {
  const h = await setup({}, media); expect(await h.run(withAttachment(media, kind))).toMatchObject({ status: 'completed' });
  expect(h.resolve).toHaveBeenCalledWith({ ownerScopeId: 'owner', conversationId: 'conversation-1', contentRef: 'ref_file' });
  const body = h.providerRequest.mock.calls[0]![0];
  expect(body.input).toMatchObject([{ role: 'user', content: [{ type: native,
    ...(kind === 'image' ? { image_url: `data:${media};base64,AQIDBA==` } : { file_data: `data:${media};base64,AQIDBA==` }) }] }]);
});

it('supplies the trusted conversation, context and cancellation signal to a host attachment resolver', async () => {
  const attachmentResolver = vi.fn<NonNullable<HandrailOpenAIResponsesOptions['attachmentResolver']>>(async ({ context: owner, conversationId }) => {
    if (owner.scopeId !== 'owner' || conversationId !== 'conversation-1') throw new Error('forbidden');
    return { media_type: 'image/png', bytes };
  });
  const h = await setup({ attachmentResolver }); expect(await h.run(withAttachment('image/png', 'image'))).toMatchObject({ status: 'completed' });
  expect(attachmentResolver).toHaveBeenCalledWith(expect.objectContaining({ context, conversationId: 'conversation-1', signal: expect.any(AbortSignal) }));
  expect(h.resolve).not.toHaveBeenCalled();
});

it.each(['wrong_type', 'wrong_bytes', 'not_owned'] as const)('rejects $0 before contacting the provider', async failure => {
  const h = await setup({ attachmentResolver: async () => {
    if (failure === 'not_owned') throw new Error('forbidden');
    return { media_type: failure === 'wrong_type' ? 'application/pdf' : 'image/png', bytes: failure === 'wrong_bytes' ? new Uint8Array(2) : bytes };
  } });
  expect(await h.run(withAttachment('image/png', 'image'))).toMatchObject({ status: 'failed' });
  expect(h.providerRequest).not.toHaveBeenCalled();
});

it('retains the existing explicit synchronous image resolver for other consumers', async () => {
  const resolveAttachment = vi.fn(() => ({ type: 'input_image', image_url: 'https://example.test/authorized.png' }));
  const h = await setup({ resolveAttachment }); expect(await h.run(withAttachment('image/png', 'image'))).toMatchObject({ status: 'completed' });
  expect(resolveAttachment).toHaveBeenCalledTimes(1); expect(h.resolve).not.toHaveBeenCalled();
});

it('prepares authoritative history once with trusted turn identity before invoking the provider', async () => {
  const prepareRequest = vi.fn<NonNullable<HandrailOpenAIResponsesOptions['prepareRequest']>>(async ({ request: incoming }) => ({ ...incoming,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Authorized saved history' }] }] }));
  const h = await setup({ prepareRequest }); expect(await h.run()).toMatchObject({ status: 'completed' });
  expect(prepareRequest).toHaveBeenCalledTimes(1);
  expect(prepareRequest).toHaveBeenCalledWith(expect.objectContaining({ context, conversationId: 'conversation-1', turnId: 'turn-1', mutationId: 'mutation-1' }));
  expect(h.providerRequest.mock.calls[0]![0].input).toMatchObject([{ content: [{ text: 'Authorized saved history' }] }]);
});

it.each([{ status: 401, code: 'unauthenticated' }, { status: 403, code: 'forbidden' },
  { status: 404, code: 'not_found' }, { status: 503, code: 'unavailable' }])('redacts history preparation failure $status before provider work', async ({ status, code }) => {
  const h = await setup({ prepareRequest: async () => { throw Object.assign(new Error('private history and credential'), { status }); } });
  const result = await h.run();
  expect(result).toMatchObject({ status: 'failed', error: { code, retryable: code === 'unavailable' } });
  expect(JSON.stringify(result)).not.toContain('private history and credential');
  expect(h.providerRequest).not.toHaveBeenCalled();
});


it.each(['history', 'image', 'document'] as const)('cancels a pending %s callback before it returns and ignores its late result', async kind => {
  let release!: () => void;
  const entered = vi.fn();
  const wait = new Promise<void>(resolve => { release = resolve; });
  const h = await setup(kind === 'history' ? {
    prepareRequest: async ({ request: saved }) => { entered(); await wait; return saved; },
  } : { attachmentResolver: async () => { entered(); await wait; return { media_type: kind === 'image' ? 'image/png' : 'application/pdf', bytes }; } });
  const result = h.run(kind === 'history' ? request : withAttachment(kind === 'image' ? 'image/png' : 'application/pdf', kind));
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  const cancellation = h.transport.capabilities.authoritativeCancellation;
  if (!cancellation.supported) throw new Error('Expected authoritative cancellation');
  expect(await cancellation.capability.cancelTurn({ conversationId: 'conversation-1', turnId: 'turn-1',
    mutationId: 'cancel-1', idempotencyKey: 'cancel-1', reason: 'user' })).toMatchObject({ ok: true });
  expect(await result).toMatchObject({ status: 'cancelled' });
  expect(h.providerRequest).not.toHaveBeenCalled();
  release();
  await Promise.resolve(); await Promise.resolve();
  expect(h.providerRequest).not.toHaveBeenCalled();
});

it('enforces the active preparation deadline even when a host read does not settle', async () => {
  const h = await setup({ prepareRequest: () => new Promise(() => {}) }, 'application/pdf', 20);
  expect(await h.run()).toMatchObject({ status: 'failed', error: { code: 'timeout', retryable: true } });
  expect(h.providerRequest).not.toHaveBeenCalled();
});

it.each([{ media: 'text/csv' as const, maxBytes: 1_000 }, { media: 'application/pdf' as const, maxBytes: 2 }])(
  'enforces configured document type and byte limits before resolution: %j', async ({ media, maxBytes }) => {
    const h = await setup({ document_input: { supported_mime_types: ['application/pdf'], max_document_count: 2,
      max_document_bytes: maxBytes, requires_host_resolution: true } }, media);
    expect(await h.run(withAttachment(media, 'document'))).toMatchObject({ status: 'failed' });
    expect(h.resolve).not.toHaveBeenCalled(); expect(h.providerRequest).not.toHaveBeenCalled();
  });

it('enforces document count across saved history before provider dispatch', async () => {
  const h = await setup();
  const value = withAttachment('application/pdf', 'document');
  expect(await h.run({ ...value, messages: [...value.messages, ...value.messages, ...value.messages] })).toMatchObject({ status: 'failed' });
  expect(h.providerRequest).not.toHaveBeenCalled();
});
