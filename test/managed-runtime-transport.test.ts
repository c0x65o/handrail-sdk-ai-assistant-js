import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  type AuthoritativeAttribution,
  type ChatRequest,
  type StreamEvent,
} from "../src/protocol.js";
import * as browserEntry from "../src/browser/index.js";
import * as coreEntry from "../src/index.js";
import type { ConversationTurnId } from "../src/index.js";
import {
  MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
  ManagedRuntimeTurnStateStoreUnavailableError,
  createManagedRuntimeTransport,
  parseManagedRuntimeTurnStateRecord,
  type ManagedRuntimeFetch,
  type ManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateStore,
  type ManagedRuntimeUsageReceiptIdentityProvider,
  type ManagedRuntimeUsageReceiptInput,
} from "../src/server/managed.js";

const encoder = new TextEncoder();

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_managed", source: "server_derived", trust: "authoritative" },
  project: { id: "project_managed", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "env_managed",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: "user_managed", source: "server_derived", trust: "authoritative" },
  session: { id: "session_managed", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const request: ChatRequest = {
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [
    {
      name: "lookup_weather",
      description: "Look up weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
  tool_results: [],
  generation: { max_output_tokens: 64, temperature: 0.2 },
  correlation_hints: {},
};

const conversationTurnId = "turn_managed" as ConversationTurnId;

function envelope(type: StreamEvent["type"], sequence: number) {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "req_managed",
    trace_id: "trace_managed",
    sequence,
  } as const;
}

const started: StreamEvent = {
  ...envelope("response.started", 0),
  type: "response.started",
  attribution,
};

const completed: StreamEvent = {
  ...envelope("response.completed", 1),
  type: "response.completed",
  outcome: "stop",
};

function sseFrame(
  event: unknown,
  options: { eventName?: string; id?: string; newline?: "\n" | "\r\n"; multiline?: boolean } = {},
): string {
  const value = event as { type: string; request_id: string; sequence: number };
  const newline = options.newline ?? "\n";
  const json = options.multiline
    ? JSON.stringify(event, null, 2)
        .split("\n")
        .map((line) => `data: ${line}`)
        .join(newline)
    : `data: ${JSON.stringify(event)}`;
  return [
    `event: ${options.eventName ?? value.type}`,
    `id: ${options.id ?? `${value.request_id}:${value.sequence}`}`,
    json,
    "",
    "",
  ].join(newline);
}

function bytesStream(
  chunks: readonly Uint8Array[],
  options: { failAfter?: boolean; stayOpen?: boolean } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
        return;
      }
      if (options.failAfter) {
        controller.error(new Error("private network diagnostic"));
      } else if (!options.stayOpen) {
        controller.close();
      }
    },
  });
}

