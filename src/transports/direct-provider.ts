import { protocolCancellationReason } from "../cancellation.js";
import {
  AI_RUNTIME_PROTOCOL_VERSION,
  parseChatRequest,
  parseStreamEvent,
  parseStreamEvents,
  type AuthoritativeAttribution,
  type ChatRequest,
  type PublicError,
  type StreamEvent,
  type TerminalStreamEvent,
} from "../protocol.js";
import type {
  ProviderAdapter,
  ProviderAdapterError,
  ProviderAdapterMetadata,
  ProviderAdapterResult,
  ProviderDocumentReferenceResolver,
  ProviderRequestContext,
} from "../providers/index.js";
import {
  parseProviderCitationProjectionCapability,
  parseProviderDocumentInputCapability,
  UNSUPPORTED_PROVIDER_CITATION_PROJECTION,
  UNSUPPORTED_PROVIDER_DOCUMENT_INPUT,
} from "../providers/index.js";
import {
  describeProviderContextCapability,
  parseProviderContextCapabilityDescriptor,
  type ProviderContextCapability,
} from "../provider-context.js";
import {
  projectProviderUsageToReceipt,
  type KnownUsageValueStatus,
  type NormalizedUsageReceipt,
  type UsageAttemptIdentity,
  type UsageContinuationIdentity,
  type UsageReceiptSource,
} from "../usage.js";
import type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
  ConversationTransportCapabilities,
  StartTurnInput,
  TransportError,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationCancelled,
  TurnObservationCompleted,
  TurnObservationDisconnected,
  TurnObservationFailed,
  TurnResumePoint,
} from "./types.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";

const EMPTY_CHECKPOINT: TurnResumePoint = Object.freeze({
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
});

export interface DirectProviderUsageContext {
  readonly usage_receipt_id: string;
  readonly logical_request_id: string;
  readonly attempt: UsageAttemptIdentity;
  readonly continuation: UsageContinuationIdentity;
  readonly source: UsageReceiptSource;
  readonly quality: KnownUsageValueStatus;
}

/** Trusted, application-owned context for one provider invocation. */
export interface DirectProviderTurnContext extends ProviderRequestContext {
  readonly turn_id: string;
  readonly usage: DirectProviderUsageContext;
}

export type DirectProviderContextFactory = (
  input: StartTurnInput<ChatRequest>,
  provider: ProviderAdapterMetadata,
) => DirectProviderTurnContext | Promise<DirectProviderTurnContext>;

export interface DirectProviderTransportOptions {
  readonly adapter: ProviderAdapter;
  readonly createContext: DirectProviderContextFactory;
  /** Trusted host resolver passed only to adapters with negotiated document support. */
  readonly resolveDocumentReference?: ProviderDocumentReferenceResolver;
  /** Host-only provider lifecycle diagnostics. Prompts and payloads are never included. */
  readonly diagnostics?: AiDiagnosticSink;
}

export interface DirectProviderTurnObservationCompleted
  extends TurnObservationCompleted {
  readonly usageReceipt: NormalizedUsageReceipt;
}

export interface DirectProviderTurnObservationCancelled
  extends TurnObservationCancelled {
  readonly usageReceipt: NormalizedUsageReceipt | null;
}

export interface DirectProviderTurnObservationFailed extends TurnObservationFailed {
  readonly usageReceipt: NormalizedUsageReceipt | null;
}

export type DirectProviderTurnObservationResult =
  | DirectProviderTurnObservationCompleted
  | DirectProviderTurnObservationCancelled
  | DirectProviderTurnObservationFailed
  | TurnObservationDisconnected;

export interface DirectProviderTurnObservation
  extends Omit<TurnObservation<StreamEvent>, "result"> {
  readonly result: Promise<DirectProviderTurnObservationResult>;
}

export interface DirectProviderTurnHandle
  extends Omit<TurnHandle<StreamEvent>, "observation"> {
  readonly observation: DirectProviderTurnObservation;
}

export interface DirectProviderTransport
  extends ConversationTransport<StreamEvent, ChatRequest> {
  readonly capabilities: ConversationTransportCapabilities & {
    /** Provider-context operations negotiated directly from the configured adapter. */
    readonly providerContext: ProviderContextCapability;
  };
  startTurn(
    input: StartTurnInput<ChatRequest>,
  ): Promise<TransportResult<DirectProviderTurnHandle>>;
}

