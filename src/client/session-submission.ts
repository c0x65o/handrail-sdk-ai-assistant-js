import { parseConversationEvent, type ConversationClientId, type ConversationId,
  type ConversationMessageId, type ConversationRevision, type ConversationTurnId } from "../conversation/events.js";
import type { ConversationRuntimeSendMessageInput } from "../runtime.js";
import type { AppendMutationsInput, ConversationSyncMutationEvent } from "../sync/types.js";
import type { StartTurnInput } from "../transports/types.js";
import { parseDraftOrigin, type ConversationDraftOrigin } from "./draft-origin.js";

/** Retain before any network write; replay the exact admission/start after an
 * uncertain reply. This is user content and requires account/API-scoped storage. */
export interface ApplicationConversationSubmission<TRequest = unknown> {
  readonly localDraft?: ConversationDraftOrigin;
  /** Version 2 requires origin-aware cleanup; v1 readers must fail closed. */
  readonly version: 1 | 2;
  readonly messageId: ConversationMessageId;
  readonly admission: AppendMutationsInput;
  readonly start: StartTurnInput<TRequest>;
}
export interface ApplicationConversationPendingStore<TRequest = unknown> {
  load(conversationId: string): Promise<ApplicationConversationSubmission<TRequest> | null>;
  /** Atomically retain this value or reject a different existing submission. */
  retain(submission: ApplicationConversationSubmission<TRequest>): Promise<void>;
  /** Remove only if the stored value still matches this exact submission. */
  acknowledge(submission: ApplicationConversationSubmission<TRequest>): Promise<void>;
  /** Confirmed permanent deletion only. Reject late retains for this identity. */
  eraseConversation?(conversationId: string): Promise<void>;
}

/** Account-lifetime fallback. Hosts requiring reload recovery install a durable
 * store (for example IndexedDBApplicationConversationPendingStore). Ambiguous
 * sends are never evicted to make room for another conversation. */
export class InMemoryApplicationConversationPendingStore<TRequest = unknown> implements ApplicationConversationPendingStore<TRequest> {
  private readonly saved = new Map<string, { value: ApplicationConversationSubmission<TRequest>; json: string; bytes: number }>();
  private readonly deleted = new Set<string>();
  async load(conversationId: string): Promise<ApplicationConversationSubmission<TRequest> | null> { return this.saved.get(conversationId)?.value ?? null; }
  async retain(input: ApplicationConversationSubmission<TRequest>): Promise<void> {
    if (this.deleted.has(input.start.conversationId)) throw new Error("Conversation was permanently deleted");
    const value = parseApplicationConversationSubmission<TRequest>(input, input.start.conversationId), json = JSON.stringify(value);
    const existing = this.saved.get(value.start.conversationId);
    if (existing) { if (existing.json !== json) throw new Error("A different message is awaiting confirmation"); return; }
    const bytes = new TextEncoder().encode(json).byteLength;
    if (this.saved.size >= 32 || [...this.saved.values()].reduce((total, row) => total + row.bytes, bytes) > 4 * 1024 * 1024) throw new Error("Pending message storage is full");
    this.saved.set(value.start.conversationId, { value, json, bytes });
  }
  async acknowledge(value: ApplicationConversationSubmission<TRequest>): Promise<void> {
    if (this.saved.get(value.start.conversationId)?.json === JSON.stringify(value)) this.saved.delete(value.start.conversationId);
  }
  async eraseConversation(id: string): Promise<void> { this.deleted.add(id); this.saved.delete(id); }
  dispose(): void { this.saved.clear(); this.deleted.clear(); }
}

