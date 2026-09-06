import { describe, expect, it, vi } from "vitest";

import {
  PostgresAIRuntimeUsageOutbox,
  PostgresAIRuntimeUsageAdmissionStore,
  PostgresAiPersistence,
  PostgresConversationActivityStore,
  PostgresPersistenceConflictError,
  createPostgresSqlClientFromPool,
  postgres,
  type PostgresPoolClientLike,
  type PostgresPoolLike,
  type PostgresVersionedDocument,
} from "../src/postgres/index.js";
import { createAIRuntimeUsageClient, createAIRuntimeUsageReceiptSink, type AIRuntimeUsageOutboxEntry } from "../src/server/usage-control.js";
import { parseNormalizedUsageReceipt } from "../src/usage.js";

function receipt(id: string, logicalRequestId = "logical-1") {
  return parseNormalizedUsageReceipt({
    version: 1,
    usage_receipt_id: id,
    conversation_id: "conversation-1",
    turn_id: "turn-1",
    logical_request_id: logicalRequestId,
    trace_id: "trace-1",
    attempt: { id: "attempt-0", index: 0 },
    continuation: { id: "continuation-0", index: 0 },
    provider_id: "openai",
    model_id: "gpt-5",
    attribution: {
      organization: { id: "org-1", source: "server_derived", trust: "authoritative" },
      project: { id: "project-1", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "environment-1", source: "server_derived", trust: "authoritative" },
      known_user: { id: "user-1", source: "server_derived", trust: "authoritative" },
      session: { id: null, source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" },
    },
    source: "provider",
    terminal_status: "completed",
    tokens: {
      input_tokens: { status: "reported", value: 4 },
      cached_input_tokens: { status: "reported", value: 0 },
      output_tokens: { status: "reported", value: 2 },
      reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "reported", value: 6 },
    },
    provider_cost: { status: "unavailable" },
  });
}

class MemoryDocuments {
  readonly rows = new Map<string, PostgresVersionedDocument<unknown>>();

  key(tenantId: string, kind: string, scopeId: string, recordId: string) {
    return `${tenantId}\0${kind}\0${scopeId}\0${recordId}`;
  }

  readonly persistence = {
    client: {
      query: async <TRow extends Record<string, unknown>>(_text: string, values?: readonly unknown[]) => {
        const tenantId = String(values?.[0]);
        const scopeId = String(values?.[1]);
        const limit = Number(values?.[2]);
        const rows = [...this.rows.values()]
          .filter((row) => row.tenantId === tenantId && row.kind === "usage_outbox" &&
            row.scopeId === scopeId && (row.value as { status?: string }).status === "pending")
          .sort((left, right) => {
            const leftEntry = (left.value as { entry: AIRuntimeUsageOutboxEntry }).entry;
            const rightEntry = (right.value as { entry: AIRuntimeUsageOutboxEntry }).entry;
            return leftEntry.enqueuedAt.localeCompare(rightEntry.enqueuedAt) ||
              left.recordId.localeCompare(right.recordId);
          })
          .slice(0, limit)
          .map((row) => ({ payload: row.value }) as unknown as TRow);
        return { rows, rowCount: rows.length };
      },
    },
    getDocument: async <T>(tenantId: string, kind: string, scopeId: string, recordId: string) =>
      (this.rows.get(this.key(tenantId, kind, scopeId, recordId)) as
        PostgresVersionedDocument<T> | undefined) ?? null,
    compareAndSetDocument: async <T>(input: Omit<PostgresVersionedDocument<T>, "version"> & {
      readonly expectedVersion: number | null;
    }) => {
      const key = this.key(input.tenantId, input.kind, input.scopeId, input.recordId);
      const current = this.rows.get(key);
      if ((current?.version ?? null) !== input.expectedVersion) throw new PostgresPersistenceConflictError();
      const saved = { ...input, version: (current?.version ?? 0) + 1 } as PostgresVersionedDocument<T>;
      this.rows.set(key, structuredClone(saved) as PostgresVersionedDocument<unknown>);
      return saved;
    },
    listDocuments: async <T>(tenantId: string, kind: string, scopeId: string) => {
      const values: PostgresVersionedDocument<T>[] = [];
      for (const row of this.rows.values()) {
        if (row.tenantId === tenantId && row.kind === kind && row.scopeId === scopeId) {
          values.push(row as PostgresVersionedDocument<T>);
        }
      }
      return values;
    },
    deleteDocument: async (input: { readonly tenantId: string; readonly kind: string; readonly scopeId: string;
      readonly recordId: string; readonly expectedVersion: number }) => {
      const key = this.key(input.tenantId, input.kind, input.scopeId, input.recordId);
      const current = this.rows.get(key);
      if (current?.version !== input.expectedVersion) return false;
      this.rows.delete(key);
      return true;
    },
  } as unknown as PostgresAiPersistence;
}

