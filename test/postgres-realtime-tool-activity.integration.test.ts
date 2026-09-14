import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { DurableRealtimeCallConflictError, PostgresAiPersistence, PostgresRealtimeCallStore,
  PostgresRealtimeToolActivityStore, type PostgresSqlClient } from "../src/postgres/index.js";

it("retains bounded voice tool activity across reloads, duplicate callbacks and termination", async () => {
  const database = new PGlite();
  let now = 1_000;
  let loseAck = false;
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: (operation) => operation(client) };
    return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query, async transaction(operation) {
    const result = await database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">)));
    if (loseAck) { loseAck = false; throw new Error("commit acknowledgement lost"); }
    return result;
  } };
  const persistence = new PostgresAiPersistence(sql);
  const calls = () => new PostgresRealtimeCallStore(persistence, "environment", "owner", { clock: () => now, leaseMs: 1_000 });
  const activity = () => new PostgresRealtimeToolActivityStore(calls(), "voice", () => now);
  const input = { workerId: "worker", toolCallId: "read-products", name: "products_list", status: "running" as const };
  try {
    await persistence.migrate();
    await calls().admit({ callId: "voice", conversationId: "conversation", workerId: "worker", fingerprint: "settings" });
    await expect(activity().record(input)).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await calls().beginCreation("voice", "worker");
    await calls().attachProviderCall("voice", "worker", "private-provider-reference");
    await Promise.all([activity().record(input), activity().record(input)]);
    expect(await activity().summary()).toEqual({ total: 1, running: 1, completed: 0, failed: 0 });
    await expect(activity().record({ ...input, name: "different_tool" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(activity().record({ ...input, workerId: "other-worker" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(activity().record({ ...input, toolCallId: "phantom", status: "completed" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    loseAck = true;
    await expect(activity().record({ ...input, status: "completed" })).rejects.toThrow("acknowledgement lost");
    await activity().record({ ...input, status: "completed" });
    expect((await activity().record(input)).status).toBe("completed");
    expect((await activity().record({ ...input, status: "waiting_for_approval" })).status).toBe("completed");
    await expect(activity().record({ ...input, status: "failed" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await activity().record({ ...input, toolCallId: "update-product" });
    await activity().record({ ...input, toolCallId: "update-product", status: "waiting_for_approval" });
    expect(await activity().get("update-product")).toMatchObject({ status: "waiting_for_approval" });
    expect(await activity().summary()).toEqual({ total: 2, running: 0, waitingForApproval: 1, completed: 1, failed: 0 });
    expect(await activity().get("missing")).toBeNull();
    await activity().record({ ...input, toolCallId: "unresolved-product" });
    expect(await activity().readState()).toMatchObject({ unread: false, readToken: null });
    await calls().requestEnd("voice");
    await calls().confirmEnded("voice", "private-provider-reference");
    const firstView = await activity().readState();
    expect(firstView.unread).toBe(true);
    expect(firstView.readToken).not.toBeNull();
    await expect(activity().markRead({ ...firstView.readToken!, callId: "other-call" })).rejects.toThrow("read token");
    await expect(activity().markRead({ ...firstView.readToken!, callVersion: firstView.call.recordVersion + 1 }))
      .rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(activity().markRead({ ...firstView.readToken!, completed: 3 })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(activity().markRead({ ...firstView.readToken!, scopeBinding: 'different-owner-scope' })).rejects.toThrow('read token');
    await Promise.all([activity().markRead(firstView.readToken!), activity().markRead(firstView.readToken!)]);
    expect((await activity().readState()).unread).toBe(false);
    now += 100;
    await activity().record({ ...input, toolCallId: "update-product", status: "failed" });
    expect((await activity().readState()).unread).toBe(true);
    expect((await activity().markRead(firstView.readToken!)).unread).toBe(true);
    const latestView = await activity().readState();
    loseAck = true;
    await expect(activity().markRead(latestView.readToken!)).rejects.toThrow("acknowledgement lost");
    expect((await activity().markRead(latestView.readToken!)).unread).toBe(false);
    expect((await activity().markRead(firstView.readToken!)).unread).toBe(false);

    await expect(activity().record({ ...input, toolCallId: "after-end" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    expect(await activity().summary()).toEqual({ total: 3, running: 1, completed: 1, failed: 1 });
    const first = await activity().list({ limit: 2 });
    const second = await activity().list({ limit: 2, afterToolCallId: first.nextToolCallId! });
    expect(second.nextToolCallId).toBeNull();
    expect(new Set([...first.tools, ...second.tools].map((tool) => tool.toolCallId)).size).toBe(3);
    expect(JSON.stringify([...first.tools, ...second.tools])).not.toContain("private-provider-reference");
    expect(Object.keys(first.tools[0]!).sort()).toEqual(["schemaVersion", "toolCallId", "name", "status", "startedAt", "updatedAt"].sort());
    await expect(activity().list({ limit: 101 })).rejects.toThrow("page size");
    const foreign = new PostgresRealtimeToolActivityStore(new PostgresRealtimeCallStore(persistence, "environment", "other-owner"), "voice");
    await expect(foreign.summary()).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(foreign.list()).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await calls().admit({ callId: "other-call", conversationId: "conversation", workerId: "worker", fingerprint: "settings" });
    expect(await new PostgresRealtimeToolActivityStore(calls(), "other-call").summary())
      .toEqual({ total: 0, running: 0, completed: 0, failed: 0 });
  } finally { await database.close(); }
}, 30_000);
