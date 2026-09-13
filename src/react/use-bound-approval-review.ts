import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationApprovalProposalRecord } from "../conversation/state.js";

export interface UseBoundApprovalReviewOptions<T> {
  /** Authenticated client/account identity. Changing it immediately hides prior data. */
  readonly scope: unknown;
  readonly conversationId: string;
  readonly proposal: ConversationApprovalProposalRecord;
  readonly enabled?: boolean;
  /** Host-authenticated read that validates the returned domain review against the proposal binding. */
  readonly load: (signal: AbortSignal) => Promise<T>;
  readonly onError?: (error: unknown) => void;
}

/** Shared review loading/retry/disposal. Presentation never substitutes for server authorization. */
export function useBoundApprovalReview<T>(options: UseBoundApprovalReviewOptions<T>) {
  const { proposal } = options;
  const binding = JSON.stringify([options.conversationId, proposal.group_id, proposal.proposal_id,
    proposal.proposal_version, proposal.turn_id, proposal.tool_call_id, proposal.tool_name, proposal.reviewed_arguments]);
  const enabled = options.enabled !== false;
  const [attempt, setAttempt] = useState(0);
  const identity = useMemo(() => ({}), [options.scope, binding, enabled, attempt]);
  const latest = useRef(options); latest.current = options;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const [saved, setSaved] = useState<{ identity: object; review: T | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setSaved(null);
    void (async () => {
      try {
        const review = await latest.current.load(controller.signal);
        if (!controller.signal.aborted && currentIdentity.current === identity) setSaved({ identity, review, failed: false });
      } catch (error) {
        if (controller.signal.aborted || currentIdentity.current !== identity) return;
        setSaved({ identity, review: null, failed: true });
        try { latest.current.onError?.(error); } catch { /* A host notification cannot retain stale review state. */ }
      }
    })();
    return () => controller.abort();
  }, [identity, enabled, attempt]);
  const current = enabled && saved?.identity === identity ? saved : null;
  return {
    review: current?.review ?? null,
    status: !enabled ? "unavailable" as const : !current ? "loading" as const : current.failed ? "error" as const : "ready" as const,
    retry: () => { setSaved(null); setAttempt(value => value + 1); },
  };
}