const maximumBytes = 1024 * 1024;
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}
function snapshot<T>(value: T): T {
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).byteLength > maximumBytes) throw new TypeError("Saved message exceeds the submission limit");
  return freeze(JSON.parse(json) as T);
}
/** Capture caller-owned data before the first await. Callbacks remain local. */
export function captureApplicationConversationInput<TRequest>(input: ConversationRuntimeSendMessageInput<TRequest>): ConversationRuntimeSendMessageInput<TRequest> {
  return snapshot({ content: input.content, request: input.request,
    ...(input.localDraft === undefined ? {} : { localDraft: parseDraftOrigin(input.localDraft) }),
    ...(input.attachments ? { attachments: input.attachments } : {}) });
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Validate a durable journal before retry; never substitute new IDs or content. */
export function parseApplicationConversationSubmission<TRequest>(input: unknown,
  conversationId: string): ApplicationConversationSubmission<TRequest> {
  const value = snapshot(input) as Partial<ApplicationConversationSubmission<TRequest>>;
  const fail = (): never => { throw new TypeError("Invalid saved conversation submission"); };
  if (!value || value.version !== 1 && value.version !== 2 || !id(value.messageId) || !value.start || !value.admission ||
      (value.version === 2) !== (value.localDraft !== undefined)) return fail();
  const { admission, start } = value;
  if (admission.conversationId !== conversationId || start.conversationId !== conversationId ||
    !id(start.conversationTurnId) || !id(start.mutationId) || !id(start.idempotencyKey) || start.request === undefined ||
    admission.expectedRevision !== null && (!Number.isSafeInteger(admission.expectedRevision) || admission.expectedRevision < 1) ||
    !Array.isArray(admission.mutations) || admission.mutations.length < 2 || admission.mutations.length > 34) return fail();
  const identities = new Set<string>();
  const eventIds = new Set<string>();
  for (const [index, mutation] of admission.mutations.entries()) {
    if (!id(mutation.mutationId) || identities.has(mutation.mutationId) || !Array.isArray(mutation.events) || mutation.events.length !== 1) return fail();
    identities.add(mutation.mutationId);
    const event = parseConversationEvent(mutation.events[0]);
    if (eventIds.has(event.event_id)) return fail();
    eventIds.add(event.event_id);
    if (event.conversation_id !== conversationId || event.mutation_id !== mutation.mutationId ||
        event.revision !== (admission.expectedRevision ?? 0) + index + 1) return fail();
    const payload = event.payload;
    if (index === 0 ? payload.type !== "message.created" || payload.role !== "user" || payload.message_id !== value.messageId
      : index === admission.mutations.length - 1 ? payload.type !== "turn.started" || payload.turn_id !== start.conversationTurnId ||
        payload.input_message_ids.length !== 1 || payload.input_message_ids[0] !== value.messageId
      : payload.type !== "message.attachment_referenced" || payload.message_id !== value.messageId) return fail();
  }
  if (start.mutationId !== admission.mutations[0]!.mutationId) return fail();
  if (value.localDraft !== undefined && (parseDraftOrigin(value.localDraft).fileIds?.length ?? 0) > admission.mutations.length - 2) return fail();
  return value as ApplicationConversationSubmission<TRequest>;
}

export function prepareApplicationConversationSubmission<TRequest>(options: {
  readonly conversationId: ConversationId;
  readonly clientId: ConversationClientId;
  readonly revision: number;
  readonly operationId: string;
  readonly now: string;
  readonly input: ConversationRuntimeSendMessageInput<TRequest>;
}): ApplicationConversationSubmission<TRequest> {
  const { conversationId, clientId, operationId, revision, now, input } = options;
  if (!id(operationId) || operationId.length > 100 || !Number.isSafeInteger(revision) || revision < 0) throw new TypeError("Invalid submission identity");
  const messageId = `message_${operationId}` as ConversationMessageId, turnId = `turn_${operationId}` as ConversationTurnId;
  const content = typeof input.content === "string" ? [{ type: "text", text: input.content }] : input.content;
  const payloads = [
    { type: "message.created", message_id: messageId, role: "user", content },
    ...(input.attachments ?? []).map(attachment => ({ type: "message.attachment_referenced", message_id: messageId, attachment })),
    { type: "turn.started", turn_id: turnId, input_message_ids: [messageId] },
  ];
  const mutations = payloads.map((payload, index) => {
    const mutationId = `mutation_${operationId}_${index}`;
    const event = parseConversationEvent({ version: 1, event_id: `event_${operationId}_${index}`, conversation_id: conversationId,
      revision: revision + index + 1, mutation_id: mutationId, occurred_at: now,
      actor: { type: payload.type === "turn.started" ? "assistant" : "user" },
      source: payload.type === "turn.started" ? { type: "runtime" } : { type: "client", client_id: clientId }, payload }) as ConversationSyncMutationEvent;
    return { mutationId: event.mutation_id, events: [event] as const };
  });
  return parseApplicationConversationSubmission<TRequest>({ version: input.localDraft === undefined ? 1 : 2, messageId,
    ...(input.localDraft === undefined ? {} : { localDraft: parseDraftOrigin(input.localDraft) }),
    admission: { conversationId, expectedRevision: revision === 0 ? null : revision as ConversationRevision, mutations },
    start: { conversationId, conversationTurnId: turnId, mutationId: mutations[0]!.mutationId,
      idempotencyKey: `start_${operationId}`, request: input.request } }, conversationId);
}