interface ActiveTurn {
  readonly controller: AbortController;
  terminal: boolean;
}

function transportFailure(error: TransportError): TransportResult<never> {
  return { ok: false, error };
}

function internalObservationFailure(): DirectProviderTurnObservationFailed {
  return {
    status: "failed",
    checkpoint: EMPTY_CHECKPOINT,
    error: {
      code: "internal_error",
      message: "The provider returned an invalid normalized response.",
      retryable: false,
    },
    usageReceipt: null,
  };
}

function publicErrorFor(error: ProviderAdapterError): PublicError {
  if (error.kind === "provider") {
    return {
      category: error.code === "rate_limited" ? "capacity" : "upstream",
      code: error.code,
      message: error.message,
      retryable: true,
    };
  }
  if (error.kind === "policy") {
    return {
      category: "policy",
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  return {
    category:
      error.code === "unauthenticated"
        ? "authentication"
        : error.code === "forbidden"
          ? "authorization"
          : "request",
    code: error.code,
    message: error.message,
    retryable: false,
  };
}

function transportErrorFor(error: ProviderAdapterError): TransportError {
  switch (error.code) {
    case "invalid_request":
      return { code: "invalid_request", message: error.message, retryable: false };
    case "unauthenticated":
      return { code: "unauthenticated", message: error.message, retryable: false };
    case "forbidden":
    case "policy_denied":
      return { code: "forbidden", message: error.message, retryable: false };
    case "idempotency_conflict":
      return { code: "conflict", message: error.message, retryable: false };
    case "rate_limited":
      return { code: "rate_limited", message: error.message, retryable: true };
    case "deadline_exceeded":
      return { code: "timeout", message: error.message, retryable: true };
    case "upstream_unavailable":
      return { code: "unavailable", message: error.message, retryable: true };
  }
}

function attributionMatches(
  actual: AuthoritativeAttribution,
  expected: AuthoritativeAttribution,
): boolean {
  return (
    actual.organization.id === expected.organization.id &&
    actual.project.id === expected.project.id &&
    actual.service_environment.id === expected.service_environment.id &&
    actual.known_user.id === expected.known_user.id &&
    actual.session.id === expected.session.id &&
    actual.automation.id === expected.automation.id
  );
}

function terminalMatchesResult(
  terminal: TerminalStreamEvent,
  result: ProviderAdapterResult,
): boolean {
  if (result.status === "completed") {
    return (
      terminal.type === "response.completed" &&
      terminal.outcome === result.outcome
    );
  }
  if (result.status === "cancelled") {
    return (
      terminal.type === "response.cancelled" &&
      terminal.reason === result.reason
    );
  }
  if (terminal.type !== "response.error") return false;
  const expected = publicErrorFor(result.error);
  return (
    terminal.error.category === expected.category &&
    terminal.error.code === expected.code &&
    terminal.error.message === expected.message &&
    terminal.error.retryable === expected.retryable
  );
}

function terminalEvent(event: StreamEvent): event is TerminalStreamEvent {
  return (
    event.type === "response.completed" ||
    event.type === "response.cancelled" ||
    event.type === "response.error"
  );
}

function validateContext(
  context: DirectProviderTurnContext,
  request: ChatRequest,
): void {
  parseStreamEvent({
    type: "response.started",
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: context.request_id,
    trace_id: context.trace_id,
    sequence: 0,
    attribution: context.attribution,
    ...(context.metadata === undefined ? {} : { metadata: context.metadata }),
  });
  parseChatRequest({
    ...request,
    correlation_hints: context.correlation_hints,
    ...(context.metadata === undefined ? {} : { metadata: context.metadata }),
  });
  if (
    typeof context.turn_id !== "string" ||
    context.turn_id.length === 0 ||
    context.turn_id.length > 256
  ) {
    throw new TypeError("turn_id must be a non-empty string of at most 256 characters");
  }
}

function validateIncrementalEvent(
  event: StreamEvent,
  events: readonly StreamEvent[],
  context: DirectProviderTurnContext,
  citationProjectionSupported: boolean,
): void {
  const index = events.length;
  if (event.sequence !== index) {
    throw new TypeError(`event sequence must equal ${index}`);
  }
  if (
    event.request_id !== context.request_id ||
    event.trace_id !== context.trace_id
  ) {
    throw new TypeError("event request and trace identifiers must match context");
  }
  if (index === 0) {
    if (
      event.type !== "response.started" ||
      !attributionMatches(event.attribution, context.attribution)
    ) {
      throw new TypeError("first event must match the trusted start context");
    }
  } else if (event.type === "response.started") {
    throw new TypeError("response.started may appear only once");
  }
  if (events.some(terminalEvent)) {
    throw new TypeError("terminal event must be last");
  }
  if (event.type === "response.citation_batch") {
    if (!citationProjectionSupported) {
      throw new TypeError(
        "citation batches require declared provider citation support",
      );
    }
    const previousBatches = events.filter(
      (candidate) => candidate.type === "response.citation_batch",
    );
    const previousTarget = previousBatches[0]?.target.message_id;
    if (
      previousTarget !== undefined &&
      event.target.message_id !== previousTarget
    ) {
      throw new TypeError("citation target must remain stable within the stream");
    }
    const previousCitations = previousBatches.flatMap(
      (batch) => batch.citations,
    );
    let nextOrder = previousCitations.length;
    const citationIds = new Set(
      previousCitations.map((citation) => citation.citation_id),
    );
    for (const citation of event.citations) {
      if (citation.order !== nextOrder) {
        throw new TypeError(`citation order must equal ${nextOrder}`);
      }
      if (citationIds.has(citation.citation_id)) {
        throw new TypeError("citation identity must be unique within the stream");
      }
      citationIds.add(citation.citation_id);
      nextOrder += 1;
    }
    const sources = new Map<string, string>();
    for (const batch of previousBatches) {
      for (const source of batch.sources) {
        sources.set(source.source_id, JSON.stringify(source));
      }
    }
    for (const source of event.sources) {
      const previous = sources.get(source.source_id);
      if (previous !== undefined && previous !== JSON.stringify(source)) {
        throw new TypeError("citation source identity must remain stable");
      }
    }
  }
}

function usageReceipt(
  result: ProviderAdapterResult,
  context: DirectProviderTurnContext,
  input: StartTurnInput<ChatRequest>,
  provider: ProviderAdapterMetadata,
  occurredAt: string,
): NormalizedUsageReceipt | null {
  if (result.usage === null) return null;
  return projectProviderUsageToReceipt(result.usage, {
    ...context.usage,
    occurred_at: occurredAt,
    conversation_id: input.conversationId,
    turn_id: input.conversationTurnId,
    trace_id: context.trace_id,
    provider_id: provider.provider_id,
    model_id: provider.model_id,
    attribution: context.attribution,
    terminal_status: result.status,
  });
}

function observationResult(
  result: ProviderAdapterResult,
  receipt: NormalizedUsageReceipt | null,
): DirectProviderTurnObservationResult {
  if (result.status === "completed") {
    if (receipt === null) throw new TypeError("completed result requires usage");
    return { status: "completed", checkpoint: EMPTY_CHECKPOINT, usageReceipt: receipt };
  }
  if (result.status === "cancelled") {
    return { status: "cancelled", checkpoint: EMPTY_CHECKPOINT, usageReceipt: receipt };
  }
  return {
    status: "failed",
    checkpoint: EMPTY_CHECKPOINT,
    error: transportErrorFor(result.error),
    usageReceipt: receipt,
  };
}

class DirectObservation implements DirectProviderTurnObservation {
  readonly result: Promise<DirectProviderTurnObservationResult>;
  readonly events: AsyncIterable<StreamEvent>;
  readonly #buffer: StreamEvent[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #resolveResult: (result: DirectProviderTurnObservationResult) => void;
  #closed = false;
  #disconnected = false;
  #settled = false;

  constructor() {
    let resolveResult!: (result: DirectProviderTurnObservationResult) => void;
    this.result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    this.#resolveResult = resolveResult;
    this.events = { [Symbol.asyncIterator]: () => this.#iterate() };
  }

  disconnect(): void {
    if (this.#closed || this.#disconnected) return;
    this.#disconnected = true;
    this.#buffer.length = 0;
    this.#settle({ status: "disconnected", checkpoint: EMPTY_CHECKPOINT });
    this.#wake();
  }

  push(event: StreamEvent): void {
    if (this.#closed || this.#disconnected) return;
    this.#buffer.push(event);
    this.#wake();
  }

  close(result: DirectProviderTurnObservationResult): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#settle(result);
    this.#wake();
  }

  async *#iterate(): AsyncGenerator<StreamEvent, void, void> {
    try {
      while (!this.#disconnected) {
        const event = this.#buffer.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        if (this.#closed) return;
        await new Promise<void>((resolve) => this.#waiters.add(resolve));
      }
    } finally {
      if (!this.#closed && !this.#disconnected) this.disconnect();
    }
  }

  #settle(result: DirectProviderTurnObservationResult): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveResult(result);
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

async function pumpProvider(
  adapter: ProviderAdapter,
  input: StartTurnInput<ChatRequest>,
  context: DirectProviderTurnContext,
  controller: AbortController,
  observation: DirectObservation,
  active: ActiveTurn,
  resolveDocumentReference: ProviderDocumentReferenceResolver | undefined,
  citationProjectionSupported: boolean,
  diagnostics: AiDiagnosticSink | undefined,
): Promise<void> {
  const events: StreamEvent[] = [];
  let heldTerminal: TerminalStreamEvent | null = null;
  const startedAt = Date.now();
  const diagnostic = {
    domain: "provider" as const,
    operation: "invoke",
    conversationId: input.conversationId,
    turnId: context.turn_id,
    requestId: context.request_id,
    traceId: context.trace_id,
    providerId: adapter.metadata.provider_id,
    modelId: adapter.metadata.model_id,
  };

  try {
    emitAiDiagnostic(diagnostics, { ...diagnostic, phase: "started" });
    const stream = adapter.invoke({
      continuation_of: input.request.continuation_of,
      messages: input.request.messages,
      tools: input.request.tools,
      tool_results: input.request.tool_results,
      generation: input.request.generation,
      signal: controller.signal,
      context: {
        request_id: context.request_id,
        trace_id: context.trace_id,
        attribution: context.attribution,
        correlation_hints: context.correlation_hints,
        ...(context.metadata === undefined ? {} : { metadata: context.metadata }),
      },
      ...(resolveDocumentReference === undefined
        ? {}
        : { resolve_document_reference: resolveDocumentReference }),
    });

    let item = await stream.next();
    while (!item.done) {
      const event = parseStreamEvent(item.value);
      validateIncrementalEvent(
        event,
        events,
        context,
        citationProjectionSupported,
      );
      events.push(event);
      if (terminalEvent(event)) heldTerminal = event;
      else observation.push(event);
      item = await stream.next();
    }

    parseStreamEvents(events);
    if (heldTerminal === null || !terminalMatchesResult(heldTerminal, item.value)) {
      throw new TypeError("terminal event does not match provider result");
    }
    const receipt = usageReceipt(
      item.value,
      context,
      input,
      adapter.metadata,
      new Date(startedAt).toISOString(),
    );
    observation.push(heldTerminal);
    observation.close(observationResult(item.value, receipt));
    emitAiDiagnostic(diagnostics, {
      ...diagnostic,
      phase: item.value.status === "completed" ? "succeeded" :
        item.value.status === "cancelled" ? "cancelled" : "failed",
      durationMs: Date.now() - startedAt,
      ...(item.value.status === "failed"
        ? { code: item.value.error.code, retryable: item.value.error.retryable }
        : {}),
    });
  } catch (cause) {
    emitAiDiagnostic(diagnostics, { ...diagnostic, phase: controller.signal.aborted ? "cancelled" : "failed",
      code: cause instanceof Error ? cause.name : "unknown", durationMs: Date.now() - startedAt,
      retryable: false, cause });
    observation.close(internalObservationFailure());
  } finally {
    active.terminal = true;
  }
}

/**
 * Bridges an application-configured provider adapter to ConversationTransport.
 * It has no replay store; resume therefore reports a normalized miss.
 */
export function createDirectProviderTransport(
  options: DirectProviderTransportOptions,
): DirectProviderTransport {
  const providerDocumentInput = parseProviderDocumentInputCapability(
    options.adapter.metadata.capabilities.document_input,
  );
  const citationProjection = parseProviderCitationProjectionCapability(
    options.adapter.metadata.capabilities.citation_projection ??
      UNSUPPORTED_PROVIDER_CITATION_PROJECTION,
  );
  const documentInput =
    providerDocumentInput.supported &&
    (!providerDocumentInput.capability.requires_host_resolution ||
      options.resolveDocumentReference !== undefined)
      ? providerDocumentInput
      : UNSUPPORTED_PROVIDER_DOCUMENT_INPUT;
  const declaredProviderContext = parseProviderContextCapabilityDescriptor(
    options.adapter.metadata.capabilities.provider_context,
  );
  const operationalProviderContext = describeProviderContextCapability(
    options.adapter.provider_context,
  );
  if (
    declaredProviderContext.supported !== operationalProviderContext.supported ||
    (declaredProviderContext.supported &&
      operationalProviderContext.supported &&
      declaredProviderContext.version !== operationalProviderContext.version) ||
    (!declaredProviderContext.supported &&
      !operationalProviderContext.supported &&
      declaredProviderContext.reason !== operationalProviderContext.reason)
  ) {
    throw new TypeError(
      "provider-context metadata must match the adapter capability",
    );
  }
  const providerContext = operationalProviderContext.supported
    ? options.adapter.provider_context
    : operationalProviderContext;
  const turns = new Map<string, ActiveTurn>();
  const turnKey = (conversationId: string, turnId: string): string =>
    `${conversationId.length}:${conversationId}${turnId}`;

  const cancelTurn = async (
    input: CancelTurnInput,
  ): Promise<TransportResult<AuthoritativeCancelTurnResult>> => {
    const active = turns.get(turnKey(input.conversationId, input.turnId));
    if (active === undefined) {
      return transportFailure({
        code: "not_found",
        message: "The direct provider turn was not found in this process.",
        retryable: false,
      });
    }
    if (active.terminal) {
      return { ok: true, value: { status: "already_terminal" } };
    }
    active.controller.abort(protocolCancellationReason(input.reason));
    return { ok: true, value: { status: "cancellation_requested" } };
  };

  const transport: DirectProviderTransport = {
    capabilities: {
      authoritativeCancellation: {
        supported: true,
        capability: { cancelTurn },
      },
      documentInput,
      providerContext,
      attachmentUpload: { supported: false },
      presence: { supported: false },
      synchronization: { supported: false },
    },

    async startTurn(
      input: StartTurnInput<ChatRequest>,
    ): Promise<TransportResult<DirectProviderTurnHandle>> {
      let request: ChatRequest;
      try {
        request = parseChatRequest(input.request);
      } catch {
        return transportFailure({
          code: "invalid_request",
          message: "The provider-neutral request is invalid.",
          retryable: false,
        });
      }

      const documents = request.messages.flatMap((message) =>
        message.content.filter((part) => part.type === "document"),
      );
      if (documents.length > 0) {
        if (!documentInput.supported) {
          return transportFailure({
            code: "invalid_request",
            message: "Document input is not supported by this transport.",
            retryable: false,
          });
        }
        const descriptor = documentInput.capability;
        if (
          documents.length > descriptor.max_document_count ||
          documents.some(
            (part) =>
              !descriptor.supported_mime_types.includes(
                part.attachment.media_type,
              ) || part.attachment.byte_size > descriptor.max_document_bytes,
          )
        ) {
          return transportFailure({
            code: "invalid_request",
            message: "Document input exceeds the negotiated transport capability.",
            retryable: false,
          });
        }
      }

      const normalizedInput = { ...input, request };
      let context: DirectProviderTurnContext;
      try {
        context = await options.createContext(normalizedInput, options.adapter.metadata);
        validateContext(context, request);
      } catch {
        return transportFailure({
          code: "internal_error",
          message: "The trusted provider context is invalid.",
          retryable: false,
        });
      }

      const key = turnKey(input.conversationId, context.turn_id);
      if (turns.has(key)) {
        return transportFailure({
          code: "conflict",
          message: "The direct provider turn already exists in this process.",
          retryable: false,
        });
      }

      const controller = new AbortController();
      const observation = new DirectObservation();
      const active: ActiveTurn = { controller, terminal: false };
      turns.set(key, active);
      void pumpProvider(
        options.adapter,
        normalizedInput,
        context,
        controller,
        observation,
        active,
        options.resolveDocumentReference,
        citationProjection.supported,
        options.diagnostics,
      );

      return {
        ok: true,
        value: {
          conversationId: input.conversationId,
          turnId: context.turn_id,
          mutationId: input.mutationId,
          observation,
        },
      };
    },

    async resumeTurn(): Promise<TransportResult<DirectProviderTurnObservation>> {
      return transportFailure({
        code: "not_found",
        message: "Direct provider turns cannot be resumed without an application event store.",
        retryable: false,
      });
    },
  };

  return transport;
}
