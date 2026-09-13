import { describe, expect, it, vi } from "vitest";

import { postgres, type PostgresPoolLike } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext,
  type HandrailAssistantProvider } from "../src/server/assistant.js";
import type { ConversationTransport } from "../src/transports/types.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import type { ApplicationToolExecutor } from "../src/tools/executor.js";
import { InMemoryConversationEventStore, type ReadConversationEventsInput } from "../src/conversation/event-store.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { parseConversationEvent } from "../src/conversation/events.js";

const pool: PostgresPoolLike = {
  async query<TRow extends Record<string, unknown>>() { return { rows: [] as TRow[], rowCount: 0 }; },
  async connect() { throw new Error("not used"); },
};

const transport: ConversationTransport<StreamEvent, ChatRequest> = {
  capabilities: {
    authoritativeCancellation: { supported: false }, documentInput: { supported: false },
    attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
  },
  async startTurn() { throw new Error("not used"); },
  async resumeTurn() { throw new Error("not used"); },
};

class PagedEventStore extends InMemoryConversationEventStore {
  override read(input: ReadConversationEventsInput) {
    return super.read({ ...input, limit: input.limit ?? 1000 });
  }
}

describe("createHandrailAssistant", () => {
  it("binds default confirmation policy to each durable request without bypassing permissions or mandatory review", async () => {
    type Context = HandrailAssistantAuthorizationContext;
    const context = { principalId: "alice", tenantId: "tenant", scopeId: "alice", attribution: {} } as Context;
    const events = new PagedEventStore();
    const catalog = new InMemoryConversationCatalog<Context>({ authorize: () => "allow",
      createConversationId: () => "policy-conversation" as never });
    await catalog.create({ authorizationContext: context, idempotencyKey: "policy-new" as never });
    const modes: Record<string, unknown> = { automatic: "automatic", required: "required", invalid: "yes", missing: undefined };
    const load = vi.fn(async (_conversation: string, turn: string) => ({ record: {
      request: { metadata: { handrail_approval_mode: modes[turn] } },
    } }));
    const bundle = { events, catalog, durableTurns: { load },
      approvals: new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" }),
      toolLedger: new InMemoryToolExecutionLedger(),
      activity: { list: async () => [], upsert: async (record: unknown) => record },
    } as unknown as PostgresAssistantPersistenceBundle<Context>;
    const persistence = { persistence: {}, attachmentLimits: { maximumBytes: 1000,
      acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60_000 }, forScope: () => bundle } as unknown as PostgresAssistantPersistence;
    const execute = vi.fn(async () => ({ done: true }));
    const names = ["write_record", "mandatory_review", "forbidden_write"];
    const plugin = createToolPlugin<ApplicationToolExecutor<Context>, Context, Context, Context>({
      pluginId: "policy.test", version: "1.0.0", displayName: "Policy fixture",
      registrations: names.map((name) => ({ definition: { name, description: name, input_schema: { type: "object" } },
        discover: () => true, executor: execute })),
      approvals: names.map((toolName) => ({ toolName, mode: toolName === "mandatory_review" ? "always" : "policy",
        summarize: () => "Update a record" })),
    });
    let exposed!: Parameters<HandrailAssistantProvider<Context>["createTransport"]>[0]["tools"];
    const assistant = await createHandrailAssistant<Context>({ id: "policy-test", authorize: () => context,
      persistence, tools: [plugin], recoverPendingOnContext: false,
      toolPolicy: ({ definition }) => ({ outcome: definition.name === "forbidden_write" ? "deny" : "allow" }),
      provider: { metadata: { provider_id: "fixture", model_id: "fixture", capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
        context_window_tokens: null, max_output_tokens: null } },
        createTransport(input) { exposed = input.tools; return transport; } },
    });
    expect((await assistant.handle(new Request("https://example.test/capabilities"))).status).toBe(200);
    const run = (turnId: string, name = "write_record") => exposed.execute({ name, tool_call_id: `${turnId}-${name}`, arguments: {} },
      new AbortController().signal, { conversationId: "policy-conversation", turnId });
    const [automatic, required, missing] = await Promise.all([run("automatic"), run("required"), run("missing")]);
    expect(automatic).toMatchObject({ status: "completed", result: { is_error: false } });
    expect(required.status).toBe("external_approval_required");
    expect(missing.status).toBe("external_approval_required");
    expect((await run("automatic", "mandatory_review")).status).toBe("external_approval_required");
    expect(await run("automatic", "forbidden_write")).toMatchObject({ status: "completed", result: { is_error: true } });
    expect(await run("invalid")).toMatchObject({ status: "completed", result: { is_error: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    for (const turn of ["automatic", "required", "missing", "invalid"]) {
      expect(load).toHaveBeenCalledWith("policy-conversation", turn);
    }
    assistant.stopUsageWorker();
  });

  it("derives isolated persistence and transports only from authenticated context", async () => {
    const scopes: string[] = [];
    const assistant = await createHandrailAssistant({
      id: "aegis",
      instructions: "Protect the customer.",
      authorize: (request): HandrailAssistantAuthorizationContext => ({
        principalId: request.headers.get("x-user")!, tenantId: "tenant-a", scopeId: request.headers.get("x-user")!,
        attribution: {
          organization: { id: "org", source: "server_derived", trust: "authoritative" },
          project: { id: "project", source: "server_derived", trust: "authoritative" },
          service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
          known_user: { id: request.headers.get("x-user")!, source: "server_derived", trust: "authoritative" },
          session: { id: null, source: "server_derived", trust: "authoritative" },
          automation: { id: null, source: "server_derived", trust: "authoritative" },
        },
      }),
      persistence: postgres(pool),
      provider: {
        metadata: { provider_id: "test", model_id: "test-model", capabilities: {
          streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
          document_input: { supported: false }, citation_projection: { supported: true },
          provider_context: { supported: false, reason: "provider_not_supported" }, context_window_tokens: null, max_output_tokens: null,
        } },
        createTransport(input) {
          scopes.push(`${input.context.tenantId}/${input.context.scopeId}`);
          expect(input.instructions).toEqual(["Protect the customer."]);
          return transport;
        },
      },
    });

    const capability = (user: string) => assistant.handle(new Request("https://example.test/api/assistant/aegis/capabilities", {
      headers: { "x-user": user },
    }));
    const first = await capability("alice");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, value: { resources: { titleGeneration: true },
      assistant: { id: "aegis", version: "handrail.assistant.v1",
        provider: { provider_id: "test", model_id: "test-model" } } } });
    expect((await capability("bob")).status).toBe(200);
    expect((await capability("alice")).status).toBe(200);
    expect(scopes).toEqual(["tenant-a/alice", "tenant-a/bob"]);
  });

  it.each([["confirmed", 0], ["rejected", 0], ["confirmed", 1166], ["rejected", 1166]] as const)(
    "owns approval creation and audit for %s decisions after %s history events", async (status, historyEvents) => {
    type Context = HandrailAssistantAuthorizationContext;
    const context = (request: Request): Context => ({ principalId: request.headers.get("x-user") ?? "alice",
      tenantId: "tenant", scopeId: "alice", attribution: {
        organization: { id: "org", source: "server_derived", trust: "authoritative" },
        project: { id: "project", source: "server_derived", trust: "authoritative" },
        service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
        known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
        session: { id: null, source: "server_derived", trust: "authoritative" },
        automation: { id: null, source: "server_derived", trust: "authoritative" },
      } });
    const events = new PagedEventStore();
    const approvals = new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" });
    const catalog = new InMemoryConversationCatalog<Context>({ authorize: (request) => request.authorizationContext.principalId === "alice" ? "allow" : "deny",
      createConversationId: () => "conversation-approved" as never });
    const durableTurns = new InMemoryDurableApplicationTurnStore();
    const activityRecords: import("../src/conversation/activity.js").ConversationActivityRecord[] = [];
    const bundle = { events,
      approvals: historyEvents > 0 ? approvals : new InMemoryApprovalProposalStore<Context>({ authorize: () => "deny" }),
      catalog: new InMemoryConversationCatalog<Context>({ authorize: () => "deny",
        createConversationId: () => "wrong-conversation" as never }),
      durableTurns, toolLedger: new InMemoryToolExecutionLedger(),
      activity: {
        async list() { return activityRecords; },
        async upsert(record: import("../src/conversation/activity.js").ConversationActivityRecord) {
          activityRecords.push(record); return record;
        },
        async markRead() { return null; },
      },
      usageReceiptSink: null, usageAdmissions: null } as unknown as PostgresAssistantPersistenceBundle<Context>;
    const persistence = { attachmentLimits: { maximumBytes: 1_000, acceptedMediaTypes: ["text/plain"],
      ttlMilliseconds: 60_000 }, persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence;
    let exposed: Parameters<HandrailAssistantProvider<Context>["createTransport"]>[0]["tools"] | undefined;
    let executions = 0;
    const plugin = createToolPlugin<ApplicationToolExecutor<Context>, Context, Context, Context>({
      pluginId: "test.approval", version: "1.0.0", displayName: "Approval test",
      registrations: [{ definition: { name: "dangerous", description: "Dangerous operation",
        input_schema: { type: "object" } }, discover: () => true,
        executor: async (_arguments, execution) => {
          expect(execution.location).toEqual({ conversationId: "conversation-approved", turnId: "turn-approved" });
          await execution.reportActivity?.({ summary: "Applying reviewed updates",
            progress: { completed: 43, total: 43, unit: "products" } });
          executions += 1; return { done: true };
        } }],
    });
    const assistant = await createHandrailAssistant<Context>({ id: "approval-test", authorize: async (request) => context(request),
      persistence, tools: [plugin], toolPolicy: () => ({ outcome: "external_approval_required" }),
      activityForToolCall: () => ({ summary: "Preparing revenue account updates" }),
      conversationCatalogFor: () => catalog,
      ...(historyEvents === 0 ? { approvalStoreFor: () => approvals } : {}),
      provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
        context_window_tokens: null, max_output_tokens: null } },
      createTransport(input) { exposed = input.tools; return transport; } } });
    await catalog.create({ authorizationContext: context(new Request("https://example.test")),
      idempotencyKey: "create-approved" as never });
    await events.append({ conversationId: "conversation-approved" as never, expectedRevision: null, events: [
      parseConversationEvent({ version: 1, event_id: "message-title", conversation_id: "conversation-approved",
        revision: 1, occurred_at: "2026-09-02T00:00:00.000Z", actor: { type: "user", id: "alice" },
        source: { type: "runtime" }, payload: { type: "message.created", message_id: "message-title",
          role: "user", content: [{ type: "text", text: "  Delete   record 42 safely  " }] } }),
    ] });
    if (historyEvents > 0) {
      await events.append({ conversationId: "conversation-approved" as never, expectedRevision: 1 as never,
        events: Array.from({ length: historyEvents }, (_, index) => parseConversationEvent({
          version: 1, event_id: `history-${index}`, conversation_id: "conversation-approved", revision: index + 2,
          occurred_at: "2026-09-02T00:00:00.000Z", actor: { type: "system" }, source: { type: "import" },
          payload: { type: "conversation.metadata_updated", metadata: { index } },
        })) });
    }
    await assistant.handle(new Request("https://example.test/capabilities", { headers: { "x-user": "alice" } }));
    const title = await assistant.handle(new Request("https://example.test/titles/generate", { method: "POST",
      headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({
        conversationId: "conversation-approved", idempotencyKey: "title-approved",
      }) }));
    expect(await title.json()).toMatchObject({ ok: true, value: "Delete record 42 safely" });
    const call = { tool_call_id: "call-approved", name: "dangerous", arguments: { id: "42" } };
    expect((await exposed!.execute(call, new AbortController().signal,
      { conversationId: "conversation-approved", turnId: "turn-approved" })).status)
      .toBe("external_approval_required");
    expect(activityRecords.at(-1)).toMatchObject({ summary: "Preparing revenue account updates" });
    const pending = exposed!.awaitApproval({ conversationId: "conversation-approved", turnId: "turn-approved",
      call, signal: new AbortController().signal });
    let proposalId = "";
    await vi.waitFor(async () => {
      const retained = await events.read({ conversationId: "conversation-approved" as never, limit: 5000 });
      const created = retained.entries.find(({ event }) => event.payload.type === "approval.proposal_created");
      proposalId = created?.event.payload.type === "approval.proposal_created" ? created.event.payload.proposal_id : "";
      expect(proposalId).not.toBe("");
    });
    expect((await approvals.listGroup({ permissionContext: context(new Request("https://example.test")),
      groupId: "conversation-approved" as never })).map((proposal) => proposal.proposal_id))
      .toEqual([proposalId]);
    expect(executions).toBe(0);
    if (historyEvents > 0) {
      const firstPage = await events.read({ conversationId: "conversation-approved" as never });
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.entries.some(({ event }) => event.payload.type === "approval.proposal_created")).toBe(false);
    }
    const forbidden = await assistant.handle(new Request("https://example.test/approvals/transition", {
      method: "POST", headers: { "x-user": "bob", "content-type": "application/json" }, body: JSON.stringify({
        conversationId: "conversation-approved", proposalId, expectedVersion: 1, status,
        idempotencyKey: "forbidden", idempotencyFingerprint: "forbidden",
      }),
    }));
    expect(forbidden.status).toBe(403);
    expect(executions).toBe(0);
    const decision = await assistant.handle(new Request("https://example.test/approvals/transition", {
      method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({
        conversationId: "conversation-approved", proposalId, expectedVersion: 1, status,
        idempotencyKey: "confirm-approved", idempotencyFingerprint: "confirm-approved",
        attribution: { actor: { type: "system" }, source: { type: "import" } },
      }),
    }));
    expect(decision.status).toBe(200);
    // An explicitly configured host authority also handles pre-SDK proposals.
    // The SDK-owned store still requires canonical evidence, including on later pages.
    for (const group of ["conversation-approved", "another-conversation"]) {
      const legacyId = `legacy-${group}`;
      await approvals.create({ permissionContext: context(new Request("https://example.test")),
        proposalId: legacyId as never, groupId: group as never, turnId: "old-turn" as never,
        toolCallId: "old-call" as never, toolName: "dangerous", reviewedArguments: { type: "redacted_json", value: {} },
        expiresAt: new Date(Date.now() + 60_000).toISOString() as never,
        attribution: { actor: { type: "system" }, source: { type: "import" } },
        idempotencyKey: legacyId, idempotencyFingerprint: legacyId });
      const result = await assistant.handle(new Request("https://example.test/approvals/transition", {
        method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({
          conversationId: "conversation-approved", proposalId: legacyId, expectedVersion: 1, status,
          idempotencyKey: `decide-${legacyId}`, idempotencyFingerprint: `decide-${legacyId}`,
          attribution: { actor: { type: "system" }, source: { type: "import" } },
        }),
      }));
      const authorizedLegacy = historyEvents === 0 && group === "conversation-approved";
      expect(result.status).toBe(authorizedLegacy ? 200 : 404);
      const retained = await approvals.get({ permissionContext: context(new Request("https://example.test")), proposalId: legacyId as never });
      expect(retained?.status).toBe(authorizedLegacy ? status : "pending");
      if (authorizedLegacy) expect(retained?.latest_attribution.actor).toEqual({ type: "user", id: "alice" });
      expect((await events.read({ conversationId: "conversation-approved" as never, limit: 5000 })).entries.some(({ event }) =>
        event.payload.type === "approval.proposal_created" && event.payload.proposal_id === legacyId)).toBe(false);
    }
    if (status === "rejected") {
      expect(await pending).toMatchObject({ status: "completed", result: { is_error: true } });
      expect(executions).toBe(0);
      const audit = await events.read({ conversationId: "conversation-approved" as never, limit: 5000 });
      expect(audit.entries.some(({ event }) => event.payload.type === "tool_call.started")).toBe(false);
      expect(audit.entries.filter(({ event }) => event.payload.type === "tool_call.result_recorded")
        .map(({ event }) => event.payload)).toMatchObject([{ is_error: true }]);
      return;
    }
    expect(await pending).toMatchObject({ status: "completed", result: { is_error: false } });
    expect(executions).toBe(1);
    expect(activityRecords.some((record) => record.summary === "Running approved work")).toBe(true);
    expect(activityRecords.at(-1)).toMatchObject({ summary: "Applying reviewed updates",
      progress: { completed: 43, total: 43, unit: "products" } });
    const audit = await events.read({ conversationId: "conversation-approved" as never, limit: 5000 });
    expect(audit.entries.filter(({ event }) => event.payload.type === "tool_call.started")).toHaveLength(1);
    expect(audit.entries.filter(({ event }) => event.payload.type === "tool_call.result_recorded")
      .map(({ event }) => event.payload)).toMatchObject([{ is_error: false }]);
    expect(audit.entries.some(({ event }) => event.payload.type === "approval.proposal_status_changed" &&
      event.payload.status === "confirmed" && event.actor.type === "user" && event.actor.id === "alice" &&
      event.source.type === "runtime")).toBe(true);
  });

  it("recovers a durable scope when its trusted context is first authenticated", async () => {
    type Context = HandrailAssistantAuthorizationContext;
    const context: Context = { principalId: "alice", tenantId: "tenant", scopeId: "alice",
      attribution: { organization: { id: "org", source: "server_derived", trust: "authoritative" },
        project: { id: "project", source: "server_derived", trust: "authoritative" },
        service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
        known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
        session: { id: "session", source: "server_derived", trust: "authoritative" },
        automation: { id: null, source: "server_derived", trust: "authoritative" } } };
    const durableTurns = new InMemoryDurableApplicationTurnStore();
    const recoverable = vi.spyOn(durableTurns, "scanRecoverable");
    const bundle = { events: new InMemoryConversationEventStore(),
      approvals: new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" }),
      catalog: new InMemoryConversationCatalog<Context>({ authorize: () => "allow" }),
      durableTurns, toolLedger: new InMemoryToolExecutionLedger(), activity: {}, attachments: {},
      usageReceiptSink: null, usageAdmissions: null } as unknown as PostgresAssistantPersistenceBundle<Context>;
    const assistant = await createHandrailAssistant<Context>({ id: "context-recovery", authorize: () => context,
      persistence: { attachmentLimits: { maximumBytes: 1_000, acceptedMediaTypes: ["text/plain"],
        ttlMilliseconds: 60_000 }, persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence,
      provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
        context_window_tokens: null, max_output_tokens: null } }, createTransport: () => transport } });

    expect(recoverable).not.toHaveBeenCalled();
    expect((await assistant.handle(new Request("https://example.test/capabilities"))).status).toBe(200);
    expect(recoverable).toHaveBeenCalledOnce();
    expect(recoverable).toHaveBeenCalledWith(25, undefined);
    expect((await assistant.handle(new Request("https://example.test/capabilities"))).status).toBe(200);
    expect(recoverable).toHaveBeenCalledOnce();
  });

  it("drains durable usage on startup and retries failed delivery in the worker", async () => {
    vi.useFakeTimers();
    try {
      type Context = HandrailAssistantAuthorizationContext;
      const context: Context = { principalId: "alice", tenantId: "tenant", scopeId: "scope",
        attribution: { organization: { id: "org", source: "server_derived", trust: "authoritative" },
          project: { id: "project", source: "server_derived", trust: "authoritative" },
          service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
          known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
          session: { id: null, source: "server_derived", trust: "authoritative" },
          automation: { id: null, source: "server_derived", trust: "authoritative" } } };
      const flush = vi.fn()
        .mockRejectedValueOnce(new Error("telemetry temporarily unavailable"))
        .mockResolvedValue({ delivered: 1, pending: 0 });
      const bundle = { events: new InMemoryConversationEventStore(),
        approvals: new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" }),
        catalog: new InMemoryConversationCatalog<Context>({ authorize: () => "allow" }),
        durableTurns: new InMemoryDurableApplicationTurnStore(),
        toolLedger: new InMemoryToolExecutionLedger(), activity: {}, attachments: {},
        usageReceiptSink: { flush }, usageAdmissions: null } as unknown as PostgresAssistantPersistenceBundle<Context>;
      const diagnostics = vi.fn();
      const assistant = await createHandrailAssistant<Context>({ id: "usage-worker",
        authorize: () => context, recoveryContexts: () => [context], diagnostics,
        usage: { client: {} as never }, usageDelivery: { retryIntervalMilliseconds: 10, batchSize: 7 },
        persistence: { attachmentLimits: { maximumBytes: 1_000, acceptedMediaTypes: ["text/plain"],
          ttlMilliseconds: 60_000 }, persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence,
        provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
          streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
          document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
          context_window_tokens: null, max_output_tokens: null } }, createTransport: () => transport } });
      expect(flush).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledWith(7);
      expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ operation: "usage_outbox_flush",
        phase: "failed", retryable: true }));
      await vi.advanceTimersByTimeAsync(10);
      expect(flush).toHaveBeenCalledTimes(2);
      assistant.stopUsageWorker();
    } finally { vi.useRealTimers(); }
  });
});
