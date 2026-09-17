import { createApprovalCoordinator } from "../conversation/approval-coordinator.js";
import type { ApprovalProposalStore } from "../conversation/approval-proposal-store.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import { replayConversation } from "../conversation/replay.js";
import { jsonValuesEqual } from "../json-equality.js";
import type { PostgresApprovalRecoveryQueue, ApprovalRecoveryClaim } from "../postgres/approval-recovery.js";

/** Repair the exact decision event from a committed native receipt, without
 * deciding again or manufacturing a replacement idempotency identity. */
export async function repairApprovalDecisionPage<TContext>(input: {
  readonly queue: PostgresApprovalRecoveryQueue; readonly claim: ApprovalRecoveryClaim;
  readonly context: TContext; readonly events: ConversationEventStore;
  readonly proposals: ApprovalProposalStore<TContext>; readonly authorize: () => Promise<void>;
  readonly signal: AbortSignal;
}): Promise<{ readonly hasMore: boolean; readonly afterProposal: string }> {
  const { signal, claim, context, queue, proposals, events } = input;
  signal.throwIfAborted(); await input.authorize(); signal.throwIfAborted();
  const replay = await replayConversation({ conversationId: claim.conversationId as never, eventStore: events });
  const state = replay.state; replay.store.destroy();
  signal.throwIfAborted();
  if (state.replay_error) throw new Error("Approval recovery requires valid canonical history");
  const pending = state.approval_proposals.filter(proposal => proposal.status === "pending" && proposal.proposal_id > claim.afterProposal)
    .sort((a, b) => a.proposal_id < b.proposal_id ? -1 : a.proposal_id > b.proposal_id ? 1 : 0);
  const page = pending.slice(0, 25);
  for (const canonical of page) {
    signal.throwIfAborted();
    const receipt = await queue.decision(claim.conversationId, canonical.proposal_id);
    if (!receipt) continue; // No durable decision; the human can still decide later.
    await input.authorize(); signal.throwIfAborted();
    const saved = await proposals.get({ permissionContext: context, proposalId: canonical.proposal_id });
    signal.throwIfAborted();
    if (!saved || saved.group_id !== claim.conversationId || saved.turn_id !== receipt.turnId ||
      saved.tool_call_id !== receipt.toolCallId || saved.turn_id !== canonical.turn_id || saved.tool_name !== canonical.tool_name ||
      saved.tool_call_id !== canonical.tool_call_id || !jsonValuesEqual(saved.reviewed_arguments, canonical.reviewed_arguments) ||
      saved.created_at !== canonical.created_at || !jsonValuesEqual(saved.created_attribution, canonical.created_attribution) ||
      receipt.version !== canonical.proposal_version + 1 || saved.proposal_version < receipt.version ||
      !saved.decision_at || !saved.decision_attribution || saved.decision_at !== receipt.decidedAt ||
      saved.decision_reason !== receipt.reason || !jsonValuesEqual(saved.decision_attribution, receipt.attribution) ||
      receipt.status === "confirmed" && !["confirmed", "executing", "executed", "failed"].includes(saved.status) ||
      receipt.status === "rejected" && saved.status !== "rejected") {
      throw new Error("The saved approval decision could not be authorized and verified");
    }
    // Decision fields are immutable across later execution transitions. Restore
    // the exact version/time/actor used by the original coordinator append.
    const decision = { ...saved, status: receipt.status, proposal_version: receipt.version,
      updated_at: saved.decision_at, latest_attribution: saved.decision_attribution, failure_reason: null };
    const coordinator = createApprovalCoordinator<TContext>({ eventStore: events, proposalStore: {
      create: request => proposals.create(request), get: request => proposals.get(request),
      listGroup: request => proposals.listGroup(request),
      transition: async () => decision, // Already committed; no second decision mutation.
    }, authorize: async () => { await input.authorize(); signal.throwIfAborted(); return "allow" as const; } });
    const result = await coordinator.decide({ permissionContext: context, conversationId: claim.conversationId as never,
      proposalId: canonical.proposal_id, expectedVersion: canonical.proposal_version,
      decision: receipt.status === "confirmed" ? "confirm" : "reject", attribution: saved.decision_attribution,
      idempotencyKey: receipt.idempotencyKey, idempotencyFingerprint: "retained-decision", signal,
      ...(saved.decision_reason === null ? {} : { decisionReason: saved.decision_reason }) });
    if (result.outcome !== "accepted") throw new Error("The saved approval audit could not be reconciled");
  }
  return { hasMore: pending.length > 25, afterProposal: page.at(-1)?.proposal_id ?? claim.afterProposal };
}

/** Hold one conversation lease through repair/resumption; a new decision cannot
 * be acknowledged by an older claim. Abort stops new dispatch, not admitted work. */
export async function runApprovalRecoveryClaim(input: {
  readonly queue: PostgresApprovalRecoveryQueue; readonly claim: ApprovalRecoveryClaim; readonly signal: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<{ complete: boolean; afterProposal?: string }>;
}) {
  const controller = new AbortController(), abort = () => controller.abort();
  input.signal.addEventListener("abort", abort, { once: true });
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const monitoring = (async () => {
    while (!stopped) {
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 10_000); timer.unref?.(); });
      if (stopped) return;
      if (!await input.queue.renew(input.claim)) { controller.abort(); return; }
    }
  })().catch(() => { controller.abort(); });
  let complete = false, afterProposal = input.claim.afterProposal;
  try {
    if (input.signal.aborted) controller.abort();
    controller.signal.throwIfAborted();
    const result = await input.run(controller.signal);
    controller.signal.throwIfAborted();
    complete = result.complete; afterProposal = result.afterProposal ?? "";
  } finally {
    stopped = true; if (timer !== undefined) clearTimeout(timer); wake?.();
    await monitoring; input.signal.removeEventListener("abort", abort);
    await input.queue.finish(input.claim, complete, afterProposal);
  }
}
