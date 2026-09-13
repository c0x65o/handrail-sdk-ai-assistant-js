import { useEffect, useRef, useState } from "react";
import type { HandrailAiClient } from "../client/index.js";
import type { StreamEvent, ChatRequest } from "../protocol.js";
import type { ConversationApprovalProposalRecord } from "../conversation/state.js";

export type ConversationApprovalResources = Pick<HandrailAiClient<StreamEvent, ChatRequest, object>["resources"],
  "listApprovalGroup" | "transitionApproval">;

/** Shared approval polling and decisions for styled, custom web and native React views. */
export function useConversationApprovals(resources: ConversationApprovalResources | null, conversationId: string | null) {
  const [state, setState] = useState({ resources, conversationId,
    proposals: [] as readonly ConversationApprovalProposalRecord[], busy: null as string | null, error: null as "refresh" | "decision" | null });
  const lifecycle = useRef<{
    active: boolean; busy: boolean; revision: number; refresh: () => void; resources: ConversationApprovalResources; conversationId: string;
  } | null>(null);
  useEffect(() => {
    if (conversationId === null || resources === null) {
      lifecycle.current = null;
      setState({ resources, conversationId, proposals: [], busy: null, error: null });
      return;
    }
    let loading = false;
    let refreshAfterLoad = false;
    const current = { resources, conversationId, active: true, busy: false, revision: 0, refresh: () => { void load(); } };
    lifecycle.current = current;
    setState({ resources, conversationId, proposals: [], busy: null, error: null as "refresh" | "decision" | null });
    async function load() {
      if (!current.active) return;
      if (loading) { refreshAfterLoad = true; return; }
      loading = true;
      const revision = current.revision;
      try {
        const proposals = await current.resources.listApprovalGroup({ groupId: conversationId as never });
        if (current.active && revision === current.revision) {
          setState((previous) => ({ ...previous, resources, proposals, error: null as "refresh" | "decision" | null }));
        }
      } catch {
        if (current.active && revision === current.revision) {
          setState((previous) => ({ ...previous, error: "refresh" as const }));
        }
      } finally {
        loading = false;
        if (refreshAfterLoad && current.active) { refreshAfterLoad = false; void load(); }
      }
    }
    void load();
    const timer = globalThis.setInterval(current.refresh, 2_000);
    return () => { current.active = false; globalThis.clearInterval(timer); };
  }, [resources, conversationId]);
  const decide = async (proposal: ConversationApprovalProposalRecord, status: "confirmed" | "rejected") => {
    const current = lifecycle.current;
    if (!current?.active || current.busy || current.resources !== resources || current.conversationId !== conversationId) return;
    const identity = `assistant:${proposal.proposal_id}:${proposal.proposal_version}:${status}`;
    current.busy = true;
    current.revision++;
    setState((previous) => ({ ...previous, busy: proposal.proposal_id, error: null as "refresh" | "decision" | null }));
    try {
      const result = await current.resources.transitionApproval({ conversationId: current.conversationId, proposalId: proposal.proposal_id,
        expectedVersion: proposal.proposal_version, status, idempotencyKey: identity,
        idempotencyFingerprint: identity });
      if (current.active) {
        // A read started before confirmation settled must not restore its pending card.
        current.revision++;
        setState((previous) => ({ ...previous,
          proposals: [...previous.proposals.filter((item) => item.proposal_id !== proposal.proposal_id),
            ...(result?.proposal_id === proposal.proposal_id ? [result] : [])] }));
        current.refresh();
      }
    } catch {
      if (current.active) {
        current.revision++;
        setState((previous) => ({ ...previous, error: "decision" as const }));
      }
    } finally {
      current.busy = false;
      if (current.active) setState((previous) => ({ ...previous, busy: null }));
    }
  };
  const visible = state.resources === resources && state.conversationId === conversationId
    ? state : { proposals: [], busy: null, error: null };
  return { proposals: visible.proposals, busy: visible.busy, error: visible.error, decide,
    refresh: () => { const current = lifecycle.current;
      if (current?.resources === resources && current.conversationId === conversationId) current.refresh();
    } };
}