function entry(id: string, enqueuedAt: string, logicalRequestId?: string): AIRuntimeUsageOutboxEntry {
  return { receipt: receipt(id, logicalRequestId), enqueuedAt, attempts: 0 };
}

describe("Postgres assistant persistence foundation", () => {
  it("retains newer turns and read completion against delayed activity writers", async () => {
    const documents = new MemoryDocuments();
    const first = new PostgresConversationActivityStore(documents.persistence, "tenant", "user");
    const second = new PostgresConversationActivityStore(documents.persistence, "tenant", "user");
    const turn = { conversationId: "conversation", turnId: "first", turnRevision: 2 };
    await first.upsert({ ...turn, turnStatus: "running", unread: false });
    await second.upsert({ ...turn, turnStatus: "completed", unread: true });
    await first.markRead("conversation");
    await Promise.all([
      first.upsert({ ...turn, turnStatus: "running", unread: false, summary: "Late progress" }),
      second.upsert({ ...turn, turnStatus: "completed", unread: true }),
    ]);
    expect(await first.list()).toEqual([expect.objectContaining({ turnStatus: "completed", unread: false })]);
    await second.upsert({ ...turn, turnId: "second", turnRevision: 20, turnStatus: "running", unread: false });
    await first.upsert({ ...turn, turnStatus: "completed", unread: true });
    expect(await first.list()).toEqual([expect.objectContaining({ turnId: "second", turnStatus: "running", unread: false })]);
  });

  it("does not let an old acknowledgement clear a newer unread result", async () => {
    const documents = new MemoryDocuments();
    const store = new PostgresConversationActivityStore(documents.persistence, "tenant", "user");
    const read = await store.upsert({ conversationId: "conversation", turnId: "first", turnRevision: 2,
      turnStatus: "error", unread: true });
    const next = await store.upsert({ ...read, turnId: "second", turnRevision: 9 });
    expect(await store.markRead("conversation", read)).toMatchObject({ turnId: "second", unread: true });
    expect(await store.markRead("conversation", next)).toMatchObject({ turnStatus: "error", unread: false });
    expect(await store.list()).toEqual([expect.objectContaining({ unread: false, turnStatus: "error" })]);
  });

  it("retains usage admission decisions with durable idempotency", async () => {
    let providerCalls = 0;
    let retained: unknown;
    const persistence = {
      async getOrCreateIdempotent(input: { readonly execute: () => Promise<unknown> }) {
        if (retained !== undefined) return { status: "idempotent" as const, value: retained };
        retained = await input.execute();
        return { status: "created" as const, value: retained };
      },
    } as unknown as PostgresAiPersistence;
    const store = new PostgresAIRuntimeUsageAdmissionStore(persistence, "tenant-1", "user-1", {
      async admit(input) { providerCalls += 1; return { contract_version: "v1", replayed: false,
        request: { id: input.idempotency_key, status: "observing", project_id: "project", capability_id: "",
          service_id: "service", environment: "prod", provider: input.provider, model: input.model },
        policy_decision: { id: "decision", policy_id: null, policy_version: null, enforcement_mode: "observe",
          decision: "allow", reason_code: "observe", created_at: "2026-09-02T00:00:00.000Z" }, reservation: null }; },
      async settle() { throw new Error("not used"); },
    });
    const input = { idempotency_key: "turn-1:admission", provider: "openai", model: "gpt-test" };

    expect((await store.admit(input)).replayed).toBe(false);
    expect((await store.admit(input)).replayed).toBe(true);
    expect(providerCalls).toBe(1);
  });

  it("assembles every production store only after a trusted scope is supplied", () => {
    const pool: PostgresPoolLike = {
      async query<TRow extends Record<string, unknown>>() {
        return { rows: [] as TRow[], rowCount: 0 };
      },
      async connect() { throw new Error("not used during assembly"); },
    };
    const configured = postgres(pool, { attachmentLimits: {
      maximumBytes: 1024, acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60_000,
    } });
    const scoped = configured.forScope(
      { tenantId: "tenant-a", scopeId: "user-a" },
      { createConversationId: () => "conversation-a" as never },
    );

    expect(scoped.persistence).toBe(configured.persistence);
    expect(scoped.durableTurns.tenantId).toBe("tenant-a");
    expect(scoped.activity.scopeId).toBe("user-a");
    expect(scoped.attachmentMetadata.scopeId).toBe("user-a");
    expect(scoped.usageOutbox.scopeId).toBe("user-a");
    expect(scoped.usageReceiptSink).toBeNull();
  });

  it("adapts a pg-compatible pool and releases committed and rolled-back transactions", async () => {
    const commands: string[] = [];
    let releases = 0;
    const client: PostgresPoolClientLike = {
      async query<TRow extends Record<string, unknown>>(text: string) {
        commands.push(text);
        return { rows: [] as TRow[], rowCount: null };
      },
      release() { releases += 1; },
    };
    const pool: PostgresPoolLike = {
      async query<TRow extends Record<string, unknown>>() {
        return { rows: [] as TRow[], rowCount: null };
      },
      async connect() { return client; },
    };
    const sql = createPostgresSqlClientFromPool(pool);

    await sql.transaction(async (transaction) => {
      expect((await transaction.query("SELECT 1")).rowCount).toBe(0);
    });
    await expect(sql.transaction(async () => { throw new Error("operation failed"); }))
      .rejects.toThrow("operation failed");

    expect(commands).toEqual(["BEGIN", "SELECT 1", "COMMIT", "BEGIN", "ROLLBACK"]);
    expect(releases).toBe(2);
  });

  it("retains retryable receipts durably, dead-letters permanent failures, and acknowledges delivery", async () => {
    const documents = new MemoryDocuments();
    const outbox = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    await outbox.enqueue(entry("receipt-later", "2026-09-02T02:00:00.000Z"));
    await outbox.enqueue(entry("receipt-first", "2026-09-02T01:00:00.000Z"));
    await outbox.enqueue(entry("receipt-first", "2026-09-02T03:00:00.000Z"));

    expect((await outbox.pending(10)).map((value) => value.receipt.usage_receipt_id))
      .toEqual(["receipt-first", "receipt-later"]);
    await outbox.failed("receipt-first", { code: "offline", retryable: true });
    expect((await outbox.pending(10))[0]).toMatchObject({ attempts: 1 });
    await outbox.failed("receipt-first", { code: "invalid_receipt", retryable: false });
    expect((await outbox.pending(10)).map((value) => value.receipt.usage_receipt_id))
      .toEqual(["receipt-later"]);
    await outbox.acknowledge("receipt-later");
    expect(await outbox.pending(10)).toEqual([]);
  });

  it("retains delivered identities across replay and ignores late delivery failures", async () => {
    const documents = new MemoryDocuments();
    const outbox = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    const receipt = entry("receipt-delivered", "2026-09-02T01:00:00.000Z");
    await outbox.enqueue(receipt);
    await outbox.acknowledge("receipt-delivered");
    const restarted = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    await restarted.enqueue(receipt);
    await restarted.failed("receipt-delivered", { code: "late-network-error", retryable: true });
    await restarted.acknowledge("receipt-delivered");
    expect(await restarted.pending(10)).toEqual([]);
    await expect(restarted.enqueue(entry("receipt-delivered", receipt.enqueuedAt, "different-request")))
      .rejects.toBeInstanceOf(PostgresPersistenceConflictError);
  });

  it("retries a lost telemetry acknowledgement with the same receipt and suppresses later replay", async () => {
    const documents = new MemoryDocuments();
    const outbox = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    const accepted = new Set<string>();
    const payloads: unknown[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      payloads.push(body);
      const id = body.receipts[0].usage_receipt_id;
      const duplicate = accepted.has(id);
      accepted.add(id);
      if (!duplicate) throw new Error("Acknowledgement lost after acceptance");
      return new Response(JSON.stringify({ accepted_count: 0, duplicate_count: 1 }), { status: 202 });
    });
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.test", token: "test-token",
      serviceEnvId: "service-env-1", retryLimit: 0, fetch: fetcher });
    const sink = createAIRuntimeUsageReceiptSink(client, outbox);
    await sink.capture(receipt("receipt-network"));
    await sink.flush();
    expect((await outbox.pending(10))[0]?.attempts).toBe(1);
    await sink.flush();
    expect(await outbox.pending(10)).toEqual([]);
    const restarted = createAIRuntimeUsageReceiptSink(client,
      new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis"));
    await restarted.capture(receipt("receipt-network"));
    await restarted.flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(accepted.size).toBe(1);
  });

  it("rejects reuse of one receipt identity for different usage", async () => {
    const documents = new MemoryDocuments();
    const outbox = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    await outbox.enqueue(entry("receipt-conflict", "2026-09-02T01:00:00.000Z"));
    await expect(outbox.enqueue(entry(
      "receipt-conflict",
      "2026-09-02T01:00:00.000Z",
      "different-logical-request",
    ))).rejects.toBeInstanceOf(PostgresPersistenceConflictError);
  });
});
