import { createHash } from "node:crypto";
import { parseConversationEvent, type ConversationEventPayload } from "../conversation/events.js";
import { ConversationEventStoreConflictError, type ConversationEventStore, type ConversationEventCursor } from "../conversation/event-store.js";
import { jsonValuesEqual } from "../json-equality.js";

type ToolLifecyclePayload = Extract<ConversationEventPayload, { type:
  "tool_call.requested" | "tool_call.discovered" | "tool_call.started" |
  "tool_call.approval_required" | "tool_call.result_recorded" }>;

/** Recovery must stop rather than replace immutable evidence or expose a
 * formerly authorized result after fresh admission has denied its reuse. */
export class ToolLifecycleConflictError extends TypeError {
  constructor() {
    super("Tool lifecycle identity conflicts with recorded evidence");
    this.name = "ToolLifecycleConflictError";
  }
}

/** Records server-owned tool evidence once, even across execution replay and concurrent writers. */
export async function recordToolLifecycle(
  store: ConversationEventStore,
  conversationId: string,
  payload: ToolLifecyclePayload,
): Promise<void> {
  const identity = createHash("sha256").update(JSON.stringify([
    conversationId, payload.turn_id, payload.tool_call_id, payload.type,
  ])).digest("hex");
  const eventId = `tool-lifecycle:${identity}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let cursor: ConversationEventCursor | null = null;
    let revision: Awaited<ReturnType<ConversationEventStore["getLatestRevision"]>>;
    for (;;) {
      const retained = await store.read({ conversationId: conversationId as never, limit: 500,
        ...(cursor === null ? {} : { after: { cursor } }) });
      revision = retained.latestRevision;
      const existing = retained.entries.find(({ event }) => event.event_id === eventId);
      if (existing) {
        if (!jsonValuesEqual(existing.event.payload, payload)) throw new ToolLifecycleConflictError();
        return;
      }
      if (!retained.hasMore) break;
      if (retained.nextCursor === null || retained.nextCursor === cursor) throw new Error("Tool lifecycle history did not advance");
      cursor = retained.nextCursor;
    }
    try {
      await store.append({ conversationId: conversationId as never, expectedRevision: revision,
        events: [parseConversationEvent({ version: 1, event_id: eventId, conversation_id: conversationId,
          revision: (revision ?? 0) + 1, occurred_at: new Date().toISOString(),
          actor: { type: "tool" }, source: { type: "runtime" }, payload })] });
      return;
    } catch (cause) {
      if (!(cause instanceof ConversationEventStoreConflictError) ||
        cause.code !== "revision_conflict" && !(cause.code === "idempotency_conflict" && cause.identifier === eventId)) throw cause;
    }
  }
  throw new Error("Tool lifecycle could not be recorded after concurrent updates");
}
