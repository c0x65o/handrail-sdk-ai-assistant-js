import { expect, it, vi } from "vitest";
import { InMemoryConversationEventStore, type ConversationEventCursor } from "../src/conversation/event-store.js";
import { parseConversationEvent, type ConversationId } from "../src/conversation/events.js";
import { findConversationEvent } from "../src/conversation/find-event.js";

const conversationId = "conversation-1" as ConversationId;

it.each([[null], ["cursor-1"], ["cursor-1", "cursor-2"]])(
  "rejects incomplete history whose pagination cannot advance: %j", async (...cursors) => {
    const store = new InMemoryConversationEventStore();
    let reads = 0;
    vi.spyOn(store, "read").mockImplementation(async () => ({
      entries: [], hasMore: true, latestRevision: null,
      nextCursor: cursors[reads++ % cursors.length] as ConversationEventCursor | null,
    }));
    await expect(findConversationEvent(store, conversationId, () => false))
      .rejects.toThrow("The saved conversation history did not advance");
    expect(reads).toBeLessThanOrEqual(cursors.length + 1);
  });

it("does not accept evidence from another conversation", async () => {
  const store = new InMemoryConversationEventStore();
  const event = parseConversationEvent({ version: 1, event_id: "foreign-evidence", conversation_id: "other-conversation",
    revision: 1, occurred_at: "2026-09-07T00:00:00Z", actor: { type: "user" }, source: { type: "sync" },
    payload: { type: "message.created", message_id: "message-1", role: "user", content: [{ type: "text", text: "Hello" }] } });
  vi.spyOn(store, "read").mockResolvedValue({ entries: [{ event, cursor: "cursor-1" as ConversationEventCursor }],
    nextCursor: "cursor-1" as ConversationEventCursor, hasMore: false, latestRevision: event.revision });
  expect(await findConversationEvent(store, conversationId, (candidate) => candidate.event_id === event.event_id)).toBeNull();
});
