import { describe, expect, it, vi } from "vitest";
import { createApplicationGatewayDisplayHistory } from "../src/transports/application-gateway.js";
import {
  ApprovalProposalStoreError,
  ConversationCatalogError,
  createApplicationGateway,
  createApplicationGatewayConversationCatalog,
  createApplicationGatewayTransport,
  createApplicationGatewayResourceClient,
  negotiateApplicationGatewayCapabilities,
  type ConversationTransport,
  type TurnObservation,
  type TurnResumePoint,
} from "../src/index.js";

type Event = { id: string; revision: number; text: string };

function observation(events: Event[]): TurnObservation<Event> {
  const checkpoint = events.length === 0 ? { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null }
    : point(events.at(-1)!);
  return {
    events: (async function* () { for (const event of events) yield event; })(),
    result: Promise.resolve({ status: "completed", checkpoint }),
    disconnect() {},
  };
}

function point(event: Event): TurnResumePoint {
  return { lastAppliedEventId: event.id, lastAppliedCursor: `cursor:${event.id}`, lastAppliedRevision: event.revision };
}

describe("application-owned gateway transport", () => {
  it("keeps a quiet turn stream alive while the provider is working", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gateway = createApplicationGateway<Event, { prompt: string }, { principalId: string }>({
      transport: {
        capabilities: {
          authoritativeCancellation: { supported: false },
          documentInput: { supported: false }, attachmentUpload: { supported: false },
          presence: { supported: false }, synchronization: { supported: false },
        },
        async startTurn(input) {
          return { ok: true as const, value: {
            conversationId: input.conversationId,
            turnId: input.conversationTurnId,
            mutationId: input.mutationId,
            observation: {
              events: {
                [Symbol.asyncIterator]() {
                  return {
                    async next() {
                      await pending;
                      return { done: true as const, value: undefined };
                    },
                  };
                },
              },
              result: pending.then(() => ({
                status: "completed" as const,
                checkpoint: {
                  lastAppliedEventId: null,
                  lastAppliedCursor: null,
                  lastAppliedRevision: null,
                },
              })),
              disconnect: release,
            },
          } };
        },
        async resumeTurn() { return { ok: true as const, value: observation([]) }; },
      },
      authorize: async () => ({ principalId: "user-1" }),
      checkpointForEvent: point,
    });

    try {
      const response = await gateway.handle(new Request("https://app.test/ai/turns/start", {
        method: "POST",
        body: JSON.stringify({
          conversationId: "conversation-1",
          conversationTurnId: "turn-1",
          mutationId: "mutation-1",
          idempotencyKey: "start-1",
          request: { prompt: "hello" },
        }),
      }));
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: started");

      const heartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(new TextDecoder().decode((await heartbeat).value)).toBe(": keepalive\n\n");
      await reader.cancel();
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("diagnoses network failures from typed resource calls", async () => {
    const diagnostics: import("../src/index.js").AiDiagnosticEvent[] = [];
    const failure = new Error("network unavailable");
    const client = createApplicationGatewayResourceClient({ baseUrl: "https://app.test/ai",
      fetch: vi.fn(async () => { throw failure; }), diagnostics: (event) => diagnostics.push(event) });
    await expect(client.getConversation({ conversationId: "conversation-1" } as never)).rejects.toBe(failure);
    expect(diagnostics).toEqual([
      expect.objectContaining({ operation: "/conversations/get", phase: "started" }),
      expect.objectContaining({ operation: "/conversations/get", phase: "failed", retryable: true,
        durationMs: expect.any(Number), cause: failure }),
    ]);
  });

  it("injects server authorization into typed conversation resources", async () => {
    const create = vi.fn(async (input: { authorizationContext: { companyId: string }; title?: string }) => ({
      operation: "create" as const, status: "created" as const,
      descriptor: { conversationId: "conversation-1", title: input.title ?? null,
        createdAt: "2026-08-30T12:00:00.000Z", updatedAt: "2026-08-30T12:00:00.000Z", version: 1,
        metadata: { company: input.authorizationContext.companyId }, lifecycle: "active" as const, archivedAt: null },
    }));
    const gateway = createApplicationGateway({
      transport: { capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } } } as ConversationTransport<Event>,
      authorize: async () => ({ principalId: "user-1", companyId: "company-authoritative" }), checkpointForEvent: point,
      conversations: { create, capabilities: {} } as never,
    });
    const fetch = (input: string | URL | Request, init?: RequestInit) => gateway.handle(new Request(input, init));
    const client = createApplicationGatewayResourceClient({ baseUrl: "https://app.test/ai", fetch });
    await expect(client.createConversation({ title: "Aegis", idempotencyKey: "create-1" as never }))
      .resolves.toMatchObject({ descriptor: { metadata: { company: "company-authoritative" } } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ authorizationContext: expect.objectContaining({ companyId: "company-authoritative" }) }));

    const malicious = await gateway.handle(new Request("https://app.test/ai/conversations/create", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Bad", idempotencyKey: "create-2",
        authorizationContext: { companyId: "company-attacker" } }) }));
    expect(malicious.status).toBe(200);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ authorizationContext: expect.objectContaining({ companyId: "company-authoritative" }) }));
  });

  it("binds turn transports to the authoritative actor instead of request identity", async () => {
    const resolved: string[] = [];
    const startedFor: Array<{ companyId: string; request: unknown }> = [];
    const gateway = createApplicationGateway<Event, { prompt: string; companyId?: string }, {
      principalId: string;
      companyId: string;
    }>({
      transportFor: async (context) => {
        resolved.push(`${context.companyId}:${context.principalId}`);
        return {
          capabilities: {
            authoritativeCancellation: { supported: false },
            documentInput: { supported: false }, attachmentUpload: { supported: false },
            presence: { supported: false }, synchronization: { supported: false },
          },
          async startTurn(input) {
            startedFor.push({ companyId: context.companyId, request: input.request });
            return { ok: true as const, value: {
              conversationId: input.conversationId, turnId: "server-turn", mutationId: input.mutationId,
              observation: observation([]),
            } };
          },
          async resumeTurn() { return { ok: true as const, value: observation([]) }; },
        };
      },
      authorize: async () => ({ principalId: "user-1", companyId: "company-authoritative" }),
      checkpointForEvent: point,
    });
    const response = await gateway.handle(new Request("https://app.test/ai/turns/start", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conversation-1", conversationTurnId: "client-turn",
        mutationId: "mutation-1", idempotencyKey: "start-1",
        request: { prompt: "hello", companyId: "company-attacker" },
      }),
    }));

    expect(response.status).toBe(200);
    expect(resolved).toEqual(["company-authoritative:user-1"]);
    expect(startedFor).toEqual([{
      companyId: "company-authoritative",
      request: { prompt: "hello", companyId: "company-attacker" },
    }]);
  });

  it("adapts gateway conversation resources directly to the picker catalog contract", async () => {
    const capabilities = {
      rename: { supported: true as const }, clear: { supported: true as const },
      archive: { supported: true as const }, restore: { supported: true as const },
      permanentDelete: { supported: false as const, reason: "policy_disabled" as const },
    };
    const listConversations = vi.fn(async () => ({
      items: [], nextCursor: null, hasMore: false,
      order: { field: "updated_at" as const, direction: "desc" as const },
    }));
    const catalog = createApplicationGatewayConversationCatalog({
      listConversations,
      createConversation: vi.fn(), getConversation: vi.fn(), renameConversation: vi.fn(),
      clearConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(),
      permanentlyDeleteConversation: vi.fn(), createApproval: vi.fn(), getApproval: vi.fn(),
      listApprovalGroup: vi.fn(), transitionApproval: vi.fn(), generateTitle: vi.fn(),
      pullSnapshot: vi.fn(), readSince: vi.fn(), appendMutations: vi.fn(),
    }, {
      protocolVersion: "handrail.application-gateway.v1", authoritativeCancellation: false,
      attachments: false, presence: false, synchronization: false,
      resources: { conversations: capabilities, approvals: false, titleGeneration: false },
    });

    expect(catalog.capabilities).toEqual(capabilities);
    await expect(catalog.list({
      authorizationContext: { untrusted: true }, lifecycle: "active", pageSize: 20,
      order: { field: "updated_at", direction: "desc" },
    })).resolves.toMatchObject({ items: [] });
    expect(listConversations).toHaveBeenCalledWith(expect.not.objectContaining({
      authorizationContext: expect.anything(),
    }));
  });

  it("negotiates capabilities, streams events, resumes, and cancels authoritatively", async () => {
    const diagnostics: import("../src/index.js").AiDiagnosticEvent[] = [];
    const cancelTurn = vi.fn(async () => ({ ok: true as const, value: { status: "cancellation_requested" as const } }));
    const serverTransport: ConversationTransport<Event, { prompt: string }> = {
      capabilities: {
        authoritativeCancellation: { supported: true, capability: { cancelTurn } },
        documentInput: { supported: false }, attachmentUpload: { supported: false },
        presence: { supported: false }, synchronization: { supported: false },
      },
      async startTurn(input) {
        return { ok: true, value: { conversationId: input.conversationId, turnId: "server-turn", mutationId: input.mutationId,
          observation: observation([{ id: "e1", revision: 1, text: "hello" }]) } };
      },
      async resumeTurn() { return { ok: true, value: observation([{ id: "e2", revision: 2, text: "again" }]) }; },
    };
    const gateway = createApplicationGateway({
      transport: serverTransport,
      authorize: async (request) => {
        if (request.headers.get("authorization") !== "Bearer app") throw new Error("no");
        return { principalId: "user-1" };
      },
      checkpointForEvent: point,
      capabilities: { attachments: { maximumFiles: 3, maximumBytesPerFile: 1000, acceptedMediaTypes: ["image/png"], uploadUrl: "/uploads" }, presence: true, synchronization: true },
      diagnostics: (event) => diagnostics.push(event),
    });
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/uploads") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: {
        attachment_id: "attachment-1", content_ref: "app:attachment-1", media_type: "image/png", byte_size: 3, filename: "a.png",
      } }), { headers: { "content-type": "application/json" } }));
      return gateway.handle(request);
    };
    const protectedRequest = (input: RequestInit & { url: string }) => ({ ...input, headers: { ...input.headers, authorization: "Bearer app" } });
    const capabilities = await negotiateApplicationGatewayCapabilities({ baseUrl: "https://app.test/ai", fetch,
      protectedRequest, diagnostics: (event) => diagnostics.push(event) });
    expect(capabilities.attachments).toMatchObject({ maximumFiles: 3 });
    const synchronization = { kind: "application-sync" };
    const client = createApplicationGatewayTransport<Event, { prompt: string }, typeof synchronization>({
      baseUrl: "https://app.test/ai", fetch, protectedRequest, capabilities, synchronization,
      diagnostics: (event) => diagnostics.push(event),
    });
    expect(client.capabilities.presence.supported).toBe(true);
    expect(client.capabilities.synchronization).toEqual({ supported: true, capability: synchronization });
    const started = await client.startTurn({ conversationId: "c1", conversationTurnId: "client-turn" as never, mutationId: "m1", idempotencyKey: "i1", request: { prompt: "hi" } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.turnId).toBe("server-turn");
    const received: Event[] = [];
    for await (const event of started.value.observation.events) received.push(event);
    expect(received).toEqual([{ id: "e1", revision: 1, text: "hello" }]);
    await expect(started.value.observation.result).resolves.toMatchObject({ status: "completed", checkpoint: { lastAppliedEventId: "e1" } });
    const resumed = await client.resumeTurn({ conversationId: "c1", turnId: "server-turn", resumeFrom: point(received[0]!) });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) { const values = []; for await (const event of resumed.value.events) values.push(event); expect(values).toHaveLength(1); }
    const cancellation = client.capabilities.authoritativeCancellation;
    expect(cancellation.supported).toBe(true);
    if (cancellation.supported) await cancellation.capability.cancelTurn({ conversationId: "c1", turnId: "server-turn", mutationId: "m2", idempotencyKey: "i2", reason: "user_requested" as never });
    expect(cancelTurn).toHaveBeenCalledOnce();
    const uploads = client.capabilities.attachmentUpload;
    expect(uploads.supported).toBe(true);
    if (uploads.supported) await expect(uploads.capability.upload({
      source: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      metadata: { mediaType: "image/png", byteSize: 3, filename: "a.png" }, idempotencyKey: "upload-1",
      signal: new AbortController().signal, onProgress() {},
    })).resolves.toMatchObject({ attachment_id: "attachment-1" });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "capabilities", phase: "succeeded" }),
      expect.objectContaining({ operation: "start", phase: "succeeded", conversationId: "c1" }),
      expect.objectContaining({ operation: "resume", phase: "succeeded", conversationId: "c1" }),
      expect.objectContaining({ operation: "cancel", phase: "succeeded", conversationId: "c1" }),
    ]));
  });

  it("does not expose arbitrary authorization failures", async () => {
    const gateway = createApplicationGateway<Event, unknown, { principalId: string }>({
      transport: { capabilities: {
        authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
      } } as ConversationTransport<Event>, authorize: async () => { throw new Error("secret"); }, checkpointForEvent: point,
    });
    const response = await gateway.handle(new Request("https://app.test/ai/capabilities"));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("secret");
  });

  it("reports unexpected transport failures as retryable unavailability", async () => {
    const gateway = createApplicationGateway<Event, unknown, { principalId: string }>({
      transport: {
        capabilities: {
          authoritativeCancellation: { supported: false },
          documentInput: { supported: false },
          attachmentUpload: { supported: false },
          presence: { supported: false },
          synchronization: { supported: false },
        },
        async startTurn() {
          throw new Error("private database failure");
        },
        async resumeTurn() {
          throw new Error("private database failure");
        },
      },
      authorize: async () => ({ principalId: "server-user" }),
      checkpointForEvent: point,
    });
    const response = await gateway.handle(new Request("https://app.test/ai/turns/start", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conversation-1",
        conversationTurnId: "turn-1",
        mutationId: "mutation-1",
        idempotencyKey: "start-1",
        request: {},
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "unavailable",
        message: "The application gateway is temporarily unavailable.",
        retryable: true,
      },
    });
  });

  it("preserves normalized resource error semantics without exposing native failures", async () => {
    const gateway = createApplicationGateway({
      transport: { capabilities: {
        authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
      } } as ConversationTransport<Event>,
      authorize: async () => ({ principalId: "server-user" }),
      checkpointForEvent: point,
      conversations: {
        create: async () => { throw new ConversationCatalogError("idempotency_conflict", "create"); },
      } as never,
      approvals: {
        transition: async () => { throw new ApprovalProposalStoreError("version_conflict", "transition"); },
      } as never,
    });
    const conversation = await gateway.handle(new Request("https://app.test/ai/conversations/create", {
      method: "POST", body: "{}",
    }));
    expect(conversation.status).toBe(409);
    await expect(conversation.json()).resolves.toMatchObject({ ok: false, error: { code: "conflict", retryable: false },
      resourceError: { domain: "conversation_catalog", code: "idempotency_conflict" } });
    const approval = await gateway.handle(new Request("https://app.test/ai/approvals/transition", {
      method: "POST", body: "{}",
    }));
    expect(approval.status).toBe(409);
    await expect(approval.json()).resolves.toMatchObject({ ok: false, error: { code: "conflict", retryable: true } });
  });

  it("routes approvals, title generation, and synchronization through authoritative context", async () => {
    const createApproval = vi.fn(async (input: { permissionContext: { principalId: string } }) => ({
      proposal_id: "proposal-1",
      authorized_by: input.permissionContext.principalId,
    }));
    const transitionApproval = vi.fn(async (input: { permissionContext: { principalId: string }; status: string }) => ({
      proposal_id: "proposal-1",
      status: input.status,
      authorized_by: input.permissionContext.principalId,
    }));
    const generate = vi.fn(async (_input: unknown, context: { principalId: string }) => `Title for ${context.principalId}`);
    const synchronization = vi.fn(async (request: Request, context: { principalId: string }) => {
      const value = await request.json() as { operation: string; input: unknown };
      return new Response(JSON.stringify({ ok: true, value: { operation: value.operation, principalId: context.principalId } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const gateway = createApplicationGateway({
      transport: { capabilities: {
        authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
      } } as ConversationTransport<Event>,
      authorize: async () => ({ principalId: "server-user" }),
      checkpointForEvent: point,
      approvals: {
        create: createApproval,
        get: vi.fn(async () => null),
        listGroup: vi.fn(async () => []),
        transition: transitionApproval,
      } as never,
      titleGeneration: { generate },
      capabilities: { synchronization: true },
      handlers: { synchronization },
    });
    const fetch = (input: string | URL | Request, init?: RequestInit) => gateway.handle(new Request(input, init));
    const client = createApplicationGatewayResourceClient({ baseUrl: "https://app.test/ai", fetch });

    await expect(client.createApproval({ proposalId: "proposal-1" } as never))
      .resolves.toMatchObject({ authorized_by: "server-user" });
    await expect(client.transitionApproval({ proposalId: "proposal-1", status: "confirmed" } as never))
      .resolves.toMatchObject({ status: "confirmed", authorized_by: "server-user" });
    await expect(client.generateTitle({ conversationId: "conversation-1", idempotencyKey: "title-1" }))
      .resolves.toBe("Title for server-user");
    await expect(client.pullSnapshot({ conversationId: "conversation-1" } as never))
      .resolves.toMatchObject({ operation: "pull_snapshot", principalId: "server-user" });
    await expect(client.readSince({ conversationId: "conversation-1" } as never))
      .resolves.toMatchObject({ operation: "read_since" });
    await expect(client.appendMutations({ conversationId: "conversation-1" } as never))
      .resolves.toMatchObject({ operation: "append_mutations" });
    expect(createApproval).toHaveBeenCalledWith(expect.objectContaining({
      permissionContext: { principalId: "server-user" },
    }));
    expect(synchronization).toHaveBeenCalledTimes(3);
  });
});

it.each([401, 403, 429])("normalizes plain HTTP %s and Retry-After for starts and reads", async status => {
  const fetch = vi.fn(async () => new Response("not JSON", { status, headers: { "Retry-After": "17" } }));
  const transport = createApplicationGatewayTransport({ baseUrl: "https://app.test", fetch });
  const result = await transport.startTurn({ conversationId: "chat", conversationTurnId: "turn" as never,
    mutationId: "message", idempotencyKey: "start", request: {} });
  const expected = { code: status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "rate_limited",
    retryable: status === 429, retryAfterMs: 17_000 };
  expect(result).toMatchObject({ ok: false, error: expected });
  const resources = createApplicationGatewayResourceClient({ baseUrl: "https://app.test", fetch });
  await expect(resources.listActivity!()).rejects.toMatchObject({ transportCode: expected.code,
    retryable: expected.retryable, retryAfterMs: expected.retryAfterMs });
  const history = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test", fetch });
  await expect(history.control({ conversationId: "chat" })).rejects.toMatchObject({ transportCode: expected.code,
    retryable: expected.retryable, retryAfterMs: expected.retryAfterMs });
});
