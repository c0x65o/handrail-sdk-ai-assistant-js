import type { ConversationEvent, ConversationId } from "./events.js";
import type { ConversationEventCursor, ConversationEventStore } from "./event-store.js";

/** Find canonical evidence without assuming that an event-store read is unbounded. */
export async function findConversationEvent(
  eventStore: ConversationEventStore,
  conversationId: ConversationId,
  matches: (event: ConversationEvent) => boolean,
): Promise<ConversationEvent | null> {
  let cursor: ConversationEventCursor | null = null;
  const seenCursors = new Set<ConversationEventCursor>();
  for (;;) {
    const page = await eventStore.read({ conversationId, limit: 500,
      ...(cursor === null ? {} : { after: { cursor } }) });
    const match = page.entries.find(({ event }) => event.conversation_id === conversationId && matches(event))?.event;
    if (match) return match;
    if (!page.hasMore) return null;
    if (page.nextCursor === null || seenCursors.has(page.nextCursor)) {
      throw new TypeError("The saved conversation history did not advance while verifying canonical evidence.");
    }
    cursor = page.nextCursor;
    seenCursors.add(cursor);
  }
}
