import { describe, expect, it, vi } from "vitest";

import * as browserEntry from "../src/browser/index.js";
import {
  AI_RUNTIME_PROTOCOL_VERSION,
  createDirectProviderTransport,
  type AuthoritativeAttribution,
  type ChatRequest,
  type ConversationTurnId,
  type DirectProviderTurnContext,
  type ProviderAdapter,
  type ProviderAdapterInvocation,
  type ProviderAdapterStream,
  type ProviderContextCapability,
  type ProviderUsage,
  type StreamEvent,
} from "../src/index.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_direct", source: "server_derived", trust: "authoritative" },
  project: { id: "project_direct", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "development",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: "user_direct", source: "server_derived", trust: "authoritative" },
  session: { id: "session_direct", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const usage: ProviderUsage = {
  input_tokens: 12,
  cached_input_tokens: 2,
  output_tokens: 5,
  reasoning_tokens: 1,
  total_tokens: 17,
  provider_cost: { known: true, amount: "0.00017", currency: "USD" },
};

const request: ChatRequest = {
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [
    {
      name: "lookup_weather",
      description: "Look up weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  tool_results: [],
  generation: { max_output_tokens: 64, temperature: 0.2 },
  correlation_hints: {
    session: {
      external_id: "client-session",
      source: "client",
      trust: "untrusted_correlation_hint",
    },
  },
  metadata: { surface: "support_chat" },
};

const documentRequest: ChatRequest = {
  ...request,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize this PDF" },
        {
          type: "document",
          attachment: {
            attachment_id: "att_direct_pdf",
            content_ref: "ref_direct_pdf",
            media_type: "application/pdf",
            byte_size: 1_024,
            filename: "fixture.pdf",
          },
        },
      ],
    },
  ],
};

const conversationTurnId = "conversation_turn_direct" as ConversationTurnId;
const remoteTransportTurnId = "remote_transport_turn_direct";

function context(): DirectProviderTurnContext & { readonly private_marker: string } {
  return {
    request_id: "request_direct",
    trace_id: "trace_direct",
    turn_id: remoteTransportTurnId,
    attribution,
    correlation_hints: request.correlation_hints,
    metadata: { route: "direct" },
    usage: {
      usage_receipt_id: "usage_direct",
      logical_request_id: "logical_direct",
      attempt: { id: "attempt_direct", index: 0 },
      continuation: { id: "continuation_direct", index: 0 },
      source: "provider",
      quality: "reported",
    },
    private_marker: "private-server-value",
  };
}

function envelope(
  invocation: ProviderAdapterInvocation,
  type: StreamEvent["type"],
  sequence: number,
) {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: invocation.context.request_id,
    trace_id: invocation.context.trace_id,
    sequence,
  } as const;
}

class FakeAdapter implements ProviderAdapter {
  readonly provider_context = {
    supported: false,
    reason: "provider_not_supported",
  } as const;
  readonly metadata = {
    provider_id: "fake-direct",
    model_id: "fake-model-v1",
    capabilities: {
      streaming: true,
      text: true,
      tool_calls: true,
      parallel_tool_calls: false,
      reasoning: true,
      document_input: { supported: false },
      provider_context: this.provider_context,
      context_window_tokens: 8_192,
      max_output_tokens: 1_024,
    },
  } as const;
  invocation: ProviderAdapterInvocation | null = null;

  constructor(
    private readonly streamFactory: (
      invocation: ProviderAdapterInvocation,
    ) => ProviderAdapterStream,
  ) {}

  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    this.invocation = invocation;
    return this.streamFactory(invocation);
  }
}

function createTransport(adapter: ProviderAdapter) {
  return createDirectProviderTransport({
    adapter,
    createContext: () => context(),
  });
}

