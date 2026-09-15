import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import documentFixtures from './fixtures/documents/manifest.json' with { type: 'json' };
import { AI_RUNTIME_PROTOCOL_VERSION, type AttachmentReference, type AuthoritativeAttribution, type ChatRequest } from '../src/protocol.js';
import type { PostgresAssistantPersistenceBundle } from '../src/postgres/index.js';
import { InMemoryOpenAIResponsesContinuationStore } from '../src/providers/openai-responses.js';
import { openaiResponses, type HandrailOpenAIResponsesOptions } from '../src/server/openai-responses.js';
import type { HandrailAssistantAuthorizationContext, HandrailAssistantProvider } from '../src/server/assistant.js';
import type { AssistantToolRuntime } from '../src/server/assistant-tool-runtime.js';
import { InMemoryConversationEventStore, parseConversationEvent } from '../src/index.js';
import { AttachmentStagingError } from '../src/attachments/staging.js';
import { SavedConversationPreparationError, SavedConversationFileUnavailableError } from '../src/server/saved-conversation-request.js';

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
async function setup(options: Partial<HandrailOpenAIResponsesOptions> = {}, mediaType = 'application/pdf', maxElapsedMs = 10_000,
  withApprovalContext?: AssistantToolRuntime['withApprovalContext'],
  savedPersistence: Record<string, unknown> = {}) {
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
  const continuations = new Map<string, InMemoryOpenAIResponsesContinuationStore>();
  const continuation = Object.assign(new InMemoryOpenAIResponsesContinuationStore(), {
    forConversation(conversationId: string) {
      if (!continuations.has(conversationId)) continuations.set(conversationId, new InMemoryOpenAIResponsesContinuationStore());
      return continuations.get(conversationId)!;
    },
  });
  const persistence = { continuation, usageAdmissions: null, usageReceiptSink: null,
    attachments: { resolve }, ...savedPersistence } as unknown as PostgresAssistantPersistenceBundle<HandrailAssistantAuthorizationContext>;
  const input = { context, persistence, instructions: [], tools: { definitions: [], execute: vi.fn(), awaitApproval: vi.fn(),
    ...(withApprovalContext ? { withApprovalContext } : {}) },
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

it('adds durable review context after host history replacement and before provider dispatch', async () => {
  const prepareRequest = vi.fn(async () => ({ ...request,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Saved latest comment' }] }] }));
  const withApprovalContext = vi.fn<NonNullable<AssistantToolRuntime['withApprovalContext']>>(async prepared => {
    expect(prepared.messages[0]?.content[0]).toEqual({ type: 'text', text: 'Saved latest comment' });
    return { ...prepared, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Earlier saved review remains pending.' }] }, ...prepared.messages] };
  });
  const h = await setup({ prepareRequest }, 'application/pdf', 10_000, withApprovalContext);
  expect(await h.run()).toMatchObject({ status: 'completed' });
  expect(withApprovalContext).toHaveBeenCalledOnce();
  expect(withApprovalContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 'conversation-1', turnId: 'turn-1' }), expect.any(AbortSignal));
  expect(h.providerRequest.mock.calls[0]![0].input).toMatchObject([
    { role: 'assistant', content: 'Earlier saved review remains pending.' },
    { role: 'user', content: [{ text: 'Saved latest comment' }] },
  ]);
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

async function savedHistory(mediaType: 'image/png' | 'application/pdf', count: number) {
  const events = new InMemoryConversationEventStore();
  let revision = 0;
  const append = async (payload: Record<string, unknown>) => {
    const event = parseConversationEvent({ version: 1, conversation_id: 'conversation-1', event_id: `saved-${revision + 1}`,
      revision: revision + 1, occurred_at: '2026-09-15T12:00:00Z', actor: { type: 'user' }, source: { type: 'runtime' }, payload });
    await events.append({ conversationId: 'conversation-1' as never, expectedRevision: (revision || null) as never, events: [event] });
    revision++;
  };
  for (let index = 0; index < count; index++) {
    await append({ type: 'message.created', message_id: `old-${index}`, role: 'user', content: [{ type: 'text', text: 'Old file' }] });
    await append({ type: 'message.attachment_referenced', message_id: `old-${index}`, attachment: {
      attachment_id: `att_${index}`, media_type: mediaType, size_bytes: 4,
      ...(mediaType === 'application/pdf' ? { kind: 'document' } : {}),
    } });
  }
  await append({ type: 'message.created', message_id: 'current', role: 'user', content: [{ type: 'text', text: 'Compare those files' }] });
  await append({ type: 'turn.started', turn_id: 'turn-1', input_message_ids: ['current'] });
  const get = vi.fn(async () => ({}));
  const download = vi.fn(async ({ attachmentId }: { attachmentId: string }) => ({
    record: { attachmentId, contentRef: `ref_${attachmentId}`, mediaType, byteSize: 4 }, bytes,
  }));
  const resolve = vi.fn(async () => ({ record: { mediaType }, bytes }));
  return { events, catalog: { get }, attachments: { download, resolve } };
}

it.each([{ media: 'image/png', count: 9, included: 8, type: 'input_image' },
  { media: 'application/pdf', count: 5, included: 2, type: 'input_file' }] as const)(
  'uses SDK canonical history to bound $count saved $media files at provider input', async ({ media, count, included, type }) => {
    const persistence = await savedHistory(media, count);
    const h = await setup({ savedConversation: true }, media, 10_000, undefined, persistence);
    expect(await h.run()).toMatchObject({ status: 'completed' });
    const body = h.providerRequest.mock.calls[0]![0];
    expect(JSON.stringify(body)).not.toContain('Client text');
    const parts = body.input.flatMap(item => 'content' in item && Array.isArray(item.content) ? item.content : []);
    expect(parts.filter(part => part !== null && typeof part === 'object' && !Array.isArray(part) && part.type === type)).toHaveLength(included);
    expect(JSON.stringify(body)).toContain('Compare those files');
    expect(persistence.attachments.download).toHaveBeenCalledTimes(included);
    expect(persistence.catalog.get).toHaveBeenCalledTimes(included * 3 + 2);
  });

it('stops provider dispatch when fresh SDK history authorization fails after file reads', async () => {
  const persistence = await savedHistory('image/png', 1);
  persistence.catalog.get.mockResolvedValueOnce({}).mockResolvedValueOnce({})
    .mockRejectedValue(Object.assign(new Error('private ownership detail'), { status: 403 }));
  const h = await setup({ savedConversation: true }, 'image/png', 10_000, undefined, persistence);
  expect(await h.run()).toMatchObject({ status: 'failed', error: { code: 'forbidden' } });
  expect(h.providerRequest).not.toHaveBeenCalled();
});

it('rejects competing host and SDK history builders', () => {
  expect(() => openaiResponses({ model: 'test-model', savedConversation: true,
    prepareRequest: ({ request: value }) => value, request: async function* () {} })).toThrow('not both');
});

it.each(['expired', 'not_found'] as const)('continues text follow-ups with an accurate omission notice for a %s prior SDK upload', async code => {
  const persistence = await savedHistory('image/png', 1);
  persistence.attachments.download.mockRejectedValue(new AttachmentStagingError(code));
  const h = await setup({ savedConversation: true }, 'image/png', 10_000, undefined, persistence);
  expect(await h.run()).toMatchObject({ status: 'completed' });
  expect(JSON.stringify(h.providerRequest.mock.calls[0]![0])).toContain('Its contents were not included');
  expect(persistence.attachments.resolve).not.toHaveBeenCalled();
});

it.each([new SavedConversationPreparationError('attachment_limit'), new SavedConversationPreparationError('attachment_changed'),
  new SavedConversationPreparationError('attachment_unsupported'), new SavedConversationFileUnavailableError('expired')])(
  'reports the safe shared preparation failure $code without starting provider work', async error => {
    const h = await setup({ prepareRequest: () => { throw error; } });
    expect(await h.run()).toMatchObject({ status: 'failed', error: {
      code: error instanceof SavedConversationFileUnavailableError ? 'not_found' : 'invalid_request', message: error.message, retryable: false } });
    expect(h.providerRequest).not.toHaveBeenCalled();
  });

it.each(['forbidden', 'unavailable', 'invalid_input'] as const)('does not skip an optional prior file on SDK storage failure %s', async code => {
  const persistence = await savedHistory('image/png', 1);
  persistence.attachments.download.mockRejectedValue(new AttachmentStagingError(code));
  const h = await setup({ savedConversation: true }, 'image/png', 10_000, undefined, persistence);
  expect(await h.run()).toMatchObject({ status: 'failed' });
  expect(h.providerRequest).not.toHaveBeenCalled();
});

it('rechecks current ownership after provider byte resolution, before dispatch', async () => {
  const persistence = await savedHistory('image/png', 1);
  persistence.attachments.resolve.mockImplementation(async () => {
    persistence.catalog.get.mockRejectedValue(Object.assign(new Error('revoked during read'), { status: 403 }));
    return { record: { mediaType: 'image/png' }, bytes };
  });
  const h = await setup({ savedConversation: true }, 'image/png', 10_000, undefined, persistence);
  expect(await h.run()).toMatchObject({ status: 'failed' });
  expect(h.providerRequest).not.toHaveBeenCalled();
});

it.each(documentFixtures)('prepares Flutter-verified $filename saved references and original bytes for provider input', async fixture => {
  const events = new InMemoryConversationEventStore();
  const bytes = readFileSync(new URL(`./fixtures/documents/${fixture.filename}`, import.meta.url));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
  await events.append({ conversationId: 'conversation-1' as never, expectedRevision: null,
    events: [
      { type: 'message.created', message_id: 'flutter-upload', role: 'user', content: [{ type: 'text', text: 'Read uploaded file' }] },
      { type: 'message.attachment_referenced', message_id: 'flutter-upload', attachment: fixture.saved },
      { type: 'message.created', message_id: 'followup', role: 'user', content: [{ type: 'text', text: 'What was the total?' }] },
      { type: 'turn.started', turn_id: 'turn-1', input_message_ids: ['followup'] },
    ].map((payload, index) => parseConversationEvent({ version: 1, conversation_id: 'conversation-1', revision: index + 1,
      event_id: `flutter-${index}`, occurred_at: '2026-09-15T12:00:00Z', actor: { type: 'user' }, source: { type: 'runtime' }, payload })) });
  const persistence = { events, catalog: { get: vi.fn(async () => ({})) }, attachments: {
    download: async () => ({ bytes, record: { attachmentId: fixture.uploaded.attachment_id, contentRef: fixture.uploaded.content_ref,
      mediaType: fixture.uploaded.media_type, byteSize: bytes.length, filename: fixture.filename } }),
    resolve: async () => ({ bytes, record: { mediaType: fixture.uploaded.media_type } }),
  } };
  const h = await setup({ savedConversation: true, document_input: { supported_mime_types: ['application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], max_document_count: 2,
    max_document_bytes: 20 * 1024 * 1024, requires_host_resolution: true } }, fixture.uploaded.media_type,
  10_000, undefined, persistence);
  expect(await h.run()).toMatchObject({ status: 'completed' });
  const body = JSON.stringify(h.providerRequest.mock.calls[0]![0]);
  expect(body).toContain(`data:${fixture.uploaded.media_type};base64,${bytes.toString('base64')}`);
  expect(body).toContain('What was the total?');
  expect(body).not.toContain('Client text');
});
