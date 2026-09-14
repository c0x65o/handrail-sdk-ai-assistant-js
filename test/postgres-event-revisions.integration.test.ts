import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { parseConversationEvent, type ConversationId } from "../src/index.js";
import { PostgresAiPersistence, PostgresConversationEventStore, type PostgresSqlClient } from "../src/postgres/index.js";

it("orders PostgreSQL revisions numerically across 9, 10, 99 and 100", async () => {
  const database = new PGlite();
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: (operation) => operation(client) };
    return client;
  };
  const persistence = new PostgresAiPersistence({ query: adapt(database).query, transaction: (operation) =>
    database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) });
  const conversationId = "numeric-revisions" as ConversationId;
  const store = new PostgresConversationEventStore(persistence, "tenant");
  const event = (revision: number) => parseConversationEvent({ version: 1, event_id: `event-${revision}`,
    conversation_id: conversationId, revision, occurred_at: "2026-09-05T12:00:00Z",
    actor: { type: "system" }, source: { type: "import" },
    payload: { type: "conversation.metadata_updated", metadata: { revision } } });
  try {
    await persistence.migrate();
    expect(await store.read({ conversationId })).toMatchObject({ entries: [], latestRevision: null, hasMore: false, nextCursor: null });
    await store.append({ conversationId, expectedRevision: null,
      events: Array.from({ length: 100 }, (_, index) => event(index + 1)) });
    expect(await store.getLatestRevision(conversationId)).toBe(100);
    const page = await store.read({ conversationId, limit: 10 });
    expect(page.latestRevision).toBe(100); expect(page.entries).toHaveLength(10); expect(page.hasMore).toBe(true);
    expect(page.entries.at(-1)?.event.revision).toBe(10);
    const remaining = await store.read({ conversationId, after: { cursor: page.nextCursor! }, limit: 100 });
    expect(remaining.entries).toHaveLength(90); expect(remaining.latestRevision).toBe(100); expect(remaining.hasMore).toBe(false);
    expect(await store.read({ conversationId, after: { cursor: remaining.nextCursor! } })).toMatchObject({
      entries: [], latestRevision: 100, hasMore: false, nextCursor: null,
    });
    await persistence.appendEvents({ tenantId: "tenant", conversationId, expectedRevision: 100, events: [event(101)] });
    await store.append({ conversationId, expectedRevision: 101 as never, events: [event(102)] });
    expect(await store.getLatestRevision(conversationId)).toBe(102);
    await expect(store.append({ conversationId, expectedRevision: 99 as never, events: [{ ...event(100), event_id: "stale-event" as never }] }))
      .rejects.toMatchObject({ code: "revision_conflict", actualRevision: 102 });
  } finally { await database.close(); }
});
