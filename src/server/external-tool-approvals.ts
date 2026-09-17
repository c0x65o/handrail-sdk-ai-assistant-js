import type { ApprovalProposalStore } from "../conversation/approval-proposal-store.js";
import { ApprovalProposalStoreError } from "../conversation/approval-proposal-store.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import { findConversationEvent } from "../conversation/find-event.js";
import { replayConversation } from "../conversation/replay.js";
import type { DurableApplicationTurnStore } from "../transports/durable.js";
import { assistantToolArgumentReference, type AssistantToolRuntime } from "./assistant-tool-runtime.js";

export interface ExternalToolApprovalLocation {
  readonly conversationId: string;
  readonly turnId: string;
}

/** A host proves that a saved location originated in its external transport,
 * then supplies a runtime authorized by the CURRENT account. This must not
 * restore an old media lease or reuse the original call's session authority.
 * Return null for locations owned by a different transport. */
export type ExternalApprovalRuntimeFactory<TContext> = (input: ExternalToolApprovalLocation & {
  readonly context: TContext;
}) => AssistantToolRuntime | null | Promise<AssistantToolRuntime | null>;

/** Resume only exact, already-decided native proposals. The canonical tool
 * request and proposal form the durable handoff; no provider call is reopened.
 * The supplied runtime owns fresh policy checks, proposal execution claims and
 * the existing one-time tool ledger. Reads may retry after process loss. */
export async function resumeExternalToolApprovals<TContext>(options: {
  readonly context: TContext;
  readonly conversationId: string;
  readonly proposals: ApprovalProposalStore<TContext>;
  readonly events: ConversationEventStore;
  readonly turns: Pick<DurableApplicationTurnStore, "load">;
  readonly runtimeFor: ExternalApprovalRuntimeFactory<TContext>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  options.signal?.throwIfAborted();
  const proposals = await options.proposals.listGroup({ permissionContext: options.context,
    groupId: options.conversationId as never });
  const replay = await replayConversation({ conversationId: options.conversationId as never, eventStore: options.events });
  const current = replay.state; replay.store.destroy();
  options.signal?.throwIfAborted();
  if (current.replay_error) throw new Error("External approval recovery requires valid canonical history");
  const activeProposals = new Set(current.approval_proposals.map(proposal => proposal.proposal_id));
  let firstFailure: unknown;
  for (const proposal of proposals) {
    options.signal?.throwIfAborted();
    try {
      if (proposal.status === "pending" || proposal.group_id !== options.conversationId || !activeProposals.has(proposal.proposal_id)) continue;
      // Ordinary provider turns retain their own durable resumption machinery.
      if (await options.turns.load(options.conversationId, proposal.turn_id)) continue;
      // A retained result still passes through the idempotent runtime so the host
      // can repair a display receipt after a crash between execution and delivery.
      const location = { conversationId: options.conversationId, turnId: proposal.turn_id };
      const runtime = await options.runtimeFor({ ...location, context: options.context });
      options.signal?.throwIfAborted();
      if (!runtime) continue;
      const requested = await findConversationEvent(options.events, options.conversationId as never,
        event => event.payload.type === "tool_call.requested" &&
          event.payload.turn_id === proposal.turn_id && event.payload.tool_call_id === proposal.tool_call_id);
      const payload = requested?.payload;
      if (!requested || requested.actor.type !== "tool" || requested.source.type !== "runtime" ||
        payload?.type !== "tool_call.requested" || payload.name !== proposal.tool_name ||
        proposal.reviewed_arguments.type !== "opaque_reference" ||
        assistantToolArgumentReference(payload.arguments) !== proposal.reviewed_arguments.argument_ref) {
        throw new ApprovalProposalStoreError("idempotency_conflict", "transition");
      }
      options.signal?.throwIfAborted();
      await runtime.awaitApproval({ ...location, signal: options.signal ?? new AbortController().signal,
        call: { tool_call_id: proposal.tool_call_id, name: payload.name, arguments: payload.arguments } });
    } catch (error) { firstFailure ??= error; }
  }
  // A stale/denied proposal must not starve another independently authorized decision.
  if (firstFailure !== undefined) throw firstFailure;
}
