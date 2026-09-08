import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createConversationRuntime,
  createDirectProviderTransport,
  createRetryPolicy,
  parseConversationEvent,
  type AuthoritativeAttribution,
  type AuthoritativeCancelTurnResult,
  type CancelTurnInput,
  type ChatRequest,
  type ConversationClientId,
  type ConversationId,
  type ConversationTransport,
  type ProviderAdapter,
  type ProviderAdapterInvocation,
  type ProviderContextCapability,
  type StreamEvent,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "../src/index.js";
import { createManagedRuntimeTransport } from "../src/server/managed.js";

const conversationId = "conversation_cancellation" as ConversationId;
const clientId = "client_cancellation" as ConversationClientId;
const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const request: ChatRequest = {
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Cancel me" }] }],
  tools: [],
  tool_results: [],
  generation: { max_output_tokens: 64, temperature: 0 },
  correlation_hints: {},
};

function frame(type: StreamEvent["type"], sequence: number, fields = {}) {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "remote-turn",
    trace_id: "trace-cancel",
    sequence,
    ...fields,
  };
}

const started = () => frame("response.started", 0, { attribution });
const completed = () => frame("response.completed", 1, { outcome: "stop" });
const cancelled = () => frame("response.cancelled", 1, { reason: "runtime_shutdown" });
const failed = () => frame("response.error", 1, {
  error: {
    category: "upstream",
    code: "upstream_unavailable",
    message: "Unavailable",
    retryable: true,
  },
});

function checkpoint(raw: unknown): TurnResumePoint {
  const event = raw as { request_id: string; sequence: number };
  return {
    lastAppliedEventId: `${event.request_id}:${event.sequence}`,
    lastAppliedCursor: `${event.request_id}:${event.sequence}`,
    lastAppliedRevision: event.sequence,
  };
}

class ControlledObservation implements TurnObservation<unknown> {
  readonly #queue: unknown[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;
  #checkpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  #settled = false;
  readonly result: Promise<TurnObservationResult>;
  #settle!: (result: TurnObservationResult) => void;

  constructor(initial: readonly unknown[] = []) {
    this.#queue.push(...initial);
    this.result = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  readonly events: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        while (this.#queue.length === 0 && !this.#closed) {
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
        const value = this.#queue.shift();
        if (value === undefined) return { done: true, value: undefined };
        this.#checkpoint = checkpoint(value);
        return { done: false, value };
      },
    }),
  };

  finish(terminal: unknown, result: TurnObservationResult): void {
    this.#queue.push(terminal);
    this.#closed = true;
    this.#resolveWaiters();
    this.#resolveResult(result);
  }

  disconnect(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#resolveWaiters();
    this.#resolveResult({ status: "disconnected", checkpoint: this.#checkpoint });
  }

  #resolveResult(result: TurnObservationResult): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle(result);
  }

  #resolveWaiters(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

type CancelHandler = (
  input: CancelTurnInput,
) => Promise<TransportResult<AuthoritativeCancelTurnResult>>;

class TestTransport implements ConversationTransport<unknown, ChatRequest> {
  readonly starts: ControlledObservation[] = [];
  readonly resumes: ControlledObservation[] = [];
  readonly cancellationInputs: CancelTurnInput[] = [];
  readonly capabilities: ConversationTransport["capabilities"];

  constructor(cancel?: CancelHandler) {
    this.capabilities = cancel === undefined
      ? {
          authoritativeCancellation: { supported: false },
          documentInput: { supported: false },
          attachmentUpload: { supported: false },
          presence: { supported: false },
          synchronization: { supported: false },
        }
      : {
          authoritativeCancellation: {
            supported: true,
            capability: {
              cancelTurn: async (input) => {
                this.cancellationInputs.push(input);
                return cancel(input);
              },
            },
          },
          documentInput: { supported: false },
          attachmentUpload: { supported: false },
          presence: { supported: false },
          synchronization: { supported: false },
        };
  }

