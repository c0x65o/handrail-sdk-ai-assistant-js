import { describe, expect, it, vi } from "vitest";
import { createDiagnosedPostgresSqlClient, PostgresAiPersistence, PostgresOpenAIResponsesContinuationStore, PostgresPersistenceConflictError, handrailPostgresSchemaV1, type PostgresSqlClient } from "../src/postgres/index.js";

describe("Postgres reference persistence", () => {
  it("uses tenant-scoped transactions and contiguous event revisions", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      void values;
      return text.includes("ORDER BY handrail_ai_events.revision DESC")
        ? { rows: [{ revision: "4" }], rowCount: 1 } : { rows: [], rowCount: 1 };
    });
    const client: PostgresSqlClient = { query: query as unknown as PostgresSqlClient["query"], transaction: async (operation) => operation(client) };
    const persistence = new PostgresAiPersistence(client);
    const events = await persistence.appendEvents({ tenantId: "tenant-1", conversationId: "conversation-1", expectedRevision: 4, events: [
      { event_id: "event-5", revision: 5, type: "message" }, { event_id: "event-6", revision: 6, type: "message" },
    ] });
    expect(events).toHaveLength(2);
    expect(query.mock.calls.some(([sql, values]) => String(sql).includes("tenant_id=$1") && (values as unknown[])[0] === "tenant-1")).toBe(true);
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO handrail_ai_events"))).toHaveLength(2);
    const lockCall = query.mock.calls.find(([sql]) => String(sql).includes("pg_advisory_xact_lock"));
    expect(lockCall?.[1]).toEqual(["8:tenant-1|14:conversation-1"]);
    expect(String(lockCall?.[1]?.[0])).not.toContain("\0");
  });

  it("fails a stale document CAS without overwriting", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      void values;
      return text.includes("SELECT version::text")
        ? { rows: [{ version: "3" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    });
    const client: PostgresSqlClient = { query: query as unknown as PostgresSqlClient["query"], transaction: async (operation) => operation(client) };
    await expect(new PostgresAiPersistence(client).compareAndSetDocument({ tenantId: "t", kind: "approval", scopeId: "c", recordId: "p", expectedVersion: 2, value: { status: "approved" } }))
      .rejects.toBeInstanceOf(PostgresPersistenceConflictError);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO handrail_ai_documents"))).toBe(false);
  });

  it("ships schema for every durable domain", () => {
    expect(handrailPostgresSchemaV1.join(" ")).toContain("handrail_ai_tool_ledger");
  });

  it("diagnoses persistence without exposing SQL or parameter payloads", async () => {
    const diagnostics: import("../src/index.js").AiDiagnosticEvent[] = [];
    const secret = "private prompt and credential";
    const failure = new Error("database unavailable");
    const client: PostgresSqlClient = {
      query: vi.fn(async () => { throw failure; }) as unknown as PostgresSqlClient["query"],
      transaction: async (operation) => operation(client),
    };
    const diagnosed = createDiagnosedPostgresSqlClient(client, (event) => diagnostics.push(event));
    await expect(diagnosed.query("SELECT secret FROM private WHERE value=$1", [secret]))
      .rejects.toBe(failure);
    expect(diagnostics).toEqual([
      expect.objectContaining({ domain: "persistence", operation: "postgres_query", phase: "started" }),
      expect.objectContaining({ domain: "persistence", operation: "postgres_query", phase: "failed", cause: failure }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain("SELECT secret");
  });

  it("durably retains idempotent OpenAI store:false continuation items", async () => {
    let stored: { version: string; payload: unknown } | undefined;
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (text.startsWith("SELECT version::text AS version,payload")) {
        return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
      }
      if (text.startsWith("SELECT version::text AS version")) {
        return { rows: stored ? [{ version: stored.version }] : [], rowCount: stored ? 1 : 0 };
      }
      if (text.startsWith("INSERT INTO handrail_ai_documents")) {
        stored = { version: String(values?.[4]), payload: JSON.parse(String(values?.[5])) };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const client: PostgresSqlClient = { query: query as unknown as PostgresSqlClient["query"],
      transaction: async (operation) => operation(client) };
    const store = new PostgresOpenAIResponsesContinuationStore({
      persistence: new PostgresAiPersistence(client), tenantId: "tenant-a", scopeId: "spartan-aegis",
    });
    const record = { requestId: "response-1", inputItems: [{ type: "reasoning", encrypted_content: "opaque" }] };
    await store.save(record);
    await store.save(record);
    await expect(store.load("response-1")).resolves.toEqual(record);
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO handrail_ai_documents"))).toHaveLength(1);
    await expect(store.save({ ...record, inputItems: [{ type: "reasoning", encrypted_content: "different" }] }))
      .rejects.toBeInstanceOf(PostgresPersistenceConflictError);
  });
});
