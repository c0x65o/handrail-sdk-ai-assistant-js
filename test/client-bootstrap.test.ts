import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDBApplicationConversationPendingStore } from "../src/browser/indexeddb-pending-store.js";
import { ConversationLocalErasureError } from "../src/conversation/catalog.js";
import { InMemoryConversationLocalStateStore } from "../src/client/local-state.js";
import { prepareApplicationConversationSubmission } from "../src/client/session-submission.js";

import {
  APPLICATION_GATEWAY_PROTOCOL_VERSION,
  createHandrailAiClient,
  InMemoryConversationEventStore,
  type ApplicationGatewayCapabilities,
} from "../src/client/index.js";
import { parseConversationEvent, type AttachmentUploadAdapter, type ConversationCatalog } from "../src/index.js";

const capabilities: ApplicationGatewayCapabilities = Object.freeze({
  protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION,
  authoritativeCancellation: false,
  attachments: false,
  presence: false,
  activity: false,
  synchronization: false,
  resources: Object.freeze({
    conversations: false,
    approvals: false,
    titleGeneration: false,
  }),
});

describe("createHandrailAiClient", () => {
  it("owns custom authorized upload adapters and inferred durable files independently of UI runtimes", async () => {
    const storage = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
    const attachmentUploadAdapter: AttachmentUploadAdapter<Blob> = { upload: vi.fn(async request => {
      const saved = await storage.readAttachmentDraft(request.metadata.conversationId!);
      expect(saved?.files[0]?.selection.idempotencyKey).toBe(request.idempotencyKey);
      return { attachment_id: "att_custom", content_ref: "ref_custom", media_type: request.metadata.mediaType,
        byte_size: request.metadata.byteSize, ...(request.metadata.filename ? { filename: request.metadata.filename } : {}) };
    }) };
    const options = { baseUrl: "https://app.test/ai", capabilities, pendingStore: storage, attachmentUploadAdapter };
    const first = await createHandrailAiClient(options);
    try {
      expect(first.attachmentUpload).toBe(attachmentUploadAdapter);
      const draft = first.attachmentDrafts.forConversation("chat"); await draft.flush();
      draft.add([{ source: new Blob(["pdf"]), kind: "document", byteSize: 3, mediaType: "application/pdf",
        filename: "local.pdf", fingerprint: "selected", idempotencyKey: "selection" }]);
      await vi.waitFor(() => expect(draft.getSnapshot().files[0]?.reference).toBeDefined());
      await first.dispose();
      const second = await createHandrailAiClient(options);
      try {
        const restored = second.attachmentDrafts.forConversation("chat"); await restored.flush();
        expect(restored.uploader.getSnapshot().items[0]?.status).toBe("ready");
        expect(attachmentUploadAdapter.upload).toHaveBeenCalledTimes(1);
      } finally { await second.dispose(); }
    } finally { await first.dispose(); storage.close(); }
  });

  it("erases device state only after matching confirmed deletion and retries cleanup without another network mutation", async () => {
    const storage = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
    await storage.writeDraft("chat", "private draft", null);
    await storage.writePosition("chat", { messageId: "m", generation: 0, offset: 5, following: false });
    await storage.retain(prepareApplicationConversationSubmission({ conversationId: "chat" as never, clientId: "c" as never,
      revision: 0, operationId: "one", now: "2026-09-17T00:00:00.000Z", input: { content: "question", request: {} } }));
    const erase = vi.spyOn(storage, "eraseConversation");
    let response: Response = Response.json({ ok: false, error: { code: "forbidden", message: "Forbidden", retryable: false } }, { status: 403 });
    const fetcher = vi.fn<typeof fetch>(async () => response.clone());
    const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", fetch: fetcher,
      capabilities: { ...capabilities, resources: { conversations: true, approvals: false, titleGeneration: false } }, pendingStore: storage });
    const input = { authorizationContext: undefined, conversationId: "chat" as never, expectedVersion: 1 as never, idempotencyKey: "delete-chat" as never };
    try {
      await expect(client.catalog.permanentlyDelete(input)).rejects.toMatchObject({ code: "forbidden" });
      expect(erase).not.toHaveBeenCalled();
      const deleted = { operation: "permanent_delete", status: "deleted", conversationId: "chat", deletedVersion: 1 };
      response = Response.json({ ok: true, value: { ...deleted, conversationId: "wrong-chat" } });
      await expect(client.catalog.permanentlyDelete(input)).rejects.toMatchObject({ code: "unavailable" });
      expect(erase).not.toHaveBeenCalled();
      response = Response.json({ ok: true, value: deleted });
      erase.mockRejectedValueOnce(new Error("device unavailable"));
      const error = await client.catalog.permanentlyDelete(input).catch(error => error) as ConversationLocalErasureError;
      expect(error).toBeInstanceOf(ConversationLocalErasureError); expect(error.result).toEqual(deleted);
      expect((await storage.readDraft("chat"))?.text).toBe("private draft");
      await error.retry();
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(erase).toHaveBeenCalledTimes(2); // One combined store, once per attempt.
      expect(await storage.readDraft("chat")).toBeNull(); expect(await storage.readPosition("chat")).toBeNull();
      expect(await storage.load("chat")).toBeNull();
    } finally { await client.dispose(); storage.close(); }
  });

  it("cleans default memory pending storage and a separately supplied local state store", async () => {
    const localStateStore = new InMemoryConversationLocalStateStore();
    await localStateStore.writeDraft("chat", "remove this", null);
    await localStateStore.writeDraft("keep", "keep this", null);
    const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", capabilities, localStateStore,
      fetch: async () => Response.json({ ok: true, value: { operation: "permanent_delete", status: "deleted", conversationId: "chat", deletedVersion: 1 } }) });
    try {
      await client.catalog.permanentlyDelete({ authorizationContext: undefined, conversationId: "chat" as never,
        expectedVersion: 1 as never, idempotencyKey: "delete-chat" as never });
      expect(await localStateStore.readDraft("chat")).toBeNull();
      expect((await localStateStore.readDraft("keep"))?.text).toBe("keep this");
      await expect(localStateStore.writeDraft("chat", "late", null)).rejects.toThrow("permanently deleted");
    } finally { await client.dispose(); localStateStore.dispose(); }
  });

  it("owns a negotiated display window without eager history reads and clears it when the account client is disposed", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input;
      return Response.json({ ok: true, value: { schemaVersion: 1, status: "ready", conversationId: input.conversationId,
        generation: 0, revision: 0, canonicalRevision: 0, activeTurnId: null, records: [], nextCursor: null } });
    });
    const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", fetch: fetcher,
      capabilities: { ...capabilities, displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144 } } });
    expect(fetcher).not.toHaveBeenCalled(); expect(client.displayWindow).not.toBeNull();
    expect(client.synchronization).toBeNull();
    await client.displayWindow!.select("chat");
    expect(client.displayWindow!.getSnapshot()).toMatchObject({ conversationId: "chat", status: "ready" });
    expect(fetcher).toHaveBeenCalledOnce(); expect(String(fetcher.mock.calls[0]![0]).endsWith("/conversations/history")).toBe(true);
    await client.dispose(); expect(client.displayWindow!.getSnapshot().conversationId).toBeNull();
    expect(client.displayWindow!.getSnapshot().records).toEqual([]);
    await expect(client.displayWindow!.select("another-account")).rejects.toThrow("disposed");
  });

  it("returns a saved single conversation while its real gateway resume is pending", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const conversationId = "saved-single" as never;
    await eventStore.append({ conversationId, expectedRevision: null, events: [parseConversationEvent({
      version: 1, event_id: "saved-start", conversation_id: conversationId, revision: 1,
      occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "runtime" },
      metadata: { handrail_runtime: { transport_turn_id: "remote-saved" } },
      payload: { type: "turn.started", turn_id: "saved-turn", input_message_ids: ["saved-input"] },
    })] });
    let finishFetch!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishFetch = resolve; });
    const fetcher = vi.fn<typeof fetch>(() => pending);
    const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", capabilities,
      fetch: fetcher,
      conversations: { mode: "single", conversationId, clientId: "client" as never, eventStore },
    });
    try {
      expect(client.conversation?.getSnapshot().active_turn_id).toBe("saved-turn");
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      expect(String(fetcher.mock.calls[0]?.[0])).toContain("/turns/resume");
    } finally {
      finishFetch(new Response(JSON.stringify({ ok: false, error: {
        code: "unavailable", message: "Test stopped", retryable: false,
      } }), { status: 503, headers: { "content-type": "application/json" } }));
      await client.dispose();
    }
  });

  it("creates a single conversation without assembling catalog runtime ownership", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const client = await createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities,
      conversations: {
        mode: "single",
        conversationId: "conversation_single" as never,
        clientId: "client_web" as never,
        eventStore,
      },
      buildRequest: ({ content }) => ({ prompt: content }),
      startActivityPolling: false,
    });

    expect(client.conversationMode).toBe("single");
    expect(client.conversation?.getSnapshot().conversation_id).toBe("conversation_single");
    expect(client.registry).toBeNull();
    expect(client.workspace).toBeNull();
    await client.dispose();
  });

  it("creates the full workspace only for explicit multiple-conversation mode", async () => {
    const client = await createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities,
      conversations: {
        mode: "multiple",
        clientId: "client_web" as never,
        eventStoreFor: () => new InMemoryConversationEventStore(),
        authorize: () => "allow",
      },
      startActivityPolling: false,
    });

    expect(client.conversationMode).toBe("multiple");
    expect(client.conversation).toBeNull();
    expect(client.registry).not.toBeNull();
    expect(client.workspace).not.toBeNull();
    await client.dispose();
  });

  it("assembles the standard headless client graph and application request builder", async () => {
    const eventStoreFor = vi.fn(() => new InMemoryConversationEventStore());
    const client = await createHandrailAiClient<unknown, {
      readonly prompt: string;
      readonly attachmentCount: number;
    }, { readonly actorId: string }>({
      baseUrl: "https://app.test/ai",
      capabilities,
      runtime: {
        clientId: "client_web" as never,
        deviceId: "device_browser" as never,
        eventStoreFor,
        authorize: () => "allow",
      },
      buildRequest: ({ content, attachments }) => ({
        prompt: content,
        attachmentCount: attachments.length,
      }),
      startActivityPolling: false,
    });

    expect(client.registry).not.toBeNull();
    expect(client.conversationMode).toBe("multiple");
    expect(client.conversation).toBeNull();
    expect(client.workspace).not.toBeNull();
    expect(client.activity).toBeNull();
    expect(client.attachmentUpload).toBeNull();
    expect(client.presence).toBeNull();
    expect(client.synchronization).toBeNull();
    const typedCatalog: ConversationCatalog<{ readonly actorId: string }> = client.catalog;
    const typedUpload: AttachmentUploadAdapter<Blob> | null = client.attachmentUpload;
    expect(typedCatalog).toBe(client.catalog);
    expect(typedUpload).toBeNull();
    expect(client.buildRequest({ content: "hello", attachments: [{ id: "a" }] }))
      .toEqual({ prompt: "hello", attachmentCount: 1 });
    expect(eventStoreFor).not.toHaveBeenCalled();
    await expect(client.markActivityRead("conversation-1")).resolves.toBeUndefined();
    await client.dispose();
  });

  it("rejects ambiguous runtime ownership", async () => {
    await expect(createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities,
      createRuntime: vi.fn(),
      authorizeRuntime: () => "allow",
      runtime: {
        clientId: "client_web" as never,
        eventStoreFor: () => new InMemoryConversationEventStore(),
        authorize: () => "allow",
      },
    })).rejects.toThrow("runtime cannot be combined with createRuntime/authorizeRuntime");
  });

  it("rejects mixing recommended and legacy conversation ownership", async () => {
    await expect(createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities,
      conversations: {
        mode: "single",
        conversationId: "conversation" as never,
        clientId: "client" as never,
        eventStore: new InMemoryConversationEventStore(),
      },
      runtime: {
        clientId: "client" as never,
        eventStoreFor: () => new InMemoryConversationEventStore(),
        authorize: () => "allow",
      },
    })).rejects.toThrow("conversations cannot be combined with legacy runtime ownership options");
  });

  it("requires either a local event store or negotiated server synchronization", async () => {
    await expect(createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities,
      runtime: {
        clientId: "client_web" as never,
        authorize: () => "allow",
      },
    })).rejects.toThrow("eventStoreFor or negotiated synchronization");
  });

  it("owns stable per-conversation presence controllers and destroys them with the client", async () => {
    const presenceCapabilities: ApplicationGatewayCapabilities = Object.freeze({
      ...capabilities,
      presence: true,
    });
    const client = await createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities: presenceCapabilities,
      runtime: {
        clientId: "client_web" as never,
        deviceId: "device_browser" as never,
        eventStoreFor: () => new InMemoryConversationEventStore(),
        authorize: () => "allow",
      },
      presenceIdentity: {
        participantId: "person_1",
        deviceId: "device_browser",
        sessionId: "session_1",
        autoConnect: false,
      },
    });
    const first = client.presenceControllerFor("conversation-1" as never);
    expect(first).not.toBeNull();
    expect(client.presenceControllerFor("conversation-1" as never)).toBe(first);
    expect(client.presenceControllerFor("conversation-2" as never)).not.toBe(first);
    await client.dispose();
    expect(first?.getSnapshot().connected).toBe(false);
  });
});