  async startTurn(input: Parameters<ConversationTransport<unknown, ChatRequest>["startTurn"]>[0]) {
    const observation = this.starts.shift();
    if (observation === undefined) throw new Error("No start observation queued");
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: "remote-turn",
        mutationId: input.mutationId,
        observation,
      },
    } satisfies TransportResult<TurnHandle<unknown>>;
  }

  async resumeTurn() {
    const observation = this.resumes.shift();
    if (observation === undefined) throw new Error("No resume observation queued");
    return { ok: true, value: observation } as const;
  }
}

function deterministicSources() {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: string) {
      id += 1;
      return `${kind}.cancellation-${id}`;
    },
    now() {
      tick += 1;
      return `2026-08-27T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

async function runtimeFor(transport: ConversationTransport<unknown, ChatRequest>) {
  const eventStore = new InMemoryConversationEventStore();
  const runtime = await createConversationRuntime({
    conversationId,
    clientId,
    transport,
    eventStore,
    retryPolicy: createRetryPolicy({ maximumAttempts: 3, initialDelayMs: 0 }),
    ...deterministicSources(),
  });
  return { runtime, eventStore };
}

async function activeTurnId(runtime: Awaited<ReturnType<typeof runtimeFor>>["runtime"]) {
  await vi.waitFor(() => expect(runtime.getSnapshot().active_turn_id).not.toBeNull());
  return runtime.getSnapshot().active_turn_id!;
}

describe("ConversationRuntime cancellation", () => {
  it.each(["acknowledgement", "history race"])("synchronizes a saved completion when Stop encounters an %s", async (mode) => {
    let complete!: () => Promise<void>;
    const transport = new TestTransport(async () => {
      await complete();
      return { ok: true, value: { status: "already_terminal" } };
    });
    const observation = new ControlledObservation([started()]);
    transport.starts.push(observation);
    const { runtime, eventStore } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Already finished", request });
    const turnId = await activeTurnId(runtime);
    const append = eventStore.append.bind(eventStore);
    complete = async () => {
      const revision = await eventStore.getLatestRevision(conversationId);
      await append({ conversationId, expectedRevision: revision, events: [parseConversationEvent({
        version: 1, conversation_id: conversationId, event_id: "server-completion", revision: (revision ?? 0) + 1,
        occurred_at: "2026-08-27T12:01:00.000Z", actor: { type: "assistant" }, source: { type: "runtime" },
        payload: { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] },
      })] });
    };
    if (mode === "history race") vi.spyOn(eventStore, "append").mockImplementation(async (input) => {
      if (input.events.some((event) => event.payload.type === "turn.cancellation_requested")) {
        await complete();
        throw new Error("The turn completed during cancellation");
      }
      return append(input);
    });
    try {
      await expect(runtime.cancelTurn(turnId, "user")).resolves.toMatchObject({ status: "already_terminal", remoteMayStillBeRunning: false });
      await expect(sending).resolves.toMatchObject({ status: "completed" });
      expect(runtime.getSnapshot().active_turn_id).toBeNull();
      expect(runtime.getSnapshot().turns[0]?.status).toBe("completed");
    } finally { runtime.destroy(); await sending.catch(() => undefined); }
  });

  it.each(["write", "transport", "exception"])("retries Stop after a failed %s without repeating accepted cancellation", async (failure) => {
    let calls = 0;
    const transport = new TestTransport(async () => {
      calls += 1;
      if (calls === 1 && failure === "exception") throw new Error("Connection interrupted");
      if (calls === 1 && failure === "transport") return { ok: false, error: { code: "unavailable", message: "Try again", retryable: true } };
      return { ok: true, value: { status: "cancellation_requested" } };
    });
    const observation = new ControlledObservation([started()]);
    transport.starts.push(observation);
    const { runtime, eventStore } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Stop retry", request });
    const turnId = await activeTurnId(runtime);
    const originalAppend = eventStore.append.bind(eventStore);
    let failWrite = failure === "write";
    vi.spyOn(eventStore, "append").mockImplementation(async (input) => {
      if (failWrite && input.events.some((event) => event.payload.type === "turn.cancellation_requested")) {
        failWrite = false;
        throw new Error("History temporarily unavailable");
      }
      return originalAppend(input);
    });
    try {
      const first = runtime.cancelTurn(turnId, "user");
      if (failure === "write") await expect(first).rejects.toThrow("History temporarily unavailable");
      else await expect(first).resolves.toMatchObject({ status: "failed" });
      const retry = runtime.cancelTurn(turnId, "user");
      expect(retry).not.toBe(first);
      await expect(retry).resolves.toMatchObject({ status: "cancellation_requested" });
      expect(runtime.cancelTurn(turnId, "user")).toBe(retry);
      expect(calls).toBe(failure === "write" ? 1 : 2);
      observation.finish(cancelled(), { status: "cancelled", checkpoint: checkpoint(cancelled()) });
      await expect(sending).resolves.toMatchObject({ status: "cancelled" });
    } finally { runtime.destroy(); await sending.catch(() => undefined); }
  });

  it("stops only local observation and permits a later explicit resume", async () => {
    const transport = new TestTransport();
    transport.starts.push(new ControlledObservation([started()]));
    const resumed = new ControlledObservation();
    resumed.finish(completed(), { status: "completed", checkpoint: checkpoint(completed()) });
    transport.resumes.push(resumed);
    const { runtime, eventStore } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Stop", request });
    const turnId = await activeTurnId(runtime);
    await vi.waitFor(() => expect(runtime.getSnapshot().turns[0]?.status).toBe("running"));

    expect(runtime.stopObserving(turnId)).toBe(true);
    await expect(sending).resolves.toMatchObject({ status: "disconnected" });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "running",
      cancellation_status: null,
      remote_may_still_be_running: true,
    });

    await expect(runtime.resumeTurn(turnId)).resolves.toMatchObject({ status: "completed" });
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.payload.type)).not.toContain(
      "turn.cancelled",
    );
    expect(JSON.stringify(history.entries)).not.toContain("response.cancelled");
  });

  it("authoritatively cancels a direct-provider turn", async () => {
    let invocation: ProviderAdapterInvocation | null = null;
    const adapter: ProviderAdapter = {
      provider_context: {
        supported: false,
        reason: "provider_not_supported",
      },
      metadata: {
        provider_id: "fake",
        model_id: "fake-v1",
        capabilities: {
          streaming: true,
          text: true,
          tool_calls: false,
          parallel_tool_calls: false,
          reasoning: false,
          document_input: { supported: false },
          provider_context: {
            supported: false,
            reason: "provider_not_supported",
          },
          context_window_tokens: 8_192,
          max_output_tokens: 1_024,
        },
      },
      async *invoke(current) {
        invocation = current;
        yield { ...started(), request_id: current.context.request_id, trace_id: current.context.trace_id } as StreamEvent;
        if (!current.signal.aborted) {
          await new Promise<void>((resolve) =>
            current.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        yield {
          ...cancelled(),
          request_id: current.context.request_id,
          trace_id: current.context.trace_id,
          reason: current.signal.reason,
        } as StreamEvent;
        return { status: "cancelled", reason: current.signal.reason, usage: null };
      },
    };
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => ({
        request_id: "remote-turn",
        trace_id: "trace-cancel",
        turn_id: "remote-turn",
        attribution,
        correlation_hints: {},
        metadata: {},
        usage: {
          usage_receipt_id: "usage-cancel",
          logical_request_id: "logical-cancel",
          attempt: { id: "attempt-cancel", index: 0 },
          continuation: { id: "continuation-cancel", index: 0 },
          source: "provider",
          quality: "reported",
        },
      }),
    });
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Cancel", request });
    const turnId = await activeTurnId(runtime);
    await vi.waitFor(() => expect(invocation).not.toBeNull());

    await expect(runtime.cancelTurn(turnId, "user")).resolves.toMatchObject({
      status: "cancellation_requested",
      remoteMayStillBeRunning: true,
    });
    await expect(sending).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "cancelled",
      cancellation_status: "cancelled",
      cancellation_reason: "user",
      cancellation_requested_reason: "user",
      remote_may_still_be_running: false,
    });
  });

  it("waits for a transport handle when cancellation wins the start race", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const observation = new ControlledObservation([started()]);
    const transport = new TestTransport(async () => ({
      ok: true,
      value: { status: "cancellation_requested" },
    }));
    vi.spyOn(transport, "startTurn").mockImplementation(async (input) => {
      await startGate;
      return {
        ok: true,
        value: {
          conversationId: input.conversationId,
          turnId: "remote-turn",
          mutationId: input.mutationId,
          observation,
        },
      } satisfies TransportResult<TurnHandle<unknown>>;
    });
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Cancel while starting", request });
    const turnId = await activeTurnId(runtime);

    const cancelling = runtime.cancelTurn(turnId, "user");
    await Promise.resolve();
    expect(transport.cancellationInputs).toHaveLength(0);

    releaseStart();
    await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));
    await expect(cancelling).resolves.toMatchObject({
      status: "cancellation_requested",
      remoteMayStillBeRunning: true,
    });
    expect(transport.cancellationInputs[0]?.turnId).toBe("remote-turn");

    observation.finish(cancelled(), {
      status: "cancelled",
      checkpoint: checkpoint(cancelled()),
    });
    await expect(sending).resolves.toMatchObject({ status: "cancelled" });
  });

  it("keeps full canonical provider input when direct provider context is unsupported", async () => {
    const callbackAccess = vi.fn();
    const providerContext = new Proxy(
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
          text: `runtime-canonical-${index}-${"y".repeat(2_048)}`,
        }],
      }),
    );
    const canonicalToolResults: ChatRequest["tool_results"] = [{
      tool_call_id: "call_runtime_canonical",
      name: "canonical_tool",
      content: [{ type: "text", text: "canonical tool result" }],
      is_error: false,
    }];
    const longRequest: ChatRequest = {
      ...request,
      continuation_of: "request_previous_runtime_canonical",
      messages: canonicalMessages,
      tools: [{
        name: "canonical_tool",
        description: "Returns a canonical fixture result",
        input_schema: { type: "object", properties: {} },
      }],
      tool_results: canonicalToolResults,
    };
    let invocation: ProviderAdapterInvocation | null = null;
    const adapter: ProviderAdapter = {
      provider_context: providerContext,
      metadata: {
        provider_id: "fake-unsupported-context",
        model_id: "fake-long-context-v1",
        capabilities: {
          streaming: true,
          text: true,
          tool_calls: true,
          parallel_tool_calls: false,
          reasoning: false,
          document_input: { supported: false },
          provider_context: {
            supported: false,
            reason: "provider_not_supported",
          },
          context_window_tokens: 8_192,
          max_output_tokens: 1_024,
        },
      },
      async *invoke(current) {
        invocation = current;
        yield {
          ...started(),
          request_id: current.context.request_id,
          trace_id: current.context.trace_id,
        } as StreamEvent;
        yield {
          ...completed(),
          request_id: current.context.request_id,
          trace_id: current.context.trace_id,
        } as StreamEvent;
        return {
          status: "completed",
          outcome: "stop",
          usage: {
            input_tokens: 24_000,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_tokens: 0,
            total_tokens: 24_001,
            provider_cost: { known: false },
          },
        };
      },
    };
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => ({
        request_id: "remote-turn",
        trace_id: "trace-cancel",
        turn_id: "remote-turn",
        attribution,
        correlation_hints: {},
        usage: {
          usage_receipt_id: "usage-long-canonical",
          logical_request_id: "logical-long-canonical",
          attempt: { id: "attempt-long-canonical", index: 0 },
          continuation: { id: "continuation-long-canonical", index: 0 },
          source: "provider",
          quality: "reported",
        },
      }),
    });
    const { runtime } = await runtimeFor(transport);

    expect(transport.capabilities.providerContext).toEqual({
      supported: false,
      reason: "provider_not_supported",
    });
    await expect(runtime.sendMessage({
      content: "Preserve canonical history",
      request: longRequest,
    })).resolves.toMatchObject({ status: "completed" });
    expect(invocation).not.toBeNull();
    const providerInvocation = invocation as unknown as ProviderAdapterInvocation;
    expect(providerInvocation.messages).toEqual(canonicalMessages);
    expect(providerInvocation.tool_results).toEqual(canonicalToolResults);
    expect(providerInvocation.messages).toHaveLength(48);
    expect(callbackAccess).not.toHaveBeenCalled();
  });

  it("reports unsupported managed cancellation and stops only local observation", async () => {
    const encoder = new TextEncoder();
    const managed = createManagedRuntimeTransport({
      baseUrl: "https://runtime.example.test",
      getHeaders: async () => ({}),
      fetch: async (_url, init = {}) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.started\nid: remote-turn:0\ndata: ${JSON.stringify(started())}\n\n`,
          ));
          init.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const { runtime, eventStore } = await runtimeFor(managed);
    const sending = runtime.sendMessage({ content: "Unsupported", request });
    const turnId = await activeTurnId(runtime);
    await vi.waitFor(() => expect(runtime.getSnapshot().turns[0]?.status).toBe("running"));

    await expect(runtime.cancelTurn(turnId, "user")).resolves.toMatchObject({
      status: "unsupported",
      remoteMayStillBeRunning: true,
    });
    await expect(sending).resolves.toMatchObject({ status: "disconnected" });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "running",
      cancellation_status: "unsupported",
      remote_may_still_be_running: true,
    });
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.payload.type)).toContain(
      "turn.cancellation_unsupported",
    );
    expect(history.entries.map(({ event }) => event.payload.type)).not.toContain(
      "turn.cancelled",
    );
  });

  it("shares one stable cancellation operation across repeated calls", async () => {
    let resolveCancel!: (result: TransportResult<AuthoritativeCancelTurnResult>) => void;
    const transport = new TestTransport(() => new Promise((resolve) => {
      resolveCancel = resolve;
    }));
    const observation = new ControlledObservation([started()]);
    transport.starts.push(observation);
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Repeat", request });
    const turnId = await activeTurnId(runtime);

    const first = runtime.cancelTurn(turnId, "user");
    const second = runtime.cancelTurn(turnId, "timeout");
    expect(second).toBe(first);
    await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));
    resolveCancel({ ok: true, value: { status: "cancellation_requested" } });
    await expect(first).resolves.toMatchObject({ reason: "user" });
    expect(transport.cancellationInputs[0]).toMatchObject({ reason: "user" });

    observation.finish(cancelled(), {
      status: "cancelled",
      checkpoint: checkpoint(cancelled()),
    });
    await sending;
  });

  for (const terminal of ["completed", "failed"] as const) {
    it(`keeps a racing ${terminal} terminal event authoritative`, async () => {
      let resolveCancel!: (result: TransportResult<AuthoritativeCancelTurnResult>) => void;
      const transport = new TestTransport(() => new Promise((resolve) => {
        resolveCancel = resolve;
      }));
      const observation = new ControlledObservation([started()]);
      transport.starts.push(observation);
      const { runtime } = await runtimeFor(transport);
      const sending = runtime.sendMessage({ content: "Race", request });
      const turnId = await activeTurnId(runtime);
      const cancelling = runtime.cancelTurn(turnId, "user");
      await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));

      if (terminal === "completed") {
        observation.finish(completed(), {
          status: "completed",
          checkpoint: checkpoint(completed()),
        });
      } else {
        observation.finish(failed(), {
          status: "failed",
          checkpoint: checkpoint(failed()),
          error: { code: "unavailable", message: "Unavailable", retryable: true },
        });
      }
      await expect(sending).resolves.toMatchObject({ status: terminal });
      resolveCancel({ ok: true, value: { status: "cancellation_requested" } });
      await cancelling;
      expect(runtime.getSnapshot().turns[0]).toMatchObject({
        status: terminal,
        cancellation_status: "requested",
        remote_may_still_be_running: false,
      });
    });
  }

  it("settles cancellation bookkeeping when destroyed during a pending request", async () => {
    const transport = new TestTransport(() => new Promise(() => undefined));
    transport.starts.push(new ControlledObservation([started()]));
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Destroy", request });
    void sending.catch(() => undefined);
    const turnId = await activeTurnId(runtime);
    const cancelling = runtime.cancelTurn(turnId, "runtime_shutdown");
    await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));

    runtime.destroy();

    await expect(cancelling).rejects.toThrow("destroyed");
    await expect(sending).rejects.toThrow("destroyed");
  });
});