function streamResponse(
  source: string | readonly Uint8Array[],
  options: { failAfter?: boolean; stayOpen?: boolean } = {},
): Response {
  const chunks = typeof source === "string" ? [encoder.encode(source)] : source;
  return new Response(bytesStream(chunks, options), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function problemResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.handrail.dev/ai-runtime/errors/${code}`,
      title: "Safe title",
      status,
      category: "request",
      code,
      message: "Safe message",
      request_id: "req_problem",
      trace_id: "trace_problem",
      retryable: status === 429 || status >= 500,
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

function durableTurnState(
  overrides: Partial<ManagedRuntimeTurnStateRecord> = {},
): ManagedRuntimeTurnStateRecord {
  return {
    schemaVersion: MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
    conversationId: "conversation_managed",
    turnId: "req_managed",
    conversationTurnId,
    mutationId: "mutation_managed",
    request,
    serializedBody: JSON.stringify(request),
    idempotencyKey: "managed.key-1",
    ...overrides,
  };
}

function turnStateKey(conversationId: string, turnId: string): string {
  return `${conversationId.length}:${conversationId}${turnId}`;
}

class FakeManagedRuntimeTurnStateStore implements ManagedRuntimeTurnStateStore {
  readonly #records = new Map<string, ManagedRuntimeTurnStateRecord>();
  readonly #beforeSave:
    | ((record: ManagedRuntimeTurnStateRecord) => Promise<void>)
    | undefined;
  loadCalls = 0;
  saveCalls = 0;

  constructor(
    beforeSave?: (record: ManagedRuntimeTurnStateRecord) => Promise<void>,
  ) {
    this.#beforeSave = beforeSave;
  }

  async load(
    conversationId: string,
    turnId: string,
  ): Promise<ManagedRuntimeTurnStateRecord | null> {
    this.loadCalls += 1;
    const stored = this.#records.get(turnStateKey(conversationId, turnId));
    return stored === undefined
      ? null
      : parseManagedRuntimeTurnStateRecord(stored);
  }

  async save(
    value: ManagedRuntimeTurnStateRecord,
  ): Promise<ManagedRuntimeTurnStateRecord> {
    this.saveCalls += 1;
    const record = parseManagedRuntimeTurnStateRecord(value);
    await this.#beforeSave?.(record);
    this.#records.set(turnStateKey(record.conversationId, record.turnId), record);
    return parseManagedRuntimeTurnStateRecord(record);
  }
}

function transportFor(
  fetch: ManagedRuntimeFetch,
  timeoutMs = 2_000,
  createUsageReceiptIdentity: ManagedRuntimeUsageReceiptIdentityProvider = () => ({
    usage_receipt_id: "usage_managed",
    logical_request_id: "logical_managed",
    attempt: { id: "attempt_managed", index: 0 },
    continuation: { id: "continuation_managed", index: 0 },
    provider_id: "handrail-runtime",
    model_id: "runtime-selected-v1",
  }),
  turnStateStore?: ManagedRuntimeTurnStateStore,
) {
  return createManagedRuntimeTransport({
    baseUrl: "https://runtime.example.test/base/path",
    getHeaders: async () => ({ authorization: "Bearer managed-secret-token" }),
    fetch,
    timeoutMs,
    createUsageReceiptIdentity,
    ...(turnStateStore === undefined ? {} : { turnStateStore }),
  });
}

async function startTurn(transport: ReturnType<typeof transportFor>) {
  return transport.startTurn({
    conversationId: "conversation_managed",
    conversationTurnId,
    mutationId: "mutation_managed",
    idempotencyKey: "managed.key-1",
    request,
  });
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const output: StreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("ManagedRuntimeTransport", () => {
  it("is available only from the explicit trusted-server entry", () => {
    expect("createManagedRuntimeTransport" in coreEntry).toBe(false);
    expect("ManagedRuntimeTransport" in coreEntry).toBe(false);
    expect("createManagedRuntimeTransport" in browserEntry).toBe(false);
    expect("ManagedRuntimeTransport" in browserEntry).toBe(false);
  });

  it("does not project a second receipt when the managed gateway owns settlement", async () => {
    let identityCalls = 0;
    const managedStarted = { ...started, metadata: { usage_settlement_owner: "handrail" } };
    const usageEvent = { ...envelope("response.usage", 1), type: "response.usage" as const,
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
    const terminal = { ...envelope("response.completed", 2), type: "response.completed" as const, outcome: "stop" as const };
    const transport = transportFor(async () => streamResponse(sseFrame(managedStarted) + sseFrame(usageEvent) + sseFrame(terminal)),
      2_000, () => { identityCalls += 1; return { usage_receipt_id: "must-not-project", logical_request_id: "logical",
        attempt: { id: "attempt", index: 0 }, continuation: { id: "continuation", index: 0 }, provider_id: "runtime", model_id: "model" }; });
    const result = await startTurn(transport);
    expect(result.ok).toBe(true); if (!result.ok) return;
    await collect(result.value.observation.events);
    expect((await result.value.observation.result).usageReceipt).toBeNull();
    expect(identityCalls).toBe(0);
  });

  it("rejects document input before the managed runtime fetch boundary", async () => {
    let fetchCalls = 0;
    const transport = transportFor(async () => {
      fetchCalls += 1;
      return streamResponse(sseFrame(started) + sseFrame(completed));
    });
    const documentRequest: ChatRequest = {
      ...request,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              attachment: {
                attachment_id: "att_managed_pdf",
                content_ref: "ref_managed_pdf",
                media_type: "application/pdf",
                byte_size: 1_024,
              },
            },
          ],
        },
      ],
    };

    expect(transport.capabilities.documentInput).toEqual({ supported: false });
    await expect(
      transport.startTurn({
        conversationId: "conversation_managed",
        conversationTurnId,
        mutationId: "mutation_managed_document",
        idempotencyKey: "managed.document-1",
        request: documentRequest,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request", retryable: false },
    });
    expect(fetchCalls).toBe(0);
  });

  it("parses split UTF-8, CRLF, comments, multiline data, and multiple frames per chunk", async () => {
    const events: StreamEvent[] = [
      started,
      {
        ...envelope("response.text.delta", 1),
        type: "response.text.delta",
        delta: "Hello 🌍",
      },
      {
        ...envelope("response.tool_call", 2),
        type: "response.tool_call",
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      },
      {
        ...envelope("response.usage", 3),
        type: "response.usage",
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
      {
        ...envelope("response.usage", 4),
        type: "response.usage",
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
      {
        ...envelope("response.completed", 5),
        type: "response.completed",
        outcome: "tool_calls",
      },
    ];
    const wire =
      ": initial keepalive\r\n\r\n" +
      events
        .map((event, index) =>
          sseFrame(event, { newline: "\r\n", multiline: index === 0 || index === 3 }),
        )
        .join(": between frames\r\n\r\n");
    const bytes = encoder.encode(wire);
    const globeStart = wire.indexOf("🌍");
    const globeByte = encoder.encode(wire.slice(0, globeStart)).byteLength;
    const chunks = [
      bytes.slice(0, 7),
      bytes.slice(7, globeByte + 1),
      bytes.slice(globeByte + 1, globeByte + 3),
      bytes.slice(globeByte + 3),
    ];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const receiptInputs: ManagedRuntimeUsageReceiptInput[] = [];
    const transport = transportFor(
      async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return streamResponse(chunks);
      },
      2_000,
      (input) => {
        receiptInputs.push(input);
        return {
          usage_receipt_id: "usage_managed",
          logical_request_id: "logical_managed",
          attempt: { id: "attempt_managed", index: 0 },
          continuation: { id: "continuation_managed", index: 0 },
          provider_id: "handrail-runtime",
          model_id: "runtime-selected-v1",
        };
      },
    );

    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turnId).toBe("req_managed");
    expect(result.value.attribution).toEqual(attribution);
    expect(await collect(result.value.observation.events)).toEqual(events);
    expect(await result.value.observation.result).toMatchObject({
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      usageReceipt: {
        turn_id: conversationTurnId,
        source: "runtime",
        terminal_status: "completed",
        provider_cost: { status: "unavailable" },
        tokens: {
          input_tokens: { status: "reported", value: 10 },
          cached_input_tokens: { status: "unavailable" },
          output_tokens: { status: "reported", value: 4 },
          reasoning_tokens: { status: "unavailable" },
          total_tokens: { status: "reported", value: 14 },
        },
      },
    });
    expect(receiptInputs).toMatchObject([
      {
        conversationId: "conversation_managed",
        turnId: conversationTurnId,
        requestId: "req_managed",
      },
    ]);
    expect(calls[0]?.url).toBe(
      "https://runtime.example.test/api/ai-runtime/v1/chat",
    );
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe("text/event-stream");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toBe(
      "managed.key-1",
    );
  });

  it("keeps normalized usage optional when no receipt identity provider is configured", async () => {
    const usageEvent: StreamEvent = {
      ...envelope("response.usage", 1),
      type: "response.usage",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    };
    const terminal: StreamEvent = {
      ...envelope("response.completed", 2),
      type: "response.completed",
      outcome: "stop",
    };
    const transport = createManagedRuntimeTransport({
      baseUrl: "https://runtime.example.test/base/path",
      getHeaders: async () => ({ authorization: "Bearer managed-secret-token" }),
      fetch: async () =>
        streamResponse(
          sseFrame(started) + sseFrame(usageEvent) + sseFrame(terminal),
        ),
      timeoutMs: 2_000,
    });

    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await collect(result.value.observation.events);
    expect(await result.value.observation.result).toMatchObject({
      status: "completed",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      usageReceipt: null,
    });
  });

  it.each([
    ...(["explicit_stop", "policy_revoked", "deadline_exceeded", "runtime_shutdown"] as const).map(reason => ({
      terminal: { ...envelope("response.cancelled", 2), type: "response.cancelled" as const, reason }, status: "cancelled",
    })),
    {
      terminal: {
        ...envelope("response.error", 2),
        type: "response.error" as const,
        error: {
          category: "upstream" as const,
          code: "upstream_unavailable" as const,
          message: "The AI service is temporarily unavailable.",
          retryable: true,
        },
      },
      status: "failed",
    },
  ])("handles the $terminal.type terminal event", async ({ terminal, status }) => {
    const usageEvent: StreamEvent = {
      ...envelope("response.usage", 1),
      type: "response.usage",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    };
    const transport = transportFor(async () =>
      streamResponse(sseFrame(started) + sseFrame(usageEvent) + sseFrame(terminal)),
    );
    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await collect(result.value.observation.events)).at(-1)).toEqual(terminal);
    expect(await result.value.observation.result).toMatchObject({
      status,
      usageReceipt: { terminal_status: status },
    });
  });

  it("rejects malformed receipt identity at the validation boundary", async () => {
    const usageEvent: StreamEvent = {
      ...envelope("response.usage", 1),
      type: "response.usage",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    };
    const terminal: StreamEvent = {
      ...envelope("response.completed", 2),
      type: "response.completed",
      outcome: "stop",
    };
    const transport = createManagedRuntimeTransport({
      baseUrl: "https://runtime.example.test/base/path",
      getHeaders: async () => ({ authorization: "Bearer managed-secret-token" }),
      fetch: async () =>
        streamResponse(
          sseFrame(started) + sseFrame(usageEvent) + sseFrame(terminal),
        ),
      timeoutMs: 2_000,
      createUsageReceiptIdentity: () => ({
        usage_receipt_id: "usage_managed",
        logical_request_id: "logical_managed",
        attempt: { id: "attempt_managed", index: 0 },
        continuation: { id: "continuation_managed", index: 0 },
        provider_id: "provider native object",
        model_id: "runtime-selected-v1",
      }),
    });

    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await collect(result.value.observation.events)).map((event) => event.type)).toEqual([
      "response.started",
      "response.usage",
    ]);
    expect(await result.value.observation.result).toMatchObject({
      status: "failed",
      error: { code: "internal_error", retryable: false },
      usageReceipt: null,
    });
  });

  it.each([
    ["missing SSE id", "event: response.completed\ndata: {}\n\n"],
    ["malformed JSON", "event: response.completed\nid: req_managed:1\ndata: {\n\n"],
    ["event/type mismatch", sseFrame(completed, { eventName: "response.cancelled" })],
    ["event/id mismatch", sseFrame(completed, { id: "req_managed:99" })],
    [
      "sequence gap",
      sseFrame({ ...completed, sequence: 2 }, { id: "req_managed:2" }),
    ],
    [
      "sequence duplicate",
      sseFrame({ ...completed, sequence: 0 }, { id: "req_managed:0" }),
    ],
    ["duplicate started", sseFrame(started)],
    [
      "decreasing usage",
      sseFrame({
        ...envelope("response.usage", 1),
        type: "response.usage",
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
      }) +
        sseFrame({
          ...envelope("response.usage", 2),
          type: "response.usage",
          usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
        }),
    ],
    ["event after terminal", sseFrame(completed) + sseFrame({ ...completed, sequence: 2 })],
  ])("fails safely for %s", async (_name, invalidTail) => {
    const transport = transportFor(async () =>
      streamResponse(sseFrame(started) + invalidTail),
    );
    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await collect(result.value.observation.events);
    expect(await result.value.observation.result).toMatchObject({
      status: "failed",
      error: { code: "internal_error", retryable: false },
      usageReceipt: null,
    });
  });

  it("rejects a missing response.started before exposing a turn", async () => {
    const transport = transportFor(async () => streamResponse(sseFrame(completed)));
    await expect(startTurn(transport)).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
  });

  it("settles abrupt EOF without a terminal event as disconnected", async () => {
    const transport = transportFor(async () => streamResponse(sseFrame(started)));
    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await collect(result.value.observation.events)).toEqual([started]);
    expect(await result.value.observation.result).toMatchObject({
      status: "disconnected",
      usageReceipt: null,
    });
  });

  it("maps bounded valid problem responses without returning their bodies", async () => {
    const cases = [
      [409, "idempotency_conflict", "conflict"],
      [401, "unauthenticated", "unauthenticated"],
      [403, "forbidden", "forbidden"],
      [429, "rate_limited", "rate_limited"],
      [503, "upstream_unavailable", "unavailable"],
    ] as const;
    for (const [status, problemCode, transportCode] of cases) {
      const transport = transportFor(async () => problemResponse(status, problemCode));
      const result = await startTurn(transport);
      expect(result).toMatchObject({ ok: false, error: { code: transportCode } });
      expect(JSON.stringify(result)).not.toContain("Safe message");
    }
  });

  it("rejects malformed or unbounded problem responses safely", async () => {
    for (const response of [
      new Response("not json", {
        status: 400,
        headers: { "content-type": "application/problem+json" },
      }),
      new Response("x".repeat(65_537), {
        status: 400,
        headers: { "content-type": "application/problem+json" },
      }),
      new Response("{}", { status: 400, headers: { "content-type": "text/plain" } }),
    ]) {
      const transport = transportFor(async () => response);
      await expect(startTurn(transport)).resolves.toMatchObject({
        ok: false,
        error: { code: "internal_error" },
      });
    }
  });

  it("times out bounded request setup and maps a broken stream as unavailable", async () => {
    const timeoutTransport = transportFor(
      () => new Promise<Response>(() => undefined),
      100,
    );
    await expect(startTurn(timeoutTransport)).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
    });

    const brokenTransport = transportFor(async () =>
      streamResponse(sseFrame(started), { failAfter: true }),
    );
    const result = await startTurn(brokenTransport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await collect(result.value.observation.events);
    expect(await result.value.observation.result).toMatchObject({
      status: "failed",
      error: { code: "unavailable", retryable: true },
    });
  });

  it("disconnects only the local observation and advertises unsupported capabilities", async () => {
    let signal: AbortSignal | undefined;
    const transport = transportFor(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return streamResponse(sseFrame(started), { stayOpen: true });
    });
    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const iterator = result.value.observation.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(started);
    result.value.observation.disconnect();
    expect(await result.value.observation.result).toMatchObject({
      status: "disconnected",
    });
    expect(signal?.aborted).toBe(true);
    expect(transport.capabilities).toEqual({
      authoritativeCancellation: { supported: false },
      documentInput: { supported: false },
      attachmentUpload: { supported: false },
      presence: { supported: false },
      synchronization: { supported: false },
    });
  });

  it("never emits or returns supplied token and header material", async () => {
    const token = "Bearer managed-secret-token";
    const leaked = {
      ...envelope("response.error", 1),
      type: "response.error" as const,
      error: {
        category: "internal" as const,
        code: "internal_error" as const,
        message: token,
        retryable: false,
      },
    };
    const transport = transportFor(async () =>
      streamResponse(sseFrame(started) + sseFrame(leaked)),
    );
    const result = await startTurn(transport);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const events = await collect(result.value.observation.events);
    const observationResult = await result.value.observation.result;
    expect(events).toEqual([started]);
    expect(JSON.stringify({ events, observationResult })).not.toContain(token);
    expect(observationResult).toMatchObject({
      status: "failed",
      error: { code: "internal_error" },
    });
  });

  it("replays the byte-identical snapshot and key while suppressing applied frames", async () => {
    const replayEvents: StreamEvent[] = [
      started,
      {
        ...envelope("response.text.delta", 1),
        type: "response.text.delta",
        delta: "persisted",
      },
      {
        ...envelope("response.usage", 2),
        type: "response.usage",
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      },
      {
        ...envelope("response.completed", 3),
        type: "response.completed",
        outcome: "stop",
      },
    ];
    const calls: RequestInit[] = [];
    const transport = transportFor(async (_url, init = {}) => {
      calls.push(init);
      return streamResponse(replayEvents.map((event) => sseFrame(event)).join(""));
    });
    const first = await startTurn(transport);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.turnId).toBe("req_managed");
    await collect(first.value.observation.events);
    await first.value.observation.result;

    const resumed = await transport.resumeTurn({
      conversationId: first.value.conversationId,
      turnId: "req_managed",
      resumeFrom: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: "req_managed:1",
        lastAppliedRevision: 6,
      },
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect((await collect(resumed.value.events)).map((event) => event.sequence)).toEqual([
      2, 3,
    ]);
    expect((await resumed.value.result).status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(typeof calls[0]?.body).toBe("string");
    expect(new Headers(calls[0]?.headers).get("idempotency-key")).toBe(
      new Headers(calls[1]?.headers).get("idempotency-key"),
    );
  });

  it("persists before exposing a handle and restores it in a second transport", async () => {
    const replayEvents: StreamEvent[] = [
      started,
      {
        ...envelope("response.text.delta", 1),
        type: "response.text.delta",
        delta: "persisted",
      },
      { ...completed, sequence: 2 },
    ];
    const calls: RequestInit[] = [];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let reportSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      reportSaveStarted = resolve;
    });
    let saveCompleted = false;
    const store = new FakeManagedRuntimeTurnStateStore(async () => {
      reportSaveStarted();
      await saveGate;
      saveCompleted = true;
    });
    const fetch: ManagedRuntimeFetch = async (_url, init = {}) => {
      calls.push(init);
      return streamResponse(replayEvents.map((event) => sseFrame(event)).join(""));
    };
    const firstTransport = transportFor(fetch, 2_000, undefined, store);
    let startSettled = false;
    const pendingStart = startTurn(firstTransport).finally(() => {
      startSettled = true;
    });

    await saveStarted;
    await Promise.resolve();
    expect(startSettled).toBe(false);
    releaseSave();
    const first = await pendingStart;
    expect(first.ok).toBe(true);
    expect(saveCompleted).toBe(true);
    expect(store.saveCalls).toBe(1);
    if (!first.ok) return;
    await collect(first.value.observation.events);
    await first.value.observation.result;

    const secondTransport = transportFor(fetch, 2_000, undefined, store);
    const resumed = await secondTransport.resumeTurn({
      conversationId: first.value.conversationId,
      turnId: first.value.turnId,
      resumeFrom: {
        lastAppliedEventId: "req_managed:0",
        lastAppliedCursor: "req_managed:0",
        lastAppliedRevision: 0,
      },
    });
    expect(resumed.ok).toBe(true);
    expect(store.loadCalls).toBe(1);
    if (!resumed.ok) return;
    expect((await collect(resumed.value.events)).map((event) => event.sequence)).toEqual([
      1, 2,
    ]);
    expect((await resumed.value.result).status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(typeof calls[0]?.body).toBe("string");
    expect(new Headers(calls[0]?.headers).get("idempotency-key")).toBe(
      new Headers(calls[1]?.headers).get("idempotency-key"),
    );
  });

  it("aborts an opened stream and bounds persistence save failures", async () => {
    const secret = "private durable store diagnostic";
    let signal: AbortSignal | undefined;
    let saveCalls = 0;
    const store: ManagedRuntimeTurnStateStore = {
      async load() {
        return null;
      },
      async save() {
        saveCalls += 1;
        throw new ManagedRuntimeTurnStateStoreUnavailableError(
          "save",
          secret,
          false,
        );
      },
    };
    const transport = transportFor(
      async (_url, init) => {
        signal = init?.signal ?? undefined;
        return streamResponse(sseFrame(started), { stayOpen: true });
      },
      2_000,
      undefined,
      store,
    );

    const result = await startTurn(transport);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(saveCalls).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    {
      name: "missing",
      load: async () => null,
      error: { code: "not_found", retryable: false },
    },
    {
      name: "malformed",
      load: async () =>
        ({ malformed: "private malformed record contents" }) as unknown as ManagedRuntimeTurnStateRecord,
      error: { code: "internal_error", retryable: false },
    },
    {
      name: "identity-mismatched",
      load: async () =>
        durableTurnState({ conversationId: "private mismatched conversation" }),
      error: { code: "internal_error", retryable: false },
    },
    {
      name: "retryable unavailable",
      load: async () => {
        throw new ManagedRuntimeTurnStateStoreUnavailableError(
          "load",
          "private retryable store diagnostic",
          true,
        );
      },
      error: { code: "unavailable", retryable: true },
    },
    {
      name: "non-retryable unavailable",
      load: async () => {
        throw new ManagedRuntimeTurnStateStoreUnavailableError(
          "load",
          "private non-retryable store diagnostic",
          false,
        );
      },
      error: { code: "unavailable", retryable: false },
    },
  ])("fails once with a bounded error for $name durable state", async ({ load, error }) => {
    let loadCalls = 0;
    let fetchCalls = 0;
    const store: ManagedRuntimeTurnStateStore = {
      async load(conversationId, turnId) {
        loadCalls += 1;
        expect([conversationId, turnId]).toEqual([
          "conversation_managed",
          "req_managed",
        ]);
        return load();
      },
      async save(value) {
        return value;
      },
    };
    const transport = transportFor(
      async () => {
        fetchCalls += 1;
        return streamResponse(sseFrame(started) + sseFrame(completed));
      },
      2_000,
      undefined,
      store,
    );

    const result = await transport.resumeTurn({
      conversationId: "conversation_managed",
      turnId: "req_managed",
      resumeFrom: {
        lastAppliedEventId: null,
        lastAppliedCursor: null,
        lastAppliedRevision: null,
      },
    });
    expect(result).toMatchObject({ ok: false, error });
    expect(loadCalls).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private");
    if (!result.ok) expect(result.error.message.length).toBeLessThanOrEqual(128);
  });

  it("validates requests, idempotency keys, and resume checkpoints before POST", async () => {
    let calls = 0;
    const transport = transportFor(async () => {
      calls += 1;
      return streamResponse(sseFrame(started) + sseFrame(completed));
    });
    const invalidKey = await transport.startTurn({
      conversationId: "conversation_managed",
      conversationTurnId,
      mutationId: "mutation_managed",
      idempotencyKey: "contains a space",
      request,
    });
    expect(invalidKey).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toBe(0);

    const first = await startTurn(transport);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await collect(first.value.observation.events);
    await first.value.observation.result;
    const resumed = await transport.resumeTurn({
      conversationId: first.value.conversationId,
      turnId: first.value.turnId,
      resumeFrom: {
        lastAppliedEventId: "other_turn:0",
        lastAppliedCursor: "req_managed:0",
        lastAppliedRevision: 0,
      },
    });
    expect(resumed).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toBe(1);
  });

  it.each([
    {
      name: "disagreeing managed sequences",
      checkpoint: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: "req_managed:2",
        lastAppliedRevision: 6,
      },
    },
    {
      name: "an event ID owned by another request",
      checkpoint: {
        lastAppliedEventId: "other_turn:1",
        lastAppliedCursor: "req_managed:1",
        lastAppliedRevision: 6,
      },
    },
    {
      name: "a cursor owned by another request",
      checkpoint: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: "other_turn:1",
        lastAppliedRevision: 6,
      },
    },
    {
      name: "a missing managed event ID",
      checkpoint: {
        lastAppliedEventId: null,
        lastAppliedCursor: "req_managed:1",
        lastAppliedRevision: 6,
      },
    },
    {
      name: "a missing managed cursor",
      checkpoint: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: null,
        lastAppliedRevision: 6,
      },
    },
    {
      name: "a malformed managed cursor",
      checkpoint: {
        lastAppliedEventId: "req_managed:0",
        lastAppliedCursor: "req_managed:",
        lastAppliedRevision: 0,
      },
    },
    {
      name: "a negative durable revision",
      checkpoint: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: "req_managed:1",
        lastAppliedRevision: -1,
      },
    },
    {
      name: "a fractional durable revision",
      checkpoint: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: "req_managed:1",
        lastAppliedRevision: 1.5,
      },
    },
    {
      name: "an unsafe durable revision",
      checkpoint: {
        lastAppliedEventId: "req_managed:1",
        lastAppliedCursor: "req_managed:1",
        lastAppliedRevision: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ])("rejects $name before POST", async ({ checkpoint }) => {
    let calls = 0;
    const store: ManagedRuntimeTurnStateStore = {
      async load() {
        return durableTurnState();
      },
      async save(value) {
        return value;
      },
    };
    const transport = transportFor(
      async () => {
        calls += 1;
        return streamResponse(sseFrame(started) + sseFrame(completed));
      },
      2_000,
      undefined,
      store,
    );

    const resumed = await transport.resumeTurn({
      conversationId: "conversation_managed",
      turnId: "req_managed",
      resumeFrom: checkpoint,
    });

    expect(resumed).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(calls).toBe(0);
  });
});
