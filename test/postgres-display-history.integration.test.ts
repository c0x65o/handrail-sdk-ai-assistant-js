import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseConversationEvent, createInitialConversationState, reduceConversationEvent, type ConversationEvent } from "../src/index.js";
import { PostgresAiPersistence, PostgresConversationEventStore, PostgresConversationDisplayHistory,
  deletePostgresConversationHistory, type PostgresSqlClient } from "../src/postgres/index.js";
import { assistantToolArgumentReference } from "../src/conversation/approval-arguments.js";

const database = new PGlite();
const statements: { sql: string; values: readonly unknown[]; rows: readonly Record<string, unknown>[] }[] = [];
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    const result = await db.query<T>(sql, [...values]);
    statements.push({ sql, values, rows: result.rows });
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) };
  return client;
};
const client: PostgresSqlClient = { query: adapt(database).query,
  transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = new PostgresAiPersistence(client);
beforeAll(async () => { await persistence.migrate(); });
afterAll(async () => { await database.close(); });
const authorized = vi.fn(async (conversation: string) => { void conversation; });
const display = (tenant = "tenant", scope = "scope") => new PostgresConversationDisplayHistory(client, tenant, scope, authorized);
function events(conversation: string, payloads: readonly Record<string, unknown>[], start = 1): ConversationEvent[] {
  return payloads.map((payload, index) => parseConversationEvent({ version: 1, event_id: `${conversation}-${start + index}`,
    conversation_id: conversation, revision: start + index, occurred_at: new Date(Date.UTC(2026, 8, 1, 0, 0, start + index)).toISOString(),
    actor: { type: "system" }, source: { type: "runtime" }, payload }));
}
function messages(count: number, start = 1) {
  return Array.from({ length: count }, (_, index) => ({ type: "message.created", message_id: `message-${index + start}`,
    role: "user", content: [{ type: "text", text: `Message ${index + start}` }] }));
}
async function append(conversation: string, payloads: readonly Record<string, unknown>[], start = 1, tenant = "tenant") {
  const batch = events(conversation, payloads, start);
  await new PostgresConversationEventStore(persistence, tenant).append({ conversationId: conversation as never,
    expectedRevision: (start === 1 ? null : start - 1) as never, events: batch });
  return batch;
}

describe("indexed display history", () => {
  it("reviews oversized bound arguments in authorized sections and rejects mismatched or changed bindings", async () => {
    const args = { destination: "person@example.test", body: "🙂\"\\\n".repeat(12_000) };
    await append("large-approval", [
      { type: "tool_call.requested", turn_id: "turn", tool_call_id: "call", name: "send", arguments: args },
      { type: "approval.proposal_created", turn_id: "turn", tool_call_id: "call", tool_name: "send", proposal_id: "approval",
        reviewed_arguments: { type: "opaque_reference", argument_ref: assistantToolArgumentReference(args) }, status: "pending", proposal_version: 1, expires_at: null },
    ]);
    const input = { conversationId: "large-approval", proposalId: "approval", generation: 0 };
    let offset = 0, binding: string | undefined, serialized = "";
    for (;;) {
      statements.length = 0;
      const page = await display().approvalReview({ ...input, offset, ...(binding ? { binding } : {}) });
      if (page.status !== "ready") throw new Error("Expected prepared review");
      expect(statements).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(statements[0]!.rows))).toBeLessThan(65536);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
      expect(page.review).toMatchObject({ proposalVersion: 1, toolName: "send", argumentReference: assistantToolArgumentReference(args) });
      binding = page.review.binding; serialized += page.review.text;
      if (page.review.nextOffset === null) break;
      offset = page.review.nextOffset;
    }
    expect(JSON.parse(serialized)).toEqual(args);
    await expect(display().approvalReview({ ...input, offset: 8192 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(display().approvalReview({ ...input, binding: "0".repeat(64) })).rejects.toMatchObject({ code: "content_changed" });
    await expect(display("other").approvalReview(input)).rejects.toMatchObject({ code: "not_found" });
    await expect(display("tenant", "other-owner").approvalReview({ ...input, binding: binding! })).rejects.toMatchObject({ code: "content_changed" });
    const check = vi.fn(async () => {});
    check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked"));
    await expect(new PostgresConversationDisplayHistory(client, "tenant", "scope", check).approvalReview(input)).rejects.toThrow("revoked");
    await append("large-approval", [{ type: "tool_call.started", turn_id: "turn", tool_call_id: "call" }], 3);
    await expect(display().approvalReview({ ...input, binding: binding! })).rejects.toMatchObject({ code: "content_changed" });
    const changed = await display().approvalReview(input); expect(changed.status).toBe("ready");
    await append("large-approval", [{ type: "approval.proposal_status_changed", proposal_id: "approval", proposal_version: 2, status: "rejected" }], 4);
    await expect(display().approvalReview(input)).rejects.toMatchObject({ code: "content_changed" });
  });

  it("backfills legacy review summaries separately and never substitutes raw arguments for a redacted review", async () => {
    await append("legacy-review", [
      { type: "tool_call.requested", turn_id: "turn", tool_call_id: "call", name: "send", arguments: { private: "never render" } },
      { type: "approval.proposal_created", turn_id: "turn", tool_call_id: "call", tool_name: "send", proposal_id: "approval",
        reviewed_arguments: { type: "redacted_json", value: { destination: "reviewable" } }, status: "pending", proposal_version: 1, expires_at: null },
    ]);
    await client.query(`UPDATE handrail_ai_display_records SET control_payload=NULL WHERE tenant_id='tenant' AND conversation_id='legacy-review'`);
    const input = { conversationId: "legacy-review", proposalId: "approval", generation: 0 };
    statements.length = 0;
    expect(await display().approvalReview(input)).toMatchObject({ status: "preparing", review: null });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.rows[0]!.content).toBeNull();
    expect(await display().backfillReviewControls("legacy-review")).toEqual({ processed: 1, hasMore: true });
    expect(await display().approvalReview(input)).toMatchObject({ status: "preparing" });
    expect(await display().backfillReviewControls("legacy-review")).toEqual({ processed: 1, hasMore: false });
    const page = await display().approvalReview(input);
    if (page.status !== "ready") throw new Error("Expected ready");
    expect(JSON.parse(page.review.text)).toEqual({ destination: "reviewable" });
    expect(JSON.stringify(page)).not.toContain("never render");
    await append("legacy-review", [{ type: "conversation.cleared" }], 3);
    await expect(display().approvalReview(input)).rejects.toMatchObject({ code: "stale_cursor" });
    expect(await display().backfillReviewControls("legacy-review")).toEqual({ processed: 0, hasMore: false });
  });

  it("refuses a tool whose recorded argument reference does not match its proposal", async () => {
    await append("wrong-review", [
      { type: "tool_call.requested", turn_id: "turn", tool_call_id: "call", name: "send", arguments: { amount: 100 } },
      { type: "approval.proposal_created", turn_id: "turn", tool_call_id: "call", tool_name: "send", proposal_id: "approval",
        reviewed_arguments: { type: "opaque_reference", argument_ref: assistantToolArgumentReference({ amount: 1 }) }, status: "pending", proposal_version: 1, expires_at: null },
    ]);
    statements.length = 0;
    await expect(display().approvalReview({ conversationId: "wrong-review", proposalId: "approval", generation: 0 })).rejects.toMatchObject({ code: "content_changed" });
    expect(statements[0]!.rows[0]!.content).toBeNull();
  });

  it("loads bounded active/latest/requested controls without reading turn bodies or canonical history", async () => {
    await append("controls", [messages(1)[0]!,
      { type: "turn.started", turn_id: "old", input_message_ids: ["message-1"] },
      { type: "turn.completed", turn_id: "old", output_message_ids: [], outcome: "stop" },
      ...messages(1, 2),
      { type: "turn.started", turn_id: "active", input_message_ids: ["message-2"] },
    ]);
    // A very large complete turn record must not make controls hydrate it.
    const huge = JSON.stringify({ retry_history: Array.from({ length: 100_000 }, (_, attempt) => ({ attempt })) });
    await client.query(`UPDATE handrail_ai_display_records SET payload=$3,payload_bytes=$4
      WHERE tenant_id='tenant' AND conversation_id=$1 AND kind='turn' AND record_id=$2`,
    ["controls", "active", huge, Buffer.byteLength(huge)]);
    statements.length = 0;
    const control = await display().control({ conversationId: "controls", turnId: "old" });
    expect(control).toMatchObject({ status: "ready", activeTurnId: "active",
      activeTurn: { turnId: "active", status: "queued" }, latestTurn: { turnId: "active" },
      requestedTurn: { turnId: "old", status: "completed", remoteMayStillBeRunning: false } });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).not.toMatch(/\br\.payload\b|checkpoint|SELECT payload/u);
    expect(Buffer.byteLength(JSON.stringify(statements[0]!.rows))).toBeLessThan(3000);
    expect(Buffer.byteLength(JSON.stringify(control))).toBeLessThan(2048);
    expect((await display().control({ conversationId: "controls", turnId: "missing" })).requestedTurn).toBeNull();
    expect((await display("different").control({ conversationId: "controls" })).latestTurn).toBeNull();
    await append("controls", [{ type: "conversation.cleared" }], 6);
    expect(await display().control({ conversationId: "controls", turnId: "old" })).toMatchObject({
      generation: 6, activeTurn: null, latestTurn: null, requestedTurn: null });
  });

  it("discovers old pending approvals without loading their messages and pages decisions independently", async () => {
    const proposal = (id: string, status = "pending") => ({ type: "approval.proposal_created", turn_id: "old-turn",
      tool_call_id: `tool-${id}`, tool_name: "save", proposal_id: id, reviewed_arguments: { type: "redacted_json", value: { id } },
      status, proposal_version: 1, expires_at: null });
    await append("pending-inbox", [
      ...messages(1), { type: "turn.started", turn_id: "old-turn", input_message_ids: ["message-1"] },
      ...["one", "two", "three"].flatMap(id => [
        { type: "tool_call.requested", turn_id: "old-turn", tool_call_id: `tool-${id}`, name: "save", arguments: { id } }, proposal(id)]),
      { type: "turn.completed", turn_id: "old-turn", output_message_ids: [], outcome: "stop" },
      ...messages(100, 2),
    ]);
    expect((await display().page({ conversationId: "pending-inbox" })).records).toHaveLength(30);
    statements.length = 0;
    expect(await display().control({ conversationId: "pending-inbox" })).toMatchObject({ hasPendingApprovals: true });
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0]!.rows)).not.toContain("reviewed_arguments");
    const input = { conversationId: "pending-inbox", view: { type: "pending_approvals" as const }, limit: 2 };
    statements.length = 0;
    const first = await display().page(input);
    expect(first.records.map(record => record.id)).toEqual(["two", "three"]);
    expect(first.records.every(record => record.kind === "approval")).toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).not.toMatch(/checkpoint|SELECT payload FROM handrail_ai_events/u);
    const second = await display().page({ ...input, cursor: first.nextCursor! });
    expect(second.records.map(record => record.id)).toEqual(["one"]);
    expect(second.nextCursor).toBeNull();
    await expect(display("tenant", "other").page({ ...input, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(display().page({ ...input, view: { type: "messages" }, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await display("other").page(input)).records).toEqual([]);
    const review = await display().page({ conversationId: input.conversationId, view: { type: "approval", proposalId: "one" } });
    expect(review.records.map(record => [record.kind, record.id])).toEqual([["tool", "tool-one"], ["approval", "one"]]);
    expect((await display().page({ conversationId: input.conversationId, view: { type: "approval", proposalId: "absent" } })).records).toEqual([]);
    await append("pending-inbox", ["one", "two", "three"].map(proposal_id => ({ type: "approval.proposal_status_changed",
      proposal_id, proposal_version: 2, status: "rejected" })), 110);
    expect((await display().page(input)).records).toEqual([]);
    expect((await display().control({ conversationId: input.conversationId })).hasPendingApprovals).toBe(false);
    // Review remains available as an audit record, but reflects the current decision.
    expect((await display().page({ conversationId: input.conversationId, view: { type: "approval", proposalId: "one" } }))
      .records.find(record => record.kind === "approval")?.value).toMatchObject({ status: "rejected", proposal_version: 2 });
    await append("pending-inbox", [{ type: "conversation.cleared" }], 113);
    await expect(display().page({ ...input, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "stale_cursor" });
    expect((await display().page({ conversationId: input.conversationId, view: { type: "approval", proposalId: "one" } })).records).toEqual([]);
  });

  it("defers oversized pending proposals and review tools without sending their bodies", async () => {
    const arguments_ = Object.fromEntries([1, 2, 3].map(id => [`notes${id}`, "private-review ".repeat(250)]));
    await append("large-pending", [
      ...messages(1), { type: "turn.started", turn_id: "old", input_message_ids: ["message-1"] },
      { type: "tool_call.requested", turn_id: "old", tool_call_id: "tool", name: "save", arguments: arguments_ },
      { type: "approval.proposal_created", turn_id: "old", tool_call_id: "tool", tool_name: "save", proposal_id: "proposal",
        reviewed_arguments: { type: "redacted_json", value: arguments_ }, status: "pending", proposal_version: 1, expires_at: null },
    ]);
    statements.length = 0;
    expect((await display().control({ conversationId: "large-pending" })).hasPendingApprovals).toBe(true);
    const inbox = await display().page({ conversationId: "large-pending", view: { type: "pending_approvals" }, maximumBytes: 8192 });
    expect(inbox.records).toMatchObject([{ kind: "approval", value: null, deferred: true }]);
    const review = await display().page({ conversationId: "large-pending", view: { type: "approval", proposalId: "proposal" }, maximumBytes: 8192 });
    expect(review.records).toHaveLength(2);
    expect(review.records.every(record => record.deferred && record.value === null)).toBe(true);
    expect(statements).toHaveLength(3);
    expect(JSON.stringify(statements.map(statement => statement.rows))).not.toContain("private-review");
    expect(Buffer.byteLength(JSON.stringify(inbox))).toBeLessThan(8192);
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(8192);
  });

  it("prepares legacy controls in durable bounded steps and reports truncated error summaries", async () => {
    const error = { code: "failure", message: "😀".repeat(1000), retryable: true };
    await append("legacy-controls", [
      ...messages(1),
      { type: "turn.started", turn_id: "first", input_message_ids: ["message-1"] },
      { type: "turn.failed", turn_id: "first", error },
      ...messages(1, 2),
      { type: "turn.started", turn_id: "last", input_message_ids: ["message-2"] },
      { type: "turn.failed", turn_id: "last", error },
    ]);
    const current = await display().control({ conversationId: "legacy-controls", turnId: "first" });
    expect(Array.from(current.latestTurn!.error!.message)).toHaveLength(256);
    expect(current.latestTurn!.error?.messageTruncated).toBe(true);
    await client.query(`UPDATE handrail_ai_display_records SET control_payload=NULL WHERE tenant_id='tenant'
      AND conversation_id='legacy-controls' AND kind='turn'`);
    expect(await display().control({ conversationId: "legacy-controls" })).toMatchObject({ status: "preparing", latestTurn: null });
    expect(await display().backfillControls("legacy-controls", 1)).toEqual({ processed: 1, hasMore: true });
    expect((await display().control({ conversationId: "legacy-controls" })).latestTurn).toEqual(current.latestTurn);
    expect(await display().backfillControls("legacy-controls", 1)).toEqual({ processed: 1, hasMore: false });
    expect(await display().control({ conversationId: "legacy-controls", turnId: "first" })).toEqual(current);
  });

  it("authorizes controls after reads and prevents preparation after deletion", async () => {
    const check = vi.fn(async () => {});
    const scoped = new PostgresConversationDisplayHistory(client, "tenant", "scope", check);
    check.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error("revoked"); });
    await expect(scoped.control({ conversationId: "revoked-controls" })).rejects.toThrow("revoked");
    expect(check).toHaveBeenCalledTimes(2);
    await client.query(`INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload)
      VALUES ('tenant','conversation_deleted','deleted-controls','deleted',1,'{}')`);
    await expect(display().control({ conversationId: "deleted-controls" })).rejects.toMatchObject({ code: "not_found" });
    await expect(display().backfillControls("deleted-controls")).rejects.toMatchObject({ code: "not_found" });
  });

  it("restores an indexed message anchor and pages both directions without gaps or full hydration", async () => {
    await append("anchors", messages(20));
    const anchor = { messageId: "message-8", generation: 0, direction: "newer" as const, inclusive: true };
    statements.length = 0;
    const middle = await display().page({ conversationId: "anchors", limit: 4, anchor });
    expect(middle.records.map(row => row.id)).toEqual([8, 9, 10, 11].map(id => `message-${id}`));
    expect(statements).toHaveLength(1);
    const continuation = await display().page({ conversationId: "anchors", limit: 4, cursor: middle.nextCursor! });
    expect(continuation.records.map(row => row.id)).toEqual([12, 13, 14, 15].map(id => `message-${id}`));
    const older = await display().page({ conversationId: "anchors", limit: 4, anchor: { ...anchor, direction: "older", inclusive: false } });
    expect(older.records.map(row => row.id)).toEqual([4, 5, 6, 7].map(id => `message-${id}`));
    const oldest = await display().page({ conversationId: "anchors", limit: 4, cursor: older.nextCursor! });
    expect(oldest.records.map(row => row.id)).toEqual([1, 2, 3].map(id => `message-${id}`));
    expect(oldest.nextCursor).toBeNull();
    await expect(display().page({ conversationId: "anchors", anchor: { ...anchor, messageId: "missing" } }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(display().page({ conversationId: "anchors", anchor, cursor: middle.nextCursor! }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(display().page({ conversationId: "anchors", anchor, view: { type: "turn", turnId: "turn" } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(display("other").page({ conversationId: "anchors", anchor })).rejects.toMatchObject({ code: "not_found" });
    await append("anchors", [{ type: "conversation.cleared" }], 21);
    await expect(display().page({ conversationId: "anchors", anchor })).rejects.toMatchObject({ code: "stale_cursor" });
  });

  it("returns complete messages, keyset pages, and a stable fence while new messages arrive", async () => {
    await append("pages", messages(12));
    statements.length = 0;
    const first = await display().page({ conversationId: "pages", limit: 5 });
    expect(first).toMatchObject({ status: "ready", generation: 0, revision: 12, canonicalRevision: 12 });
    expect(first.records.map(row => row.id)).toEqual([8, 9, 10, 11, 12].map(id => `message-${id}`));
    expect(first.records[0]).toMatchObject({ deferred: false, value: { content: [{ type: "text", text: "Message 8" }] } });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).not.toContain("SELECT payload FROM handrail_ai_events");
    expect(statements[0]!.sql).not.toContain("checkpoint");
    await append("pages", messages(2, 13), 13);
    const second = await display().page({ conversationId: "pages", limit: 5, cursor: first.nextCursor! });
    expect(second.records.map(row => row.id)).toEqual([3, 4, 5, 6, 7].map(id => `message-${id}`));
    const third = await display().page({ conversationId: "pages", limit: 5, cursor: second.nextCursor! });
    expect(third.records.map(row => row.id)).toEqual(["message-1", "message-2"]);
    expect(third.nextCursor).toBeNull();
    await expect(display("other").page({ conversationId: "pages", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(display("tenant", "other").page({ conversationId: "pages", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(display().page({ conversationId: "elsewhere", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("matches canonical replay for streaming, attachments, citations, tools and approval transitions", async () => {
    const batch = await append("facts", [
      ...messages(1),
      { type: "turn.started", turn_id: "turn", input_message_ids: ["message-1"] },
      { type: "message.text_appended", message_id: "reply", turn_id: "turn", text: "Hello" },
      { type: "message.text_appended", message_id: "reply", turn_id: "turn", text: " world" },
      { type: "message.attachment_referenced", message_id: "reply", attachment: { attachment_id: "att_file", media_type: "image/png" } },
      { type: "tool_call.requested", turn_id: "turn", tool_call_id: "tool", name: "save", arguments: { value: 42 } },
      { type: "approval.proposal_created", turn_id: "turn", tool_call_id: "tool", tool_name: "save", proposal_id: "approval",
        reviewed_arguments: { type: "redacted_json", value: { value: 42 } }, status: "pending", proposal_version: 1, expires_at: null },
      { type: "approval.proposal_status_changed", proposal_id: "approval", proposal_version: 2, status: "confirmed" },
      { type: "tool_call.result_recorded", turn_id: "turn", tool_call_id: "tool", content: [{ type: "text", text: "Saved" }], is_error: false },
      { type: "citation.records_linked", citation_records_version: 1, target: { type: "assistant_message", message_id: "reply" },
        sources: [{ source_id: "source", type: "web", label: "Evidence", locator: "https://example.com/" }],
        citations: [{ citation_id: "citation", source_id: "source", order: 0, target: { type: "assistant_message", message_id: "reply" } }] },
      { type: "turn.completed", turn_id: "turn", output_message_ids: ["reply"], outcome: "stop" },
    ]);
    const canonical = batch.reduce(reduceConversationEvent, createInitialConversationState());
    const page = await display().page({ conversationId: "facts" });
    expect(page.records.map(row => row.value)).toEqual(canonical.messages);
    expect(page.records.map(row => row.turnId)).toEqual(["turn", "turn"]);
    const related = await display().page({ conversationId: "facts", view: { type: "turn", turnId: "turn" } });
    expect(related.records.find(row => row.kind === "turn")?.value).toEqual(canonical.turns[0]);
    expect(related.records.find(row => row.kind === "tool")?.value).toEqual(canonical.tool_calls[0]);
    expect(related.records.find(row => row.kind === "approval")?.value).toEqual(canonical.approval_proposals[0]);
    expect((await display().page({ conversationId: "facts", view: { type: "citations", messageId: "reply" } })).records[0]?.value)
      .toEqual(canonical.citations[0]);
    const source = await display().content({ conversationId: "facts", generation: 0, kind: "source", id: "source" });
    expect(JSON.parse(source.text)).toEqual(canonical.citation_sources[0]);
    statements.length = 0;
    const contextView = { type: "context" as const, messageIds: ["reply"] };
    const context = await display().page({ conversationId: "facts", view: contextView });
    expect(statements).toHaveLength(1);
    expect(context.records.map(row => row.kind).sort()).toEqual(["approval", "citation", "source", "tool", "turn"]);
    expect(context.records.find(row => row.kind === "source")?.value).toEqual(canonical.citation_sources[0]);
    expect(context.records.find(row => row.kind === "citation")?.value).toEqual(canonical.citations[0]);
    const firstContext = await display().page({ conversationId: "facts", view: contextView, limit: 2 });
    const contextRows = [...firstContext.records];
    let cursor = firstContext.nextCursor;
    while (cursor) {
      const next = await display().page({ conversationId: "facts", view: contextView, limit: 2, cursor });
      contextRows.unshift(...next.records); cursor = next.nextCursor;
    }
    expect(contextRows).toEqual(context.records);
    expect((await display().page({ conversationId: "facts", view: { type: "context", messageIds: ["missing"] } })).records).toEqual([]);
    await expect(display().page({ conversationId: "facts", view: { type: "context", messageIds: Array(101).fill("reply") } }))
      .rejects.toMatchObject({ code: "invalid_input" });
    // An idempotent append cannot append text twice to the materialized record.
    await new PostgresConversationEventStore(persistence, "tenant").append({ conversationId: "facts" as never,
      expectedRevision: null, events: batch });
    expect((await display().page({ conversationId: "facts" })).records).toEqual(page.records);
  });

  it("defers oversized records at the SQL boundary and provides revision-pinned Unicode-safe chunks", async () => {
    const text = "🙂\"\\\n".repeat(12_000);
    await append("large", [{ type: "message.text_appended", message_id: "reply", turn_id: "turn", text }]);
    statements.length = 0;
    const page = await display().page({ conversationId: "large", maximumBytes: 8192 });
    expect(page.records[0]).toMatchObject({ deferred: true, value: null });
    expect(JSON.stringify(page).length).toBeLessThan(8192);
    expect(statements[0]!.rows[0]!.payload).toBeNull();
    const request = { conversationId: "large", generation: 0, kind: "message" as const, id: "reply", revision: 1 };
    let offset: number | null = 0, json = "";
    do {
      const chunk = await display().content({ ...request, offset });
      expect(new TextEncoder().encode(JSON.stringify(chunk)).byteLength).toBeLessThan(64 * 1024);
      json += chunk.text; offset = chunk.nextOffset;
    } while (offset !== null);
    expect(JSON.parse(json).content).toEqual([{ type: "text", text }]);
    let textOffset: number | null = 0, displayed = "";
    do {
      statements.length = 0;
      const chunk = await display().content({ ...request, format: "message-text", offset: textOffset });
      expect(chunk.encoding).toBe("plain-text");
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(64 * 1024);
      expect(statements).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(statements[0]!.rows))).toBeLessThan(64 * 1024);
      displayed += chunk.text; textOffset = chunk.nextOffset;
    } while (textOffset !== null);
    expect(displayed).toBe(text);
    await expect(display().content({ ...request, format: "message-text", kind: "tool" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(display("other").content({ ...request, format: "message-text" })).rejects.toMatchObject({ code: "not_found" });
    await append("large", [{ type: "message.text_appended", message_id: "reply", turn_id: "turn", text: "!" }], 2);
    await expect(display().content({ ...request, offset: 8192 })).rejects.toMatchObject({ code: "content_changed" });
    await expect(display().content({ ...request, format: "message-text", offset: 8192 })).rejects.toMatchObject({ code: "content_changed" });
  });

  it("honors byte budgets without skipping a message at page boundaries", async () => {
    await append("budget", messages(10).map(message => ({ ...message, content: [{ type: "text", text: "a".repeat(3000) }] })));
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await display().page({ conversationId: "budget", maximumBytes: 8192, ...(cursor ? { cursor } : {}) });
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(8192);
      ids.push(...page.records.map(record => record.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(10); expect(ids).toHaveLength(10);
  });

  it("formats oversized tool records in bounded pinned sections without loading record bodies into the server", async () => {
    const arguments_ = { destination: "person@example.test", text: "🙂\"\\\n".repeat(12_000) };
    await append("record-reader", [{ type: "tool_call.requested", turn_id: "turn", tool_call_id: "tool", name: "send_message", arguments: arguments_ }]);
    const page = await display().page({ conversationId: "record-reader", view: { type: "turn", turnId: "turn" } });
    expect(page.records.find(row => row.kind === "tool")).toMatchObject({ deferred: true, value: null });
    const input = { conversationId: "record-reader", generation: 0, kind: "tool" as const, id: "tool", revision: 1, format: "record-text" as const };
    let offset: number | null = 0, whole = "";
    do {
      statements.length = 0;
      const part = await display().content({ ...input, offset });
      expect(part.encoding).toBe("plain-text");
      expect(Array.from(part.text).length).toBeLessThanOrEqual(8192);
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(65536);
      expect(statements).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(statements[0]!.rows))).toBeLessThan(65536);
      whole += part.text; offset = part.nextOffset;
    } while (offset !== null);
    expect(whole).toContain('\n    "');
    expect(JSON.parse(whole).arguments).toEqual(arguments_);
    await expect(display("other").content(input)).rejects.toMatchObject({ code: "not_found" });
    await append("record-reader", [{ type: "tool_call.started", turn_id: "turn", tool_call_id: "tool" }], 2);
    await expect(display().content({ ...input, offset: 8192 })).rejects.toMatchObject({ code: "content_changed" });
    await append("record-reader", [{ type: "conversation.cleared" }], 3);
    await expect(display().content(input)).rejects.toMatchObject({ code: "not_found" });
  });

  it("backs up no request with an implicit replay; backfill resumes after appends and restarts", async () => {
    // A persisted pre-upgrade log has no display projection yet.
    for (const event of events("legacy", messages(7))) await database.query(`INSERT INTO handrail_ai_events
      (tenant_id,conversation_id,revision,event_id,payload) VALUES ('tenant','legacy',$1,$2,$3::jsonb)`,
    [event.revision, event.event_id, JSON.stringify(event)]);
    statements.length = 0;
    expect(await display().page({ conversationId: "legacy" })).toMatchObject({ status: "preparing", records: [], revision: 0, canonicalRevision: 7 });
    expect(statements).toHaveLength(1);
    expect(await display().backfill("legacy", 3)).toEqual({ processed: 3, revision: 3, hasMore: true });
    await append("legacy", messages(1, 8), 8);
    expect((await display().page({ conversationId: "legacy" })).status).toBe("preparing");
    expect(await display().backfill("legacy", 3)).toEqual({ processed: 3, revision: 6, hasMore: true });
    expect(await display().backfill("legacy", 3)).toEqual({ processed: 2, revision: 8, hasMore: false });
    expect((await display().page({ conversationId: "legacy" })).records).toHaveLength(8);
    await append("legacy", messages(1, 9), 9);
    expect((await display().page({ conversationId: "legacy" })).revision).toBe(9);
  });

  it("invalidates cursors and content after clear and prevents resurrection after deletion", async () => {
    await append("clear", messages(4));
    const page = await display().page({ conversationId: "clear", limit: 2 });
    await append("clear", [{ type: "conversation.cleared" }], 5);
    expect(await display().page({ conversationId: "clear" })).toMatchObject({ generation: 5, records: [] });
    await expect(display().page({ conversationId: "clear", cursor: page.nextCursor! })).rejects.toMatchObject({ code: "stale_cursor" });
    await append("clear", messages(1, 10), 6);
    const before = await new PostgresConversationEventStore(persistence, "tenant").read({ conversationId: "clear" as never });
    expect(before.entries).toHaveLength(6); // clear does not truncate canonical audit history
    await deletePostgresConversationHistory({ client, tenantId: "tenant", conversationId: "clear" as never, authorize: async () => {} });
    await expect(display().page({ conversationId: "clear" })).rejects.toMatchObject({ code: "not_found" });
    await expect(display().backfill("clear")).rejects.toMatchObject({ code: "not_found" });
    await expect(append("clear", messages(1))).rejects.toBeDefined();
    expect((await database.query("SELECT 1 FROM handrail_ai_display_records WHERE conversation_id='clear'")).rows).toEqual([]);
  });

  it("checks authorization before reads and again after, and isolates equal IDs in different tenants", async () => {
    await append("isolated", messages(1), 1, "one");
    await append("isolated", [{ ...messages(1)[0]!, content: [{ type: "text", text: "Tenant two" }] }], 1, "two");
    expect((await display("one").page({ conversationId: "isolated" })).records[0]?.value).not.toEqual(
      (await display("two").page({ conversationId: "isolated" })).records[0]?.value);
    statements.length = 0;
    const denied = new PostgresConversationDisplayHistory(client, "one", "scope", async () => { throw new Error("denied"); });
    await expect(denied.page({ conversationId: "isolated" })).rejects.toThrow("denied");
    expect(statements).toHaveLength(0);
    let attempts = 0;
    const revoked = new PostgresConversationDisplayHistory(client, "one", "scope", async () => { if (++attempts > 1) throw new Error("revoked"); });
    await expect(revoked.page({ conversationId: "isolated" })).rejects.toThrow("revoked");
  });

  it("does not serve old content while a legacy writer's clear or deletion is unprojected", async () => {
    await append("legacy-clear", messages(1));
    const request = { conversationId: "legacy-clear", generation: 0, kind: "message" as const, id: "message-1", revision: 1 };
    const clear = events("legacy-clear", [{ type: "conversation.cleared" }], 2)[0]!;
    await database.query(`INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,payload)
      VALUES ('tenant','legacy-clear',2,$1,$2::jsonb)`, [clear.event_id, JSON.stringify(clear)]);
    expect((await display().page({ conversationId: request.conversationId })).status).toBe("preparing");
    await expect(display().content(request)).rejects.toMatchObject({ code: "not_found" });
    await display().backfill(request.conversationId);
    expect((await display().page({ conversationId: request.conversationId })).generation).toBe(2);
    await append("legacy-deleted", messages(1));
    await database.query(`INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload)
      VALUES ('tenant','conversation_deleted','legacy-deleted','deleted',1,'{}')`);
    await expect(display().content({ ...request, conversationId: "legacy-deleted" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("reads only changed records and does not lose updates that move beyond an in-flight page fence", async () => {
    await append("changes", messages(3));
    statements.length = 0;
    expect(await display().changes({ conversationId: "changes", generation: 0, afterRevision: 3 })).toMatchObject({
      status: "ready", throughRevision: 3, records: [], nextCursor: null });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).not.toContain("SELECT payload FROM handrail_ai_events");
    await append("changes", [
      { type: "turn.started", turn_id: "turn", input_message_ids: ["message-3"] },
      { type: "tool_call.requested", turn_id: "turn", tool_call_id: "tool", name: "search", arguments: {} },
      { type: "message.text_appended", message_id: "reply", turn_id: "turn", text: "One" },
      { type: "message.text_appended", message_id: "reply", turn_id: "turn", text: " two" },
    ], 4);
    const first = await display().changes({ conversationId: "changes", generation: 0, afterRevision: 3, limit: 1 });
    expect(first.throughRevision).toBe(7);
    expect(first.records[0]).toMatchObject({ kind: "message", id: "message-3", turnId: "turn", revision: 4 });
    await append("changes", [
      { type: "message.text_appended", message_id: "reply", turn_id: "turn", text: " three" },
      { type: "tool_call.result_recorded", turn_id: "turn", tool_call_id: "tool", content: [{ type: "text", text: "Found" }], is_error: false },
    ], 8);
    const second = await display().changes({ conversationId: "changes", generation: 0, afterRevision: 3, cursor: first.nextCursor! });
    expect(second).toMatchObject({ throughRevision: 7, revision: 9, nextCursor: null });
    expect(second.records.map(record => record.kind)).toEqual(["turn"]);
    const later = await display().changes({ conversationId: "changes", generation: 0, afterRevision: second.throughRevision });
    expect(later.records.map(record => record.kind)).toEqual(["message", "tool"]);
    expect(later.records[0]?.value).toMatchObject({ content: [{ type: "text", text: "One two three" }] });
    expect(later.records[1]?.value).toMatchObject({ name: "search", result: { content: [{ type: "text", text: "Found" }] } });
    await expect(display("tenant", "other").changes({ conversationId: "changes", generation: 0, afterRevision: 3, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(display().page({ conversationId: "changes", cursor: first.nextCursor! })).rejects.toMatchObject({ code: "invalid_input" });
    await append("changes", [{ type: "conversation.cleared" }], 10);
    await expect(display().changes({ conversationId: "changes", generation: 0, afterRevision: 9 })).rejects.toMatchObject({ code: "stale_cursor" });
    expect(await display().changes({ conversationId: "changes", generation: 10, afterRevision: 10 })).toMatchObject({ records: [], throughRevision: 10 });
  });

  it("emits citation removal tombstones without exposing message placeholders as transcript rows", async () => {
    const citation = { type: "citation.records_linked", citation_records_version: 1,
      target: { type: "assistant_message", message_id: "placeholder" },
      sources: [{ source_id: "source", type: "web", label: "Evidence", locator: "https://example.com/" }],
      citations: [{ citation_id: "citation", source_id: "source", order: 0,
        target: { type: "assistant_message", message_id: "placeholder" } }] };
    await append("tombstones", [citation]);
    const initial = await display().changes({ conversationId: "tombstones", generation: 0, afterRevision: 0 });
    expect(initial.records.map(record => record.kind)).not.toContain("message");
    await append("tombstones", [{ ...messages(1)[0]!, message_id: "placeholder" }], 2);
    const changed = await display().changes({ conversationId: "tombstones", generation: 0, afterRevision: 1 });
    expect(changed.records.find(record => record.kind === "citation")).toMatchObject({
      deleted: true, deferred: false, value: null, revision: 2 });
    expect((await display().page({ conversationId: "tombstones", view: { type: "citations", messageId: "placeholder" } })).records).toEqual([]);
    await expect(display().content({ conversationId: "tombstones", generation: 0, kind: "citation", id: "citation" })).rejects.toMatchObject({ code: "not_found" });
    // Canonical reducer ignores conflicting message.created events for already-created messages.
    await append("ignored-create", [{ ...messages(1)[0]!, message_id: "placeholder", role: "assistant" }, citation]);
    await append("ignored-create", [{ ...messages(1)[0]!, message_id: "placeholder", role: "user" }], 3);
    expect((await display().page({ conversationId: "ignored-create", view: { type: "citations", messageId: "placeholder" } })).records).toHaveLength(1);
    // A removed citation identity can be reused within the same atomic event batch.
    const batch = await append("reuse-citation", [citation, { ...messages(1)[0]!, message_id: "placeholder" },
      { ...messages(1)[0]!, message_id: "assistant", role: "assistant" },
      { ...citation, target: { type: "assistant_message", message_id: "assistant" },
        citations: [{ ...citation.citations[0]!, target: { type: "assistant_message", message_id: "assistant" } }] }]);
    const canonical = batch.reduce(reduceConversationEvent, createInitialConversationState());
    expect((await display().page({ conversationId: "reuse-citation", view: { type: "citations", messageId: "assistant" } })).records[0]?.value)
      .toEqual(canonical.citations[0]);
  });

  it("bounds large changed records and advances through metadata-only revisions", async () => {
    await append("changed-large", [{ type: "message.text_appended", message_id: "huge", turn_id: "turn", text: "x".repeat(100_000) },
      { type: "conversation.title_updated", title: "New title" }]);
    const changes = await display().changes({ conversationId: "changed-large", generation: 0, afterRevision: 0, maximumBytes: 8192 });
    expect(changes).toMatchObject({ throughRevision: 2, nextCursor: null, records: [{ deferred: true, value: null }] });
    expect(Buffer.byteLength(JSON.stringify(changes))).toBeLessThan(8192);
    expect(await display().changes({ conversationId: "changed-large", generation: 0, afterRevision: 1 })).toMatchObject({ records: [], throughRevision: 2 });
  });
});
