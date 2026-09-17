import type { ConversationTurnRecord } from "./state.js";
import { parseConversationDisplayPage } from "./display-history.js";

/** Scalar execution controls, never a canonical checkpoint or model input.
 * Arrays of messages, retries and tool results are intentionally absent. */
export interface ConversationDisplayTurnControl {
  readonly turnId: string;
  readonly revision: number;
  readonly status: ConversationTurnRecord["status"];
  readonly remoteMayStillBeRunning: boolean;
  readonly error: { readonly code: string; readonly message: string;
    readonly retryable: boolean; readonly messageTruncated: boolean } | null;
}
export interface ConversationDisplayControlInput {
  readonly conversationId: string;
  /** Verify a specific admitted operation without loading intervening history. */
  readonly turnId?: string;
}
export interface ConversationDisplayControl {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly status: "ready" | "preparing";
  readonly generation: number;
  readonly revision: number;
  readonly canonicalRevision: number;
  /** Absent on older servers. Canonical status, not a timestamp, determines whether a decision is pending. */
  readonly hasPendingApprovals?: boolean;
  readonly activeTurnId: string | null;
  readonly activeTurn: ConversationDisplayTurnControl | null;
  readonly latestTurn: ConversationDisplayTurnControl | null;
  readonly requestedTurn: ConversationDisplayTurnControl | null;
}
export const CONVERSATION_DISPLAY_CONTROL_MAXIMUM_BYTES = 32 * 1024;

export function displayTurnControl(turn: ConversationTurnRecord, revision: number): ConversationDisplayTurnControl {
  const text = turn.error ? Array.from(turn.error.message.slice(0, 514)) : [];
  return { turnId: turn.turn_id, revision, status: turn.status,
    remoteMayStillBeRunning: turn.remote_may_still_be_running,
    error: turn.error ? { code: Array.from(turn.error.code.slice(0, 128)).slice(0, 64).join(""),
      message: text.slice(0, 256).join(""), retryable: turn.error.retryable,
      messageTruncated: text.length > 256 } : null };
}

export function parseConversationDisplayControl(value: unknown, input: ConversationDisplayControlInput): ConversationDisplayControl {
  const fail = (): never => { throw new TypeError("Invalid display control response"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  const header = parseConversationDisplayPage({ ...v, records: [], nextCursor: null }, input);
  const parse = (raw: unknown): ConversationDisplayTurnControl | null => {
    if (raw === null) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
    const item = raw as Record<string, unknown>;
    if (typeof item.turnId !== "string" || !item.turnId.length || item.turnId.length > 512 ||
        Array.from(item.turnId).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || (item.revision as number) > header.revision ||
        !["queued", "running", "waiting_for_tool_result", "waiting_for_approval", "completed", "cancelled", "failed"].includes(String(item.status)) ||
        typeof item.remoteMayStillBeRunning !== "boolean" || item.remoteMayStillBeRunning !==
          ["queued", "running", "waiting_for_tool_result"].includes(String(item.status))) return fail();
    let error: ConversationDisplayTurnControl["error"] = null;
    if (item.error !== null) {
      if (!item.error || typeof item.error !== "object" || Array.isArray(item.error)) return fail();
      const e = item.error as Record<string, unknown>;
      if (typeof e.code !== "string" || Array.from(e.code).length > 64 || typeof e.message !== "string" ||
          Array.from(e.message).length > 256 || typeof e.retryable !== "boolean" || typeof e.messageTruncated !== "boolean") return fail();
      error = { code: e.code, message: e.message, retryable: e.retryable, messageTruncated: e.messageTruncated };
    }
    return { turnId: item.turnId, revision: item.revision as number,
      status: item.status as ConversationDisplayTurnControl["status"], remoteMayStillBeRunning: item.remoteMayStillBeRunning, error };
  };
  if (v.hasPendingApprovals !== undefined && typeof v.hasPendingApprovals !== "boolean" ||
      header.status === "preparing" && v.hasPendingApprovals === true) return fail();
  const activeTurn = parse(v.activeTurn), latestTurn = parse(v.latestTurn), requestedTurn = parse(v.requestedTurn);
  if (header.status === "preparing" ? activeTurn || latestTurn || requestedTurn
      : header.activeTurnId !== (activeTurn?.turnId ?? null) || activeTurn && !activeTurn.remoteMayStillBeRunning ||
        requestedTurn && requestedTurn.turnId !== input.turnId || !input.turnId && requestedTurn) return fail();
  return { schemaVersion: 1, conversationId: header.conversationId, status: header.status, generation: header.generation,
    revision: header.revision, canonicalRevision: header.canonicalRevision, activeTurnId: header.activeTurnId,
    activeTurn, latestTurn, requestedTurn,
    ...(v.hasPendingApprovals === undefined ? {} : { hasPendingApprovals: v.hasPendingApprovals as boolean }) };
}