async function start(adapter: ProviderAdapter) {
  const transport = createTransport(adapter);
  const started = await transport.startTurn({
    conversationId: "conversation_direct",
    conversationTurnId,
    mutationId: "mutation_direct",
    idempotencyKey: "idempotency_direct",
    request,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  return { transport, handle: started.value };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const output: StreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("createDirectProviderTransport", () => {
  it("emits correlated provider lifecycle diagnostics without request payloads", async () => {
    const diagnostics: import("../src/index.js").AiDiagnosticEvent[] = [];
    const adapter = new FakeAdapter(async function* (invocation) {
      yield { ...envelope(invocation, "response.started", 0), type: "response.started",
        attribution: invocation.context.attribution };
      yield { ...envelope(invocation, "response.completed", 1), type: "response.completed", outcome: "stop" };
      return { status: "completed", outcome: "stop", usage };
    });
    const transport = createDirectProviderTransport({ adapter, createContext: () => context(),
      diagnostics: (event) => diagnostics.push(event) });
    const started = await transport.startTurn({ conversationId: "conversation_direct", conversationTurnId,
      mutationId: "mutation_diagnostics", idempotencyKey: "idempotency_diagnostics", request });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await collect(started.value.observation.events);
    await started.value.observation.result;

    expect(diagnostics.map((event) => event.phase)).toEqual(["started", "succeeded"]);
    expect(diagnostics[1]).toEqual(expect.objectContaining({ providerId: "fake-direct",
      modelId: "fake-model-v1", requestId: "request_direct", traceId: "trace_direct",
      durationMs: expect.any(Number) }));
    expect(JSON.stringify(diagnostics)).not.toContain("Hello");
  });

  it("negotiates unsupported provider context and preserves long canonical input", async () => {
    const callbackAccess = vi.fn();
    const unsupportedProviderContext = new Proxy(
      {
        supported: false,
        reason: "provider_not_supported",
      } as const,
      {
        get(target, property, receiver) {
          if (property === "measure" || property === "compact") {
            callbackAccess(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as ProviderContextCapability;
    const canonicalMessages: ChatRequest["messages"] = Array.from(
      { length: 48 },
      (_, index) => ({
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: [{
          type: "text" as const,
          text: `canonical-${index}-${"x".repeat(2_048)}`,
        }],
      }),
    );
    const canonicalToolResults: ChatRequest["tool_results"] = [{
      tool_call_id: "call_canonical",
      name: "lookup_weather",
      content: [{ type: "json", value: { city: "Bowling Green", temperature: 72 } }],
      is_error: false,
    }];
    const longRequest: ChatRequest = {
      ...request,
      continuation_of: "request_previous_canonical",
      messages: canonicalMessages,
      tool_results: canonicalToolResults,
    };
    const delegate = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.completed", 1),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const adapter: ProviderAdapter = {
      provider_context: unsupportedProviderContext,
      metadata: {
        ...delegate.metadata,
        capabilities: {
          ...delegate.metadata.capabilities,
          provider_context: {
            supported: false,
            reason: "provider_not_supported",
          },
        },
      },
      invoke: (invocation) => delegate.invoke(invocation),
    };
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => context(),
    });

    expect(transport.capabilities.providerContext).toEqual({
      supported: false,
      reason: "provider_not_supported",
    });
    const started = await transport.startTurn({
      conversationId: "conversation_direct",
      conversationTurnId,
      mutationId: "mutation_long_canonical",
      idempotencyKey: "idempotency_long_canonical",
      request: longRequest,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await collect(started.value.observation.events);
    await expect(started.value.observation.result).resolves.toMatchObject({
      status: "completed",
    });
    expect(delegate.invocation?.messages).toEqual(canonicalMessages);
    expect(delegate.invocation?.tool_results).toEqual(canonicalToolResults);
    expect(delegate.invocation?.messages).toHaveLength(48);
    expect(callbackAccess).not.toHaveBeenCalled();
  });

  it("rejects unsupported documents before host resolution or provider invocation", async () => {
    const adapter = new FakeAdapter(() => {
      throw new Error("unsupported documents must not invoke the provider");
    });
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([1]),
    }));
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => context(),
      resolveDocumentReference,
    });

    expect(transport.capabilities.documentInput).toEqual({ supported: false });
    await expect(
      transport.startTurn({
        conversationId: "conversation_direct",
        conversationTurnId,
        mutationId: "mutation_document_unsupported",
        idempotencyKey: "idempotency_document_unsupported",
        request: documentRequest,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "Document input is not supported by this transport.",
        retryable: false,
      },
    });
    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(adapter.invocation).toBeNull();
  });

  it("advertises valid configured document support and passes only the neutral resolver seam", async () => {
    const delegate = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.completed", 1),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const adapter: ProviderAdapter = {
      provider_context: delegate.provider_context,
      metadata: {
        ...delegate.metadata,
        capabilities: {
          ...delegate.metadata.capabilities,
          document_input: {
            supported: true,
            capability: {
              supported_mime_types: ["application/pdf"],
              max_document_count: 1,
              max_document_bytes: 2_048,
              requires_host_resolution: true,
            },
          },
        },
      },
      invoke: (invocation) => delegate.invoke(invocation),
    };
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([1]),
    }));
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => context(),
      resolveDocumentReference,
    });

    const documentInput = transport.capabilities.documentInput;
    expect(documentInput.supported).toBe(true);
    if (!documentInput.supported) throw new Error("document input should narrow");
    expect(documentInput.capability).toEqual({
      supported_mime_types: ["application/pdf"],
      max_document_count: 1,
      max_document_bytes: 2_048,
      requires_host_resolution: true,
    });

    const started = await transport.startTurn({
      conversationId: "conversation_direct",
      conversationTurnId,
      mutationId: "mutation_document_supported",
      idempotencyKey: "idempotency_document_supported",
      request: documentRequest,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await collect(started.value.observation.events);
    expect((await started.value.observation.result).status).toBe("completed");
    expect(delegate.invocation?.resolve_document_reference).toBe(
      resolveDocumentReference,
    );
    expect(resolveDocumentReference).not.toHaveBeenCalled();
  });

  it("does not advertise resolver-required support without a configured resolver", async () => {
    const delegate = new FakeAdapter(() => {
      throw new Error("missing resolver must prevent provider invocation");
    });
    const adapter: ProviderAdapter = {
      provider_context: delegate.provider_context,
      metadata: {
        ...delegate.metadata,
        capabilities: {
          ...delegate.metadata.capabilities,
          document_input: {
            supported: true,
            capability: {
              supported_mime_types: ["application/pdf"],
              max_document_count: 1,
              max_document_bytes: 2_048,
              requires_host_resolution: true,
            },
          },
        },
      },
      invoke: (invocation) => delegate.invoke(invocation),
    };
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => context(),
    });

    expect(transport.capabilities.documentInput).toEqual({ supported: false });
    const started = await transport.startTurn({
      conversationId: "conversation_direct",
      conversationTurnId,
      mutationId: "mutation_document_missing_resolver",
      idempotencyKey: "idempotency_document_missing_resolver",
      request: documentRequest,
    });
    expect(started).toMatchObject({
      ok: false,
      error: { code: "invalid_request", retryable: false },
    });
    expect(delegate.invocation).toBeNull();
  });

  it("maps and streams normalized text while projecting a validated usage receipt", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.text.delta", 1),
        type: "response.text.delta",
        delta: "Hello from direct transport",
      };
      yield {
        ...envelope(invocation, "response.usage", 2),
        type: "response.usage",
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      };
      yield {
        ...envelope(invocation, "response.completed", 3),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const { handle } = await start(adapter);
    const events = await collect(handle.observation.events);
    const result = await handle.observation.result;

    expect(handle.turnId).toBe(remoteTransportTurnId);
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.usage",
      "response.completed",
    ]);
    expect(adapter.invocation).toMatchObject({
      messages: request.messages,
      tools: request.tools,
      tool_results: request.tool_results,
      generation: request.generation,
      context: {
        request_id: "request_direct",
        trace_id: "trace_direct",
        metadata: { route: "direct" },
      },
    });
    expect(adapter.invocation?.context).not.toHaveProperty("private_marker");
    expect(result).toMatchObject({
      status: "completed",
      usageReceipt: {
        usage_receipt_id: "usage_direct",
        conversation_id: "conversation_direct",
        turn_id: conversationTurnId,
        provider_id: "fake-direct",
        model_id: "fake-model-v1",
        terminal_status: "completed",
        tokens: {
          cached_input_tokens: { status: "reported", value: 2 },
          reasoning_tokens: { status: "reported", value: 1 },
          total_tokens: { status: "reported", value: 17 },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(remoteTransportTurnId);
    expect(JSON.stringify(events)).not.toContain("private-server-value");
  });

  it("streams a normalized tool call unchanged", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      const toolCall = {
        ...envelope(invocation, "response.tool_call", 1),
        type: "response.tool_call" as const,
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      };
      yield toolCall;
      yield {
        ...envelope(invocation, "response.completed", 2),
        type: "response.completed",
        outcome: "tool_calls",
      };
      return { status: "completed", outcome: "tool_calls", usage };
    });
    const { handle } = await start(adapter);
    const events = await collect(handle.observation.events);

    expect(events[1]).toEqual({
      type: "response.tool_call",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: "request_direct",
      trace_id: "trace_direct",
      sequence: 1,
      tool_call_id: "call_weather",
      name: "lookup_weather",
      arguments: { city: "Chicago" },
    });
    expect((await handle.observation.result).status).toBe("completed");
  });

  it("preserves a retryable provider failure in the public terminal and result", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.error", 1),
        type: "response.error",
        error: {
          category: "upstream",
          code: "upstream_unavailable",
          message: "Provider temporarily unavailable",
          retryable: true,
        },
      };
      return {
        status: "failed",
        error: {
          kind: "provider",
          retryable: true,
          code: "upstream_unavailable",
          message: "Provider temporarily unavailable",
        },
        usage,
      };
    });
    const { handle } = await start(adapter);

    expect((await collect(handle.observation.events)).at(-1)).toMatchObject({
      type: "response.error",
      error: { code: "upstream_unavailable", retryable: true },
    });
    expect(await handle.observation.result).toMatchObject({
      status: "failed",
      error: { code: "unavailable", retryable: true },
      usageReceipt: {
        turn_id: conversationTurnId,
        terminal_status: "failed",
      },
    });
  });

  it.each([["user", "explicit_stop"], ["timeout", "deadline_exceeded"], ["superseded", "policy_revoked"], ["runtime_shutdown", "runtime_shutdown"]] as const)("aborts the active provider invocation and reports already_terminal after settlement", async (reason, wire) => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      if (!invocation.signal.aborted) {
        await new Promise<void>((resolve) =>
          invocation.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      yield {
        ...envelope(invocation, "response.cancelled", 1),
        type: "response.cancelled",
        reason: invocation.signal.reason,
      };
      return { status: "cancelled", reason: invocation.signal.reason, usage };
    });
    const { transport, handle } = await start(adapter);
    const cancellation = transport.capabilities.authoritativeCancellation;
    if (!cancellation.supported) throw new Error("cancellation should be supported");

    expect(
      await cancellation.capability.cancelTurn({
        conversationId: handle.conversationId,
        turnId: handle.turnId,
        mutationId: "cancel_mutation",
        idempotencyKey: "cancel_idempotency",
        reason,
      }),
    ).toEqual({ ok: true, value: { status: "cancellation_requested" } });
    expect(adapter.invocation?.signal.aborted).toBe(true);
    expect(adapter.invocation?.signal.reason).toBe(wire);
    expect((await collect(handle.observation.events)).at(-1)).toMatchObject({ type: "response.cancelled", reason: wire });
    expect(await handle.observation.result).toMatchObject({
      status: "cancelled",
      usageReceipt: {
        turn_id: conversationTurnId,
        terminal_status: "cancelled",
      },
    });
    expect(
      await cancellation.capability.cancelTurn({
        conversationId: handle.conversationId,
        turnId: handle.turnId,
        mutationId: "cancel_mutation_retry",
        idempotencyKey: "cancel_idempotency_retry",
        reason,
      }),
    ).toEqual({ ok: true, value: { status: "already_terminal" } });
  });

  it("disconnects only the local observer while the provider continues", async () => {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markBuffered = (): void => undefined;
    const buffered = new Promise<void>((resolve) => {
      markBuffered = resolve;
    });
    let providerSettled = false;
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.text.delta", 1),
        type: "response.text.delta",
        delta: "queued before disconnect",
      };
      markBuffered();
      await released;
      yield {
        ...envelope(invocation, "response.text.delta", 2),
        type: "response.text.delta",
        delta: "emitted after disconnect",
      };
      yield {
        ...envelope(invocation, "response.completed", 3),
        type: "response.completed",
        outcome: "stop",
      };
      providerSettled = true;
      return { status: "completed", outcome: "stop", usage };
    });
    const { transport, handle } = await start(adapter);

    await buffered;
    handle.observation.disconnect();
    expect(await handle.observation.result).toEqual({
      status: "disconnected",
      checkpoint: {
        lastAppliedEventId: null,
        lastAppliedCursor: null,
        lastAppliedRevision: null,
      },
    });
    expect(await collect(handle.observation.events)).toEqual([]);
    expect(adapter.invocation?.signal.aborted).toBe(false);
    release();
    await viWaitFor(() => providerSettled);
    expect(adapter.invocation?.signal.aborted).toBe(false);

    const cancellation = transport.capabilities.authoritativeCancellation;
    if (!cancellation.supported) throw new Error("cancellation should be supported");
    expect(
      await cancellation.capability.cancelTurn({
        conversationId: handle.conversationId,
        turnId: handle.turnId,
        mutationId: "late_cancel",
        idempotencyKey: "late_cancel_key",
        reason: "user",
      }),
    ).toEqual({ ok: true, value: { status: "already_terminal" } });
  });

  it("returns a normalized not-found result for unsupported resume", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const transport = createTransport(adapter);
    const resumed = await transport.resumeTurn({
      conversationId: "conversation_direct",
      turnId: "turn_lost",
      resumeFrom: {
        lastAppliedEventId: null,
        lastAppliedCursor: null,
        lastAppliedRevision: null,
      },
    });

    expect(resumed).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "Direct provider turns cannot be resumed without an application event store.",
        retryable: false,
      },
    });
    expect(transport.capabilities.attachmentUpload.supported).toBe(false);
    expect(transport.capabilities.documentInput.supported).toBe(false);
    expect(transport.capabilities.presence.supported).toBe(false);
    expect(transport.capabilities.synchronization.supported).toBe(false);
  });

  it("rejects a terminal event/result mismatch without exposing the terminal", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.text.delta", 1),
        type: "response.text.delta",
        delta: "partial",
      };
      yield {
        ...envelope(invocation, "response.completed", 2),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "length", usage };
    });
    const { handle } = await start(adapter);
    const events = await collect(handle.observation.events);

    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
    ]);
    expect(await handle.observation.result).toMatchObject({
      status: "failed",
      error: { code: "internal_error", retryable: false },
      usageReceipt: null,
    });
  });

  it("rejects malformed receipt identity at the validation boundary", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.completed", 1),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => {
        const trusted = context();
        return {
          ...trusted,
          usage: { ...trusted.usage, usage_receipt_id: "" },
        };
      },
    });
    const started = await transport.startTurn({
      conversationId: "conversation_direct",
      conversationTurnId,
      mutationId: "mutation_direct",
      idempotencyKey: "idempotency_direct",
      request,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(await collect(started.value.observation.events)).toEqual([
      expect.objectContaining({ type: "response.started" }),
    ]);
    expect(await started.value.observation.result).toMatchObject({
      status: "failed",
      error: { code: "internal_error", retryable: false },
      usageReceipt: null,
    });
  });

  it("validates the remote transport turn identity independently", async () => {
    const adapter = new FakeAdapter(() => {
      throw new Error("invalid trusted context must prevent provider invocation");
    });
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => ({ ...context(), turn_id: "" }),
    });

    expect(
      await transport.startTurn({
        conversationId: "conversation_direct",
        conversationTurnId,
        mutationId: "mutation_direct",
        idempotencyKey: "idempotency_direct",
        request,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "internal_error",
        message: "The trusted provider context is invalid.",
        retryable: false,
      },
    });
    expect(adapter.invocation).toBeNull();
  });

  it("validates the caller conversation turn identity independently", async () => {
    const adapter = new FakeAdapter(async function* (invocation) {
      yield {
        ...envelope(invocation, "response.started", 0),
        type: "response.started",
        attribution: invocation.context.attribution,
      };
      yield {
        ...envelope(invocation, "response.completed", 1),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const transport = createTransport(adapter);
    const started = await transport.startTurn({
      conversationId: "conversation_direct",
      conversationTurnId: "" as ConversationTurnId,
      mutationId: "mutation_direct",
      idempotencyKey: "idempotency_direct",
      request,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value.turnId).toBe(remoteTransportTurnId);
    expect(await collect(started.value.observation.events)).toEqual([
      expect.objectContaining({ type: "response.started" }),
    ]);
    expect(await started.value.observation.result).toMatchObject({
      status: "failed",
      error: { code: "internal_error", retryable: false },
      usageReceipt: null,
    });
  });

  it("keeps the browser entrypoint free of the direct server transport", () => {
    expect("createDirectProviderTransport" in browserEntry).toBe(false);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not settle");
}
