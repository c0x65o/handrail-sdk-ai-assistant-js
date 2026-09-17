import type { ConversationMessageRecord, ConversationTurnRecord, ConversationToolCallRecord,
  ConversationApprovalProposalRecord, ConversationToolLoopBudgetExhaustion } from "./state.js";
import type { Citation, CitationSource } from "../citations.js";
import type { ConversationDisplayControl, ConversationDisplayControlInput } from "./display-control.js";
import type { ConversationApprovalDisplayReviewInput, ConversationApprovalDisplayReview } from "./approval-display-review.js";

/** Display records are not canonical checkpoints and must never seed model context. */
export interface ConversationDisplayRecordTypes {
  message: ConversationMessageRecord;
  turn: ConversationTurnRecord;
  tool: ConversationToolCallRecord;
  approval: ConversationApprovalProposalRecord;
  citation: Citation;
  source: CitationSource;
  budget: ConversationToolLoopBudgetExhaustion;
}
export type ConversationDisplayRecordKind = keyof ConversationDisplayRecordTypes;
export type ConversationDisplayRecord = {
  [K in ConversationDisplayRecordKind]: {
    readonly kind: K;
    readonly id: string;
    readonly revision: number;
    readonly turnId: string | null;
    readonly bytes: number;
    /** Null means deferred, never an empty message or permission to drop content. */
    readonly value: ConversationDisplayRecordTypes[K] | null;
    readonly deferred: boolean;
    /** A changes-feed tombstone; never returned in a history page. */
    readonly deleted?: true;
  }
}[ConversationDisplayRecordKind];

export type ConversationDisplayView =
  | { readonly type: "messages" }
  /** Current pending decisions, independent of the loaded message window. */
  | { readonly type: "pending_approvals" }
  /** One proposal and its bound tool record; never an entire turn. */
  | { readonly type: "approval"; readonly proposalId: string }
  | { readonly type: "turn"; readonly turnId: string }
  /** Bounded related state for the currently displayed complete messages. */
  | { readonly type: "context"; readonly messageIds: readonly string[]; readonly turnId?: string }
  | { readonly type: "citations"; readonly messageId: string };

export interface ConversationDisplayPageInput {
  readonly conversationId: string;
  readonly view?: ConversationDisplayView;
  readonly cursor?: string;
  /** Indexed message navigation for bounded windows and saved scroll positions.
   * Mutually exclusive with cursor; only valid for the messages view. */
  readonly anchor?: { readonly messageId: string; readonly generation: number;
    readonly direction: "older" | "newer"; readonly inclusive?: boolean };
  readonly limit?: number;
  readonly maximumBytes?: number;
}

export interface ConversationDisplayPage {
  readonly schemaVersion: 1;
  readonly status: "ready" | "preparing";
  readonly conversationId: string;
  /** Changes on clear. Pages and content chunks from older generations are invalid. */
  readonly generation: number;
  readonly revision: number;
  readonly canonicalRevision: number;
  readonly activeTurnId: string | null;
  /** Always in display order. The next cursor continues in the requested direction. */
  readonly records: readonly ConversationDisplayRecord[];
  readonly nextCursor: string | null;
}

export interface ConversationDisplayContentInput {
  readonly conversationId: string;
  readonly generation: number;
  readonly kind: ConversationDisplayRecordKind;
  readonly id: string;
  /** May be omitted on the first chunk of a referenced record. Later chunks pin it. */
  readonly revision?: number;
  /** Negotiated text reader for large messages; omits record JSON and attachments. */
  readonly format?: "json-text" | "message-text" | "record-text";
  /** Unicode code-point offset into a serialized JSON record, not an event log. */
  readonly offset?: number;
}

export interface ConversationDisplayContentChunk {
  readonly encoding: "json-text" | "plain-text";
  readonly text: string;
  readonly nextOffset: number | null;
  readonly revision: number;
}

export interface ConversationDisplayChangesInput {
  readonly conversationId: string;
  readonly generation: number;
  readonly afterRevision: number;
  readonly cursor?: string;
  readonly limit?: number;
  readonly maximumBytes?: number;
}

