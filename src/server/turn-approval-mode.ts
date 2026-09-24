import { composerApprovalModeFromRequest, type TurnApprovalModeInput, type TurnApprovalModeResult } from "../composer-approval.js";
import { ApprovalProposalStoreError } from "../conversation/approval-proposal-store.js";
import type { ChatRequest } from "../protocol.js";
import type { DurableApplicationTurnRecord, DurableApplicationTurnStore } from "../transports/durable.js";

export function turnApprovalMode(record: DurableApplicationTurnRecord): TurnApprovalModeResult {
  return {
    mode: record.approvalPreference?.mode ?? composerApprovalModeFromRequest((record.request ?? {}) as ChatRequest) ?? "required",
    revision: record.approvalPreference?.revision ?? 0,
    active: !record.cancellation && ["pending", "running", "waiting_for_approval"].includes(record.status),
  };
}

/** Called only after authenticating and authorizing the exact conversation. */
export async function changeTurnApprovalMode(input: TurnApprovalModeInput, principalId: string,
  store: DurableApplicationTurnStore): Promise<TurnApprovalModeResult> {
  const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/u.test(v);
  if (!input || !validId(input.conversationId) || !validId(input.turnId) || input.mode !== undefined &&
      (input.mode !== "required" && input.mode !== "automatic" || !validId(input.mutationId) ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0)) {
    throw new ApprovalProposalStoreError("invalid_input", "transition");
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const saved = await store.load(input.conversationId, input.turnId);
    if (!saved) throw new ApprovalProposalStoreError("not_found", "transition");
    const current = turnApprovalMode(saved.record);
    if (input.mode === undefined) return current;
    const prior = saved.record.approvalPreference;
    if (prior && prior.mutationId === input.mutationId) {
      if (prior.mode !== input.mode || prior.principalId !== principalId || prior.revision !== input.expectedRevision! + 1)
        throw new ApprovalProposalStoreError("idempotency_conflict", "transition");
      return current;
    }
    if (current.revision !== input.expectedRevision) throw new ApprovalProposalStoreError("version_conflict", "transition");
    if (!current.active) return current;
    const changedAt = new Date().toISOString();
    const result = await store.compareAndSet({ conversationId: input.conversationId, turnId: input.turnId,
      expectedVersion: saved.version, record: { ...saved.record, updatedAt: changedAt,
        approvalPreference: { mode: input.mode, revision: current.revision + 1, mutationId: input.mutationId!, principalId, changedAt } } });
    if (result.status === "updated") return turnApprovalMode(result.document.record);
  }
  throw new ApprovalProposalStoreError("unavailable", "transition");
}
