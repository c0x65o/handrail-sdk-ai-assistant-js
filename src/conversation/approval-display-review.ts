import type { JsonValue } from "../protocol.js";
import { assistantToolArgumentReference } from "./approval-arguments.js";
import type { ConversationApprovalProposalRecord } from "./state.js";
/** Bounded, authorized review of one exact proposal. This is display-only;
 * decisions still use the proposal store's version/idempotency contract. */
export interface ConversationApprovalDisplayReviewInput {
  readonly conversationId: string;
  readonly generation: number;
  readonly proposalId: string;
  /** Omit only on the first section. All navigation pins the original binding. */
  readonly binding?: string;
  readonly offset?: number;
}

export interface ConversationApprovalDisplayReviewSection {
  readonly binding: string;
  readonly proposalVersion: number;
  readonly proposalBinding: string;
  readonly groupId: string | null;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentReference: string;
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
}

export type ConversationApprovalDisplayReview = {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly generation: number;
  readonly proposalId: string;
} & ({ readonly status: "preparing"; readonly review: null }
  | { readonly status: "ready"; readonly review: ConversationApprovalDisplayReviewSection });

export function parseConversationApprovalDisplayReview(value: unknown, input: ConversationApprovalDisplayReviewInput): ConversationApprovalDisplayReview {
  const fail = (): never => { throw new TypeError("Invalid approval review response"); };
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !Array.from(v).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
  const offset = input.offset ?? 0;
  if (!object(value) || value.schemaVersion !== 1 || value.conversationId !== input.conversationId ||
      value.proposalId !== input.proposalId || value.generation !== input.generation) return fail();
  if (value.status === "preparing" && value.review === null) return value as ConversationApprovalDisplayReview;
  const r = value.review;
  if (value.status !== "ready" || !object(r) || !hash(r.proposalBinding) || !hash(r.binding) || input.binding !== undefined && r.binding !== input.binding ||
      !Number.isSafeInteger(r.proposalVersion) || (r.proposalVersion as number) < 1 ||
      !id(r.turnId) || !id(r.toolCallId) || !id(r.toolName) || r.groupId !== null && !id(r.groupId) ||
      typeof r.argumentReference !== "string" || !/^args-sha256-[a-f0-9]{64}$/u.test(r.argumentReference) ||
      typeof r.text !== "string" || r.text.length > 16384 || Array.from(r.text).length > 8192 || r.offset !== offset ||
      r.nextOffset !== null && (Array.from(r.text).length !== 8192 || r.nextOffset !== offset + 8192)) return fail();
  return value as ConversationApprovalDisplayReview;
}

/** Same immutable proposal identity used by durable native decisions. Status and
 * execution receipts are deliberately excluded; expectedVersion pins the review. */
export function approvalDisplayProposalBinding(conversationId: string, proposal: ConversationApprovalProposalRecord,
  expectedVersion = proposal.proposal_version): string {
  return assistantToolArgumentReference({ conversationId, group_id: proposal.group_id,
    proposal_id: proposal.proposal_id, proposal_version: expectedVersion, turn_id: proposal.turn_id,
    tool_call_id: proposal.tool_call_id, tool_name: proposal.tool_name, expires_at: proposal.expires_at,
    reviewed_arguments: proposal.reviewed_arguments as JsonValue }).slice("args-sha256-".length);
}
export interface ConversationApprovalDisplayDecisionInput {
  readonly conversationId: string;
  readonly proposalId: string;
  readonly expectedVersion: number;
  readonly status: "confirmed" | "rejected";
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
  readonly proposalBinding: string;
}
export interface ConversationApprovalDisplayDecision {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly status: "confirmed" | "rejected";
  readonly proposalBinding: string;
}
export function parseConversationApprovalDisplayDecision(value: unknown, input: ConversationApprovalDisplayDecisionInput): ConversationApprovalDisplayDecision {
  const v = value as Partial<ConversationApprovalDisplayDecision> | null;
  if (!v || v.schemaVersion !== 1 || v.conversationId !== input.conversationId || v.proposalId !== input.proposalId ||
    v.proposalVersion !== input.expectedVersion + 1 || v.status !== input.status || v.proposalBinding !== input.proposalBinding) {
    throw new TypeError("Invalid approval decision receipt");
  }
  return v as ConversationApprovalDisplayDecision;
}
