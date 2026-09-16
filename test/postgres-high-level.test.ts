import { describe, expect, it } from "vitest";
import { PostgresAiPersistence, PostgresApprovalProposalStore, PostgresConversationCatalog, PostgresConversationEventStore, type PostgresSqlClient } from "../src/postgres/index.js";
import { ApprovalProposalStoreError, ConversationCatalogError, ConversationEventStoreUnavailableError } from "../src/index.js";
import type { ConversationEvent, ConversationId } from "../src/index.js";

describe("Postgres high-level adapters", () => {
  it("normalizes database failures without leaking native details", async () => {
    const client: PostgresSqlClient = {
      query: async () => { throw new Error("postgres password=secret host=internal"); },
      transaction: async (operation) => operation(client),
    };
    const persistence = new PostgresAiPersistence(client);
    const eventStore = new PostgresConversationEventStore(persistence, "tenant-a");
    await expect(eventStore.getLatestRevision("conversation-a" as ConversationId))
      .rejects.toEqual(expect.objectContaining({
        name: "ConversationEventStoreUnavailableError",
        message: "The conversation event store is unavailable.",
      }));
    await expect(eventStore.getLatestRevision("conversation-a" as ConversationId))
      .rejects.toBeInstanceOf(ConversationEventStoreUnavailableError);

    const catalog = new PostgresConversationCatalog({ persistence, tenantId: "tenant-a",
      scopeId: () => "company-a", authorize: async () => "allow" as const, createId: () => "conversation-a" as ConversationId });
    await expect(catalog.list({ authorizationContext: {}, lifecycle: "active", pageSize: 10,
      order: { field: "updated_at", direction: "desc" } }))
      .rejects.toEqual(expect.objectContaining({ code: "unavailable", message: "The conversation catalog is unavailable." }));

    const approvals = new PostgresApprovalProposalStore({ persistence, tenantId: "tenant-a",
      scopeId: () => "company-a", authorize: async () => "allow" as const });
    await expect(approvals.get({ permissionContext: {}, proposalId: "proposal-a" as never }))
      .rejects.toEqual(expect.objectContaining({ code: "unavailable", message: "The approval proposal store is temporarily unavailable." }));
    await expect(approvals.get({ permissionContext: {}, proposalId: "proposal-a" as never }))
      .rejects.toBeInstanceOf(ApprovalProposalStoreError);
  });

  it("durably creates proposal-only approvals and replays the exact idempotent result", async () => {
    const idempotency = new Map<string, { fingerprint: string; result: unknown }>();
    let approvalInserts = 0;
    const query = async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("SELECT fingerprint,result")) {
        const row = idempotency.get(String(values[3])); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith("INSERT INTO handrail_ai_approvals")) { approvalInserts += 1; return { rows: [], rowCount: 1 }; }
      if (sql.startsWith("INSERT INTO handrail_ai_idempotency")) {
        idempotency.set(String(values[3]), { fingerprint: String(values[4]), result: JSON.parse(String(values[5])) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    const client: PostgresSqlClient = { query: query as PostgresSqlClient["query"], transaction: async (operation) => operation(client) };
    const store = new PostgresApprovalProposalStore({ persistence: new PostgresAiPersistence(client), tenantId: "tenant-a",
      scopeId: (actor: { companyId: string }) => actor.companyId,
      authorize: async ({ permissionContext }) => permissionContext.companyId === "company-a" ? "allow" : "deny",
      now: () => "2026-08-30T12:00:00.000Z" as never });
    const request = { permissionContext: { companyId: "company-a" }, proposalId: "proposal-a" as never,
      turnId: "turn-a" as never, toolCallId: "call-a" as never, toolName: "issue_invoice",
      reviewedArguments: { type: "redacted_json" as const, value: { invoiceId: "invoice-a" } },
      expiresAt: "2026-08-30T12:05:00.000Z" as never,
      attribution: { actor: { type: "system" as const }, source: { type: "runtime" as const } },
      idempotencyKey: "approval-a", idempotencyFingerprint: "fingerprint-a" };
    await expect(store.create(request)).resolves.toMatchObject({ proposal_id: "proposal-a", status: "pending", proposal_version: 1 });
    await expect(store.create(request)).resolves.toMatchObject({ proposal_id: "proposal-a", status: "pending" });
    expect(approvalInserts).toBe(1);
    await expect(store.create({ ...request, permissionContext: { companyId: "company-b" }, idempotencyKey: "denied" }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("authorizes catalog operations before durable lookup and retains idempotent create results", async () => {
    const idempotency = new Map<string, { fingerprint: string; result: unknown }>();
    const conversations: unknown[] = [];
    const query = async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("SELECT fingerprint,result")) {
        const row = idempotency.get(String(values[3])); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("kind='conversation_deleted'") || sql.includes("kind='catalog_identity'") || sql.startsWith("SELECT conversation_id FROM handrail_ai_conversations")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO handrail_ai_documents")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO handrail_ai_conversations")) {
        conversations.push(values); return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO handrail_ai_idempotency")) {
        idempotency.set(String(values[3]), { fingerprint: String(values[4]), result: JSON.parse(String(values[5])) });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    const client: PostgresSqlClient = { query: query as PostgresSqlClient["query"], transaction: async (operation) => operation(client) };
    const authorize = async ({ authorizationContext }: { authorizationContext: { companyId: string } }) =>
      authorizationContext.companyId === "company-a" ? "allow" as const : "deny" as const;
    const catalog = new PostgresConversationCatalog({ persistence: new PostgresAiPersistence(client), tenantId: "tenant-a",
      scopeId: (actor: { companyId: string }) => actor.companyId, authorize, createId: () => "conversation-a" as ConversationId,
      now: () => "2026-08-30T12:00:00.000Z" as never });
    const request = { authorizationContext: { companyId: "company-a" }, title: "Aegis", idempotencyKey: "create-a" as never };
    await expect(catalog.create(request)).resolves.toMatchObject({ status: "created", descriptor: { conversationId: "conversation-a", version: 1 } });
    await expect(catalog.create(request)).resolves.toMatchObject({ status: "idempotent", descriptor: { conversationId: "conversation-a" } });
    expect(conversations).toHaveLength(1);
    await expect(catalog.create({ ...request, authorizationContext: { companyId: "company-b" }, idempotencyKey: "denied" as never }))
      .rejects.toMatchObject({ code: "forbidden" });
    await expect(catalog.create({ ...request, title: "Different" })).rejects.toBeInstanceOf(ConversationCatalogError);
  });

  it("appends, idempotently reconciles, and cursor-reads canonical conversation events", async () => {
    const events: ConversationEvent[] = [];
    let lagLatestRead = false;
    let displayRevision = 0;
    const query = async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (sql.includes("kind='conversation_deleted'")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("SELECT revision::text,generation::text,active_turn_id")) {
          return { rows: [{ revision: String(displayRevision), generation: "0", active_turn_id: null }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE handrail_ai_display_heads")) displayRevision = Number(values[2]);
        if (sql.includes("handrail_ai_display_")) return { rows: [], rowCount: 1 };
        if (sql.includes("event_id=ANY")) {
          const identifiers = values[1] as string[];
          const rows = events.filter((event) => identifiers.includes(event.event_id) ||
            (event.mutation_id !== undefined && identifiers.includes(event.mutation_id))).map((payload) => ({ payload }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("revision>$3")) {
          const after = Number(values[2]), limit = Number(values[3]);
          const latest_revision = events.at(-1)?.revision.toString() ?? null;
          const page = events.filter((event) => event.revision > after).slice(0, limit).map((payload) => ({ payload, latest_revision }));
          const rows = page.length ? page : [{ payload: null, latest_revision }];
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("revision >= $3")) {
          const minimum = Number(values[2]);
          const latest = [...events].reverse().find((event) => event.revision >= minimum);
          return { rows: latest ? [{ revision: String(latest.revision) }] : [], rowCount: latest ? 1 : 0 };
        }
        if (sql.includes("ORDER BY handrail_ai_events.revision DESC")) {
          const latest = lagLatestRead ? events.at(-2) : events.at(-1);
          return { rows: latest ? [{ revision: String(latest.revision) }] : [], rowCount: latest ? 1 : 0 };
        }
        if (sql.startsWith("INSERT INTO handrail_ai_events")) {
          events.push(JSON.parse(String(values[5])) as ConversationEvent);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      };
    const client: PostgresSqlClient = {
      transaction: async (operation) => operation(client),
      query: query as PostgresSqlClient["query"],
    };
    const store = new PostgresConversationEventStore(new PostgresAiPersistence(client), "tenant-a");
    const conversationId = "conversation-a" as ConversationId;
    const event = {
      version: 1, event_id: "event-a", conversation_id: conversationId, revision: 1,
      occurred_at: "2026-08-30T12:00:00.000Z", actor: { type: "user" },
      source: { type: "client", client_id: "client-a" }, mutation_id: "mutation-a",
      payload: { type: "message.created", message_id: "message-a", role: "user", content: [{ type: "text", text: "Hello" }] },
    } as ConversationEvent;

    await expect(store.append({ conversationId, expectedRevision: null, events: [event] }))
      .resolves.toMatchObject({ status: "appended", latestRevision: 1 });
    await expect(store.append({ conversationId, expectedRevision: null, events: [event] }))
      .resolves.toMatchObject({ status: "idempotent", latestRevision: 1 });
    const second = { ...event, event_id: "event-b", revision: 2, mutation_id: "mutation-b",
      payload: { ...event.payload, message_id: "message-b", content: [{ type: "text", text: "Again" }] } } as ConversationEvent;
    await expect(store.append({ conversationId, expectedRevision: 1 as never, events: [second] }))
      .resolves.toMatchObject({ status: "appended", latestRevision: 2 });
    lagLatestRead = true;
    const third = { ...second, event_id: "event-c", revision: 3, mutation_id: "mutation-c",
      payload: { ...second.payload, message_id: "message-c" } } as ConversationEvent;
    await expect(store.append({ conversationId, expectedRevision: 2 as never, events: [third] }))
      .resolves.toMatchObject({ status: "appended", latestRevision: 3 });
    const first = await store.read({ conversationId, limit: 3 });
    expect(first).toMatchObject({ latestRevision: 3, hasMore: false,
      entries: [{ event: { event_id: "event-a" } }, { event: { event_id: "event-b" } },
        { event: { event_id: "event-c" } }] });
    expect(await store.read({ conversationId, after: { cursor: first.nextCursor! } })).toMatchObject({ entries: [] });
  });
});
