import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { createApplicationTurnTransport } from "../src/transports/application-turn.js";
import { InMemoryDurableApplicationTurnStore, DURABLE_APPLICATION_TURN_SCHEMA_VERSION } from "../src/transports/durable.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { parseConversationEvent, type ConversationId } from "../src/conversation/events.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";

const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const contextFor = (owner: string): HandrailAssistantAuthorizationContext => ({
  principalId: owner, tenantId: "shared-household", scopeId: owner,
  attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
    known_user: fact(owner), session: fact(`${owner}-session`), automation: fact(null) },
});
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };

it.each(["persistence", "host"] as const)("checks the %s catalog before recovering another user's pending work", async source => {
  const events = new InMemoryConversationEventStore();
  const durableTurns = new InMemoryDurableApplicationTurnStore<ChatRequest, StreamEvent>();
  const catalog = new InMemoryConversationCatalog<HandrailAssistantAuthorizationContext>({
    authorize: input => "conversationId" in input && input.conversationId === `${input.authorizationContext.principalId}-conversation` ? "allow" : "deny",
  });
  const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Complete my work" }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
  // More denied rows than the high-level startup page size must not starve Bob.
  const otherOwners = Array.from({ length: 26 }, (_, index) => `account-${String(index).padStart(2, "0")}`);
  for (const owner of ["alice", ...otherOwners, "bob"]) {
    const conversationId = `${owner}-conversation` as ConversationId;
    await catalog.create({ authorizationContext: contextFor(owner), conversationId, title: owner,
      idempotencyKey: `${owner}-create` as never });
    await events.append({ conversationId, expectedRevision: null, events: [
      { type: "message.created", message_id: `${owner}-message`, role: "user", content: request.messages[0]!.content },
      { type: "turn.started", turn_id: `${owner}-turn`, input_message_ids: [`${owner}-message`] },
    ].map((payload, index) => parseConversationEvent({ version: 1, event_id: `${owner}-event-${index}`,
      conversation_id: conversationId, revision: index + 1, occurred_at: new Date().toISOString(),
      actor: { type: "user", id: owner }, source: { type: "sync" },
      ...(index === 0 ? { mutation_id: `${owner}-admission` } : {}), payload })) });
    await durableTurns.create({ schemaVersion: DURABLE_APPLICATION_TURN_SCHEMA_VERSION, conversationId,
      turnId: `${owner}-turn`, mutationId: `${owner}-admission`, idempotencyKey: `${owner}-start`,
      requestFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"), request,
      delegateTurnId: null, status: "pending", attempt: 0, events: [], terminal: null, cancellation: null, lease: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  const othersBefore = await Promise.all(otherOwners.map(owner => durableTurns.load(`${owner}-conversation`, `${owner}-turn`)));
  const aliceBefore = await durableTurns.load("alice-conversation", "alice-turn");
  const aliceEventsBefore = await events.read({ conversationId: "alice-conversation" as ConversationId, limit: 100 });
  const execute = vi.fn(async (principalId: string, conversationId: string) => {
    expect(conversationId).toBe(`${principalId}-conversation`);
    return { status: "completed" as const, checkpoint };
  });
  let context = contextFor("bob");
  const bundle = { events, durableTurns,
    catalog: source === "persistence" ? catalog : new InMemoryConversationCatalog({ authorize: () => "allow" }),
    approvals: new InMemoryApprovalProposalStore({ authorize: () => "allow" }),
    toolLedger: new InMemoryToolExecutionLedger(), activity: {}, usageReceiptSink: null, usageAdmissions: null,
  } as unknown as PostgresAssistantPersistenceBundle<HandrailAssistantAuthorizationContext>;
  const assistant = await createHandrailAssistant({ id: "recovery-authorization", authorize: () => context,
    ...(source === "host" ? { conversationCatalogFor: () => catalog } : {}),
    persistence: { attachmentLimits: { maximumBytes: 1000, acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60000 },
      persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport: input => createApplicationTurnTransport<StreamEvent, ChatRequest>({
      execute: (_request, turn) => execute(input.context.principalId, turn.conversationId),
    }) },
  });
  try {
    expect((await assistant.handle(new Request("https://assistant.test/capabilities"))).status).toBe(200);
    await vi.waitFor(async () => expect((await durableTurns.load("bob-conversation", "bob-turn"))?.record.status).toBe("completed"));
    await assistant.recoverPending();
    expect(await durableTurns.load("alice-conversation", "alice-turn")).toEqual(aliceBefore);
    expect(await events.read({ conversationId: "alice-conversation" as ConversationId, limit: 100 })).toEqual(aliceEventsBefore);
    expect(execute.mock.calls).toEqual([["bob", "bob-conversation"]]);
    const originalGet = catalog.get.bind(catalog);
    let lookupUnavailable = true;
    vi.spyOn(catalog, "get").mockImplementation(input => {
      if (lookupUnavailable && input.conversationId === "alice-conversation") throw new Error("private database detail");
      return originalGet(input);
    });
    context = contextFor("alice");
    expect((await assistant.handle(new Request("https://assistant.test/capabilities"))).status).toBe(200);
    await assistant.recoverPending();
    expect(await durableTurns.load("alice-conversation", "alice-turn")).toEqual(aliceBefore);
    expect(execute.mock.calls).toEqual([["bob", "bob-conversation"]]);
    lookupUnavailable = false;
    await assistant.recoverPending();
    await vi.waitFor(async () => expect((await durableTurns.load("alice-conversation", "alice-turn"))?.record.status).toBe("completed"));
    expect(execute.mock.calls).toEqual([["bob", "bob-conversation"], ["alice", "alice-conversation"]]);
    expect(await Promise.all(otherOwners.map(owner => durableTurns.load(`${owner}-conversation`, `${owner}-turn`)))).toEqual(othersBefore);
  } finally { assistant.stopUsageWorker(); }
});