export interface ConversationDisplayChanges extends ConversationDisplayPage {
  /** Advance the live watermark only after nextCursor is null. */
  readonly throughRevision: number;
}

export interface ConversationDisplayHistory {
  /** Negotiated bounded argument review; never hydrate canonical history here. */
  approvalReview?(input: ConversationApprovalDisplayReviewInput): Promise<ConversationApprovalDisplayReview>;
  /** Optional for older/custom display stores; advertised separately by gateways. */
  control?(input: ConversationDisplayControlInput): Promise<ConversationDisplayControl>;
  page(input: ConversationDisplayPageInput): Promise<ConversationDisplayPage>;
  content(input: ConversationDisplayContentInput): Promise<ConversationDisplayContentChunk>;
  changes(input: ConversationDisplayChangesInput): Promise<ConversationDisplayChanges>;
}

export class ConversationDisplayHistoryError extends Error {
  constructor(readonly code: "invalid_input" | "stale_cursor" | "not_found" | "content_changed", message: string) {
    super(message); this.name = "ConversationDisplayHistoryError";
  }
}

export const CONVERSATION_DISPLAY_LIMITS = Object.freeze({
  defaultPageSize: 30, maximumPageSize: 50, defaultPageBytes: 64 * 1024, maximumPageBytes: 256 * 1024,
  minimumPageBytes: 8 * 1024, maximumInlineRecordBytes: 32 * 1024,
  contentChunkCharacters: 8 * 1024, backfillEvents: 100,
});

/** Validate the wire envelope before it can enter an account-owned display cache. */
export function parseConversationDisplayPage(value: unknown, input: ConversationDisplayPageInput | ConversationDisplayChangesInput):
  ConversationDisplayPage | ConversationDisplayChanges {
  const fail = (): never => { throw new TypeError("Invalid display history response"); };
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  const id = (item: unknown): item is string => typeof item === "string" && item.length > 0 && item.length <= 512 &&
    !Array.from(item).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const integer = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  const change = "afterRevision" in input;
  if (!object(value) || value.schemaVersion !== 1 || value.conversationId !== input.conversationId ||
    !["ready", "preparing"].includes(String(value.status)) || !integer(value.generation) || !integer(value.revision) ||
    !integer(value.canonicalRevision) || value.generation > value.revision || value.revision > value.canonicalRevision ||
    value.status === "ready" && value.revision !== value.canonicalRevision ||
    value.activeTurnId !== null && !id(value.activeTurnId) || !Array.isArray(value.records) ||
    value.records.length > (input.limit ?? CONVERSATION_DISPLAY_LIMITS.defaultPageSize) ||
    value.status === "preparing" && value.records.length > 0 || value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" || value.nextCursor.length < 1 || value.nextCursor.length > 4096)) return fail();
  if (change && (value.generation !== input.generation || !integer(value.throughRevision) ||
      value.throughRevision < input.afterRevision || value.throughRevision > value.revision)) return fail();
  if (!change && input.anchor && value.generation !== input.anchor.generation) return fail();
  const identities = new Set<string>();
  for (const record of value.records) {
    if (!object(record) || !["message", "turn", "tool", "approval", "citation", "source", "budget"].includes(String(record.kind)) ||
      !id(record.id) || record.turnId !== null && !id(record.turnId) || !integer(record.revision) || record.revision < 1 ||
      record.revision > value.revision || !integer(record.bytes) || typeof record.deferred !== "boolean" ||
      (record.deleted === true ? !change || record.deferred || record.value !== null
        : record.deferred ? record.value !== null : !object(record.value)) ||
      change && (record.revision <= input.afterRevision || record.revision > (value.throughRevision as number))) return fail();
    const key = JSON.stringify([record.kind, record.id]);
    if (identities.has(key)) return fail();
    identities.add(key);
  }
  return value as unknown as ConversationDisplayPage | ConversationDisplayChanges;
}
