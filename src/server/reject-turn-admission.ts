import { createHash } from "node:crypto";
import type { ConversationEventStore } from "../conversation/event-store.js";
import type { ChatRequest } from "../protocol.js";
import { validateSavedApplicationTurnStart } from "../sync/durable-application-adapter.js";
import type { DurableApplicationTurnStore } from "../transports/durable.js";
import type { StartTurnInput, TransportError } from "../transports/types.js";

/** Trusted gateway rejection only. Caller must independently authenticate and
 * authorize this conversation. Atomic create fences a concurrent/late start;
 * an existing execution (even uncertain) is never overwritten or cancelled. */
export async function rejectUnstartedTurn(input: {
  start: StartTurnInput<ChatRequest>;
  error: TransportError;
  events: ConversationEventStore;
  turns: DurableApplicationTurnStore;
}): Promise<boolean> {
  const { start, error, events, turns } = input;
  if (error.retryable || !["unauthenticated", "forbidden"].includes(error.code)) return false;
  for (const id of [start.conversationId, start.conversationTurnId, start.mutationId, start.idempotencyKey]) {
    if (typeof id !== "string" || !id || id.length > 512 || Array.from(id).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  }
  const turn = await validateSavedApplicationTurnStart(start, events);
  if (!["queued", "running"].includes(turn.status) || turn.cancellation_status === "requested") return false;
  const now = new Date().toISOString();
  // Same identity/fingerprint as ordinary durable admission. A future explicit
  // retry replays this terminal result, without dispatching provider work.
  const result = await turns.create({ schemaVersion: 1, conversationId: start.conversationId,
    turnId: start.conversationTurnId, mutationId: start.mutationId, idempotencyKey: start.idempotencyKey,
    requestFingerprint: createHash("sha256").update(JSON.stringify(start.request)).digest("hex"),
    request: start.request, admissionRejected: true, delegateTurnId: null, delegateStartAttempted: false,
    status: "failed", attempt: 0, events: [],
    terminal: { status: "failed", error, checkpoint: {
      lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null,
    } }, cancellation: null, lease: null, createdAt: now, updatedAt: now });
  return result.status !== "conflict" && result.document.record.admissionRejected === true;
}
