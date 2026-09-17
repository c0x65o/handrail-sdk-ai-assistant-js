import { parseConversationApprovalDisplayReview, type ConversationApprovalDisplayReview,
  type ConversationApprovalDisplayDecisionInput, type ConversationApprovalDisplayReviewInput, type ConversationApprovalDisplayReviewSection } from "../conversation/approval-display-review.js";

export type ConversationApprovalReviewReader = (input: ConversationApprovalDisplayReviewInput, signal: AbortSignal) => Promise<ConversationApprovalDisplayReview>;
export interface ConversationApprovalReviewSnapshot {
  readonly status: "idle" | "loading" | "preparing" | "ready" | "error" | "deciding" | "decided";
  readonly section: ConversationApprovalDisplayReviewSection | null;
  readonly offset: number;
  readonly complete: boolean;
  readonly acknowledged: boolean;
  readonly error: "changed" | "denied" | "unavailable" | "decision" | null;
  readonly decision: "confirmed" | "rejected" | null;
}

/** One section, a contiguous review watermark and one immutable decision intent.
 * No argument assembly or raw event replay. Instances belong to one account,
 * selected conversation and projection generation; dispose when any changes. */
export class ConversationApprovalReview {
  private state: ConversationApprovalReviewSnapshot = { status: "idle", section: null, offset: 0,
    complete: false, acknowledged: false, error: null, decision: null };
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private binding: string | undefined;
  private through = 0;
  private pending: Promise<void> | null = null;
  private intent: ConversationApprovalDisplayDecisionInput | null = null;
  constructor(private readonly input: Pick<ConversationApprovalDisplayReviewInput, "conversationId" | "generation" | "proposalId">,
    private readonly read: ConversationApprovalReviewReader) {}
  getSnapshot = (): ConversationApprovalReviewSnapshot => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ConversationApprovalReviewSnapshot>) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  private async section(offset: number) {
    const input = { ...this.input, offset, ...(this.binding ? { binding: this.binding } : {}) };
    const result = parseConversationApprovalDisplayReview(await this.read(input, this.lifetime.signal), input);
    this.lifetime.signal.throwIfAborted(); return result;
  }
  private run(work: () => Promise<void>): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(() => { if (!this.lifetime.signal.aborted) return work(); }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending; return pending;
  }
  private failed(cause: unknown) {
    const error = cause as { resourceCode?: string; code?: string } | null;
    const code = error?.resourceCode ?? error?.code;
    const kind = code === "content_changed" || code === "stale_cursor" ? "changed"
      : ["forbidden", "permission_denied", "unauthenticated", "not_found"].includes(code ?? "") ? "denied" : "unavailable";
    // Fail closed even for a transient read failure. Restart/retry never skips
    // unreviewed sections or silently moves to a new argument binding.
    this.publish({ status: "error", section: null, acknowledged: false, error: kind });
  }
  load = (offset = this.state.offset): Promise<void> => this.run(async () => {
    if (this.intent || this.state.status === "decided" || !Number.isSafeInteger(offset) || offset < 0 || offset > this.through || offset % 8192 !== 0) return;
    this.publish({ status: "loading", section: null, offset, error: null });
    try {
      const result = await this.section(offset);
      if (result.status === "preparing") { this.publish({ status: "preparing", acknowledged: false }); return; }
      this.binding ??= result.review.binding;
      if (offset === this.through) this.through = result.review.nextOffset ?? offset;
      this.publish({ status: "ready", section: result.review,
        complete: this.state.complete || result.review.nextOffset === null });
    } catch (cause) { this.failed(cause); }
  });
  previous = (): Promise<void> => this.load(Math.max(0, this.state.offset - 8192));
  next = (): Promise<void> => this.state.section?.nextOffset !== null && this.state.section?.nextOffset !== undefined
    ? this.load(this.state.section.nextOffset) : Promise.resolve();
  acknowledge = (value: boolean): void => {
    if (this.state.status === "ready" && this.state.complete && !this.intent) this.publish({ acknowledged: value });
  };
  decide = (status: "confirmed" | "rejected", commit: (input: ConversationApprovalDisplayDecisionInput, signal: AbortSignal) => Promise<unknown>): Promise<void> => this.run(async () => {
    if (this.state.status === "decided" || this.intent && this.intent.status !== status) return;
    if (!this.intent) {
      if (this.state.status !== "ready" || !this.state.section || status === "confirmed" && (!this.state.complete || !this.state.acknowledged)) return;
      this.publish({ status: "deciding", error: null });
      try {
        // Verify the exact displayed binding again immediately before creating
        // intent. Versioned server authorization remains the decision boundary.
        const current = await this.section(this.state.offset);
        if (current.status !== "ready") { this.publish({ status: "preparing", section: null, acknowledged: false }); return; }
        const identity = `assistant:${this.input.proposalId}:${current.review.proposalVersion}:${status}`;
        this.intent = { conversationId: this.input.conversationId, proposalId: this.input.proposalId as never,
          expectedVersion: current.review.proposalVersion, proposalBinding: current.review.proposalBinding, status, idempotencyKey: identity as never, idempotencyFingerprint: identity };
      } catch (cause) { this.failed(cause); return; }
    }
    this.publish({ status: "deciding", error: null, decision: status });
    try {
      this.lifetime.signal.throwIfAborted();
      await commit(this.intent, this.lifetime.signal);
      this.publish({ status: "decided", section: null, acknowledged: false });
    } catch {
      // A lost response can mean the decision committed. Keep the exact intent
      // and retry its idempotent receipt, without requiring a now-pending review.
      this.publish({ status: "error", section: null, error: "decision" });
    }
  });
  dispose(): void {
    this.lifetime.abort(); this.listeners.clear(); this.binding = undefined; this.intent = null;
    this.state = { status: "idle", section: null, offset: 0, complete: false, acknowledged: false, error: null, decision: null };
  }
}
