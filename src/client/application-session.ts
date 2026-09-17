import type { ConversationClientId, ConversationId, ConversationTurnCancellationReason } from "../conversation/events.js";
import type { ConversationDisplayControl, ConversationDisplayControlInput, ConversationDisplayTurnControl } from "../conversation/display-control.js";
import type { ConversationDisplayRecord } from "../conversation/display-history.js";
import type { ConversationRuntimeSendMessageInput } from "../runtime.js";
import type { ApplicationGatewayResourceClient } from "../transports/application-gateway.js";
import type { ConversationTransport, TurnObservation } from "../transports/types.js";
import { ConversationDisplayWindow, type ConversationDisplayReader, type ConversationDisplayWindowSnapshot } from "./display-window.js";
import { ConversationDraftController, parseSavedPosition, type ConversationLocalStateStore, type ConversationSavedPosition } from "./local-state.js";
import { captureApplicationConversationInput, parseApplicationConversationSubmission, prepareApplicationConversationSubmission,
  type ApplicationConversationPendingStore, type ApplicationConversationSubmission } from "./session-submission.js";

export interface ApplicationConversationReader extends ConversationDisplayReader {
  control(input: ConversationDisplayControlInput, signal?: AbortSignal): Promise<ConversationDisplayControl>;
}
/** A partial presentation, intentionally not assignable to ConversationState. */
export interface ApplicationConversationSessionSnapshot {
  readonly kind: "display";
  readonly conversationId: string;
  readonly control: ConversationDisplayControl | null;
  readonly window: ConversationDisplayWindowSnapshot;
  readonly related: readonly ConversationDisplayRecord[];
  readonly hasMoreRelated: boolean;
  readonly loading: boolean;
  readonly submitting: boolean;
  readonly hasPendingSubmission: boolean;
  readonly error: ApplicationConversationSessionError | null;
}
export interface ApplicationConversationSessionOptions<TRequest> {
  readonly conversationId: ConversationId;
  readonly clientId: ConversationClientId;
  readonly reader: ApplicationConversationReader;
  readonly resources: Pick<ApplicationGatewayResourceClient, "appendMutations">;
  readonly transport: ConversationTransport<unknown, TRequest>;
  readonly pendingStore: ApplicationConversationPendingStore<TRequest>;
  readonly localStateStore?: ConversationLocalStateStore;
  /** Bootstrap waits for account-owned local flushes before completing disposal. */
  readonly onLocalStateFlush?: (operation: Promise<void>) => void;
  readonly pollMilliseconds?: number;
  readonly idlePollMilliseconds?: number;
  readonly createId?: () => string;
  readonly now?: () => string;
}
export class ApplicationConversationSessionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message); this.name = "ApplicationConversationSessionError";
  }
}
const terminal = (turn: ConversationDisplayTurnControl) =>
  ["completed", "failed", "cancelled", "waiting_for_approval"].includes(turn.status);
const errorCode = (cause: unknown) => {
  if (!cause || typeof cause !== "object") return "unavailable";
  const error = cause as { resourceCode?: string; code?: string; transportCode?: string };
  return error.resourceCode ?? error.code ?? error.transportCode ?? "unavailable";
};
const denied = (cause: unknown) => ["forbidden", "permission_denied", "unauthenticated", "not_found"].includes(errorCode(cause));
function normalize(cause: unknown): ApplicationConversationSessionError {
  return cause instanceof ApplicationConversationSessionError ? cause
    : new ApplicationConversationSessionError(errorCode(cause), denied(cause)
      ? "Conversation access is unavailable." : "Conversation could not be refreshed. Try again.", !denied(cause));
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new ApplicationConversationSessionError("observation_closed", "Conversation observation was closed.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Server-owned execution with bounded browser presentation. Opening and observing
 * never hydrate checkpoints, replay provider logs or write assistant output.
 * Durable local intent precedes admission; stream frames only wake display reads. */
export class ApplicationConversationSession<TRequest = unknown> {
  readonly window: ConversationDisplayWindow;
  readonly draft: ConversationDraftController | null;
  private position: ConversationSavedPosition | null = null;
  private positionLoaded = false;
  private positionDirty = false;
  private positionWrite: Promise<void> | null = null;
  private positionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly lifetime = new AbortController();
  private displayLifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly waits = new Map<string, { turnId: string; controller: AbortController }>();
  private readonly cancellationIds = new Map<string, { identity: string; reason: ConversationTurnCancellationReason }>();
  private readonly pollMilliseconds: number;
  private readonly idlePollMilliseconds: number;
  private state: ApplicationConversationSessionSnapshot;
  private readonly unsubscribeWindow: () => void;
  private active = true;
  private pending: Promise<void> | null = null;
  private submission: { json: string; promise: Promise<ConversationDisplayTurnControl> } | null = null;
  private control: ConversationDisplayControl | null = null;
  private related: readonly ConversationDisplayRecord[] = Object.freeze([]);
  private relatedCursor: string | null = null;
  private relatedKey = "";
  private relatedPending: Promise<void> | null = null;
  private observation: TurnObservation<unknown> | null = null;
  private observationTurnId: string | null = null;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private wake: ReturnType<typeof setTimeout> | undefined;
  private followingLatest = true;
  private admitted: ApplicationConversationSubmission<TRequest> | null = null;
  private callbacks: NonNullable<ConversationRuntimeSendMessageInput<TRequest>["onAccepted"]>[] = [];

  constructor(private readonly options: ApplicationConversationSessionOptions<TRequest>) {
    this.draft = options.localStateStore ? new ConversationDraftController(options.conversationId, options.localStateStore) : null;
    this.pollMilliseconds = options.pollMilliseconds ?? 1000;
    this.idlePollMilliseconds = options.idlePollMilliseconds ?? 15000;
    if (![this.pollMilliseconds, this.idlePollMilliseconds].every(value => Number.isSafeInteger(value) && value >= 100 && value <= 300000)) {
      throw new TypeError("Invalid conversation polling interval");
    }
    this.window = new ConversationDisplayWindow({ reader: options.reader });
    this.state = Object.freeze({ kind: "display", conversationId: options.conversationId, control: null,
      window: this.window.getSnapshot(), related: this.related, hasMoreRelated: false, loading: false, submitting: false, hasPendingSubmission: false, error: null });
    this.unsubscribeWindow = this.window.subscribe(() => {
      const next = this.window.getSnapshot();
      if (next.version !== this.state.window.version && next.change === "older") this.followingLatest = false;
      if (next.version !== this.state.window.version && next.change === "latest") this.followingLatest = true;
      this.publish();
      if (!this.pending && this.active && this.relatedKey !== this.contextKey()) this.scheduleRefresh();
    });
  }
  getSnapshot = (): ApplicationConversationSessionSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen(); this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private assertOpen() {
    if (this.lifetime.signal.aborted) throw new ApplicationConversationSessionError("observation_closed", "Conversation account was closed.");
  }
  private publish(patch: Partial<ApplicationConversationSessionSnapshot> = {}) {
    if (this.lifetime.signal.aborted) return;
    this.state = Object.freeze({ ...this.state, control: this.control, window: this.window.getSnapshot(),
      related: this.related, hasMoreRelated: this.relatedCursor !== null, ...patch });
    for (const listener of this.listeners) { try { listener(); } catch { /* Observers do not own admission or reads. */ } }
  }
  async initialize(): Promise<void> {
    try {
      const pending = await this.options.pendingStore.load(this.options.conversationId); this.assertOpen();
      this.publish({ hasPendingSubmission: pending !== null }); await this.refresh();
    } catch (cause) { const error = normalize(cause); this.publish({ error }); throw error; }
    finally { this.schedulePoll(); }
  }
  private schedulePoll() {
    clearTimeout(this.poll);
    if (this.lifetime.signal.aborted || this.state.error && !this.state.error.retryable) return;
    this.poll = setTimeout(() => {
      void this.refresh().catch(() => undefined).finally(() => this.schedulePoll());
    }, this.active || this.control?.activeTurn ? this.pollMilliseconds : this.idlePollMilliseconds);
  }
  private scheduleRefresh() {
    if (this.wake || this.lifetime.signal.aborted || this.state.error && !this.state.error.retryable) return;
    this.wake = setTimeout(() => { this.wake = undefined; void this.refresh().catch(() => undefined); }, 100);
  }
  setFollowingLatest(value: boolean): void { this.followingLatest = value; }
  getPosition = (): ConversationSavedPosition | undefined => this.position ?? undefined;
  savePosition = (position: ConversationSavedPosition): void => {
    if (this.lifetime.signal.aborted) return;
    this.position = parseSavedPosition(position); this.positionLoaded = true; this.positionDirty = true;
    clearTimeout(this.positionTimer);
    this.positionTimer = setTimeout(() => { this.positionTimer = undefined; void this.flushPosition().catch(() => undefined); }, 250);
  };
  private async restorePosition(signal: AbortSignal) {
    if (this.positionLoaded) return;
    try {
      const value = await this.options.localStateStore?.readPosition(this.options.conversationId);
      if (signal.aborted || this.positionLoaded) return;
      this.position = value ? parseSavedPosition(value) : null;
      this.followingLatest = this.position?.following ?? true;
    } catch { /* Local position failure must not hide an authorized conversation. */ }
    if (!signal.aborted) this.positionLoaded = true;
  }
  private flushPosition(): Promise<void> {
    clearTimeout(this.positionTimer); this.positionTimer = undefined;
    if (this.positionWrite) return this.positionWrite;
    const work = Promise.resolve().then(async () => {
      while (this.positionDirty && this.position) {
        const value = this.position;
        await this.options.localStateStore?.writePosition(this.options.conversationId, value);
        if (this.position === value) this.positionDirty = false;
      }
    }).finally(() => { if (this.positionWrite === work) this.positionWrite = null; });
    this.positionWrite = work; return work;
  }
  async setActive(active: boolean): Promise<void> {
    this.assertOpen();
    if (this.active === active) return;
    this.active = active;
    this.displayLifetime.abort(); this.displayLifetime = new AbortController();
    this.related = Object.freeze([]); this.relatedCursor = null; this.relatedKey = "";
    if (!active) { await this.window.select(null); this.publish(); }
    else { await this.pending?.catch(() => undefined); await this.refresh(); }
    this.schedulePoll();
  }
  refresh(): Promise<void> {
    this.assertOpen();
    if (this.pending) return this.pending;
    const signal = AbortSignal.any([this.lifetime.signal, this.displayLifetime.signal]);
    const work = Promise.resolve().then(async () => {
      this.publish({ loading: true });
      try {
        const control = await this.options.reader.control({ conversationId: this.options.conversationId }, signal);
        if (signal.aborted) return;
        if (control.status === "preparing") {
          this.control = control; this.related = Object.freeze([]); this.relatedKey = ""; this.relatedCursor = null;
          await this.window.select(null);
          throw new ApplicationConversationSessionError("history_preparing", "Preparing saved conversation…", true);
        }
        if (this.control && control.revision < this.control.revision) throw new ApplicationConversationSessionError("stale_control", "Conversation controls are temporarily behind.", true);
        const previous = this.control; this.control = control;
        if (previous?.generation !== control.generation) { this.related = Object.freeze([]); this.relatedKey = ""; this.relatedCursor = null; }
        if (this.active) {
          await this.restorePosition(signal); if (signal.aborted) return;
          if (this.window.getSnapshot().conversationId !== this.options.conversationId || previous?.generation !== control.generation) {
            const saved = this.position;
            const anchor = saved && !saved.following && saved.generation === control.generation
              ? { messageId: saved.messageId, generation: saved.generation, direction: "newer" as const, inclusive: true } : undefined;
            if (!anchor) this.followingLatest = true;
            await this.window.select(this.options.conversationId, anchor);
          }
          else await this.window.refresh();
          if (signal.aborted) return;
          if (this.followingLatest && this.window.getSnapshot().hasNewer && !this.window.getSnapshot().error) await this.window.jumpToLatest();
          if (signal.aborted) return;
          const window = this.window.getSnapshot();
          if (window.error) throw window.error.cause;
          if (window.status !== "ready" || window.generation !== control.generation) throw new ApplicationConversationSessionError("history_preparing", "Preparing saved conversation…", true);
          if (this.relatedKey !== this.contextKey()) {
            this.relatedKey = this.contextKey(); this.related = Object.freeze([]); this.relatedCursor = null;
            try { await this.readRelated(signal); } catch (cause) { this.relatedKey = ""; throw cause; }
          }
        }
        if (!signal.aborted) this.publish({ error: null });
      } catch (cause) {
        if (signal.aborted) return;
        if (denied(cause)) {
          this.observation?.disconnect(); this.observation = null;
          clearTimeout(this.wake); this.wake = undefined;
          this.control = null; this.related = Object.freeze([]); this.relatedCursor = null; this.relatedKey = "";
          await this.window.select(null);
        }
        const error = normalize(cause); this.publish({ error }); throw error;
      } finally { if (!this.lifetime.signal.aborted) this.publish({ loading: false }); }
    }).finally(() => { if (this.pending === work) this.pending = null; });
    this.pending = work; return work;
  }
  private contextKey() { return `${this.control?.generation}/${this.control?.revision}/${this.window.getSnapshot().version}`; }
  private async readRelated(signal: AbortSignal) {
    const key = this.relatedKey, turn = this.control?.activeTurn ?? this.control?.latestTurn;
    const messageIds = this.window.getSnapshot().records.map(record => record.id);
    if (!turn && !messageIds.length) return;
    const page = await this.options.reader.page({ conversationId: this.options.conversationId,
      view: { type: "context", messageIds, ...(turn ? { turnId: turn.turnId } : {}) },
      ...(this.relatedCursor ? { cursor: this.relatedCursor } : {}) }, signal);
    if (signal.aborted || this.relatedKey !== key || key !== this.contextKey()) return;
    if (page.status !== "ready" || page.generation !== this.control?.generation) throw new ApplicationConversationSessionError("history_preparing", "Preparing saved activity…", true);
    this.related = page.records; this.relatedCursor = page.nextCursor;
  }
  loadMoreRelated(): Promise<void> {
    this.assertOpen();
    if (this.relatedPending) return this.relatedPending;
    if (!this.relatedCursor) return Promise.resolve();
    const signal = AbortSignal.any([this.lifetime.signal, this.displayLifetime.signal]);
    return this.relatedPending = this.readRelated(signal).then(() => this.publish()).finally(() => { this.relatedPending = null; });
  }
  async prepare(input: ConversationRuntimeSendMessageInput<TRequest>): Promise<ApplicationConversationSubmission<TRequest>> {
    const captured = captureApplicationConversationInput(input);
    await this.refresh(); this.assertOpen();
    if (!this.control || this.control.status !== "ready") throw new ApplicationConversationSessionError("history_preparing", "Preparing saved conversation…", true);
    if (this.submission || this.control.activeTurnId) throw new ApplicationConversationSessionError("turn_active", "Wait for the active response or stop it before sending.");
    return prepareApplicationConversationSubmission({ conversationId: this.options.conversationId,
      clientId: this.options.clientId, revision: this.control.canonicalRevision,
      operationId: this.options.createId?.() ?? crypto.randomUUID(), now: this.options.now?.() ?? new Date().toISOString(), input: captured });
  }
  async sendMessage(input: ConversationRuntimeSendMessageInput<TRequest>): Promise<ConversationDisplayTurnControl> {
    this.assertOpen();
    const captured = captureApplicationConversationInput(input), onAccepted = input.onAccepted;
    const saved = await this.options.pendingStore.load(this.options.conversationId); this.assertOpen();
    if (saved) throw new ApplicationConversationSessionError("pending_send_exists", "Retry the saved message before sending another one.");
    return this.submit(await this.prepare(captured), onAccepted);
  }
  async retryPending(onAccepted?: ConversationRuntimeSendMessageInput<TRequest>["onAccepted"]): Promise<ConversationDisplayTurnControl | null> {
    const saved = await this.options.pendingStore.load(this.options.conversationId); this.assertOpen();
    return saved ? this.submit(saved, onAccepted) : null;
  }
  submit(value: ApplicationConversationSubmission<TRequest>, onAccepted?: ConversationRuntimeSendMessageInput<TRequest>["onAccepted"]): Promise<ConversationDisplayTurnControl> {
    this.assertOpen();
    const saved = parseApplicationConversationSubmission<TRequest>(value, this.options.conversationId), json = JSON.stringify(saved);
    if (this.submission) {
      if (this.submission.json !== json) return Promise.reject(new ApplicationConversationSessionError("pending_send_exists", "Another message is being submitted."));
      this.acceptCallback(onAccepted); return this.submission.promise;
    }
    this.admitted = null; this.callbacks = []; this.acceptCallback(onAccepted);
    const promise = Promise.resolve().then(async () => {
      await this.options.pendingStore.retain(saved); this.assertOpen();
      this.publish({ hasPendingSubmission: true });
      const result = await this.options.resources.appendMutations(saved.admission); this.assertOpen();
      if (result.status !== "mutations" || result.acknowledgements.length !== saved.admission.mutations.length ||
        saved.admission.mutations.some(mutation => result.acknowledgements.filter(ack => ack.mutationId === mutation.mutationId && ["accepted", "duplicate"].includes(ack.status)).length !== 1)) {
        throw new ApplicationConversationSessionError("admission_unconfirmed", "The saved message could not be confirmed. Retry its original submission.", true);
      }
      const control = await this.options.reader.control({ conversationId: this.options.conversationId, turnId: saved.start.conversationTurnId }, this.lifetime.signal);
      this.assertOpen();
      if (control.status !== "ready" || !control.requestedTurn) throw new ApplicationConversationSessionError("admission_unconfirmed", "The saved turn is not visible yet.", true);
      await this.refresh(); this.assertOpen(); this.admitted = saved;
      for (const callback of this.callbacks.splice(0)) this.acceptCallback(callback);
      this.assertOpen();
      if (!terminal(control.requestedTurn)) {
        const started = await this.options.transport.startTurn(saved.start);
        if (!started.ok) throw new ApplicationConversationSessionError(started.error.code, started.error.message, started.error.retryable);
        if (this.lifetime.signal.aborted) { started.value.observation.disconnect(); this.assertOpen(); }
        if (started.value.conversationId !== this.options.conversationId || started.value.turnId !== saved.start.conversationTurnId || started.value.mutationId !== saved.start.mutationId) {
          started.value.observation.disconnect(); throw new ApplicationConversationSessionError("invalid_start", "The server acknowledged a different turn.");
        }
        this.observe(started.value.observation, saved.start.conversationTurnId);
      }
      await this.options.pendingStore.acknowledge(saved); this.assertOpen();
      this.publish({ hasPendingSubmission: false });
      return terminal(control.requestedTurn) ? control.requestedTurn : this.waitForTurn(saved.start.conversationTurnId);
    }).catch((cause: unknown) => { const error = normalize(cause); this.publish({ error }); throw error; })
      .finally(() => { this.submission = null; this.callbacks = []; this.admitted = null; this.publish({ submitting: false }); });
    this.submission = { json, promise }; this.publish({ submitting: true }); return promise;
  }
  private acceptCallback(callback: ConversationRuntimeSendMessageInput<TRequest>["onAccepted"]) {
    if (!callback || this.lifetime.signal.aborted) return;
    if (!this.admitted) { this.callbacks.push(callback); return; }
    try { callback({ conversationId: this.options.conversationId, messageId: this.admitted.messageId, turnId: this.admitted.start.conversationTurnId }); } catch { /* Presentation does not own admission. */ }
  }
  private observe(observation: TurnObservation<unknown>, turnId: string) {
    this.observation?.disconnect(); this.observation = observation; this.observationTurnId = turnId;
    void (async () => {
      try { for await (const _event of observation.events) { if (this.lifetime.signal.aborted) break; this.scheduleRefresh(); } }
      catch { /* The durable controls remain authoritative after disconnection. */ }
      finally { if (this.observation === observation) { this.observation = null; this.observationTurnId = null; } this.scheduleRefresh(); }
    })();
  }
  async waitForTurn(turnId: string, signal?: AbortSignal): Promise<ConversationDisplayTurnControl> {
    this.assertOpen();
    if (this.waits.size >= 32) throw new ApplicationConversationSessionError("observation_capacity", "Too many conversation observers.");
    const controller = new AbortController(), key = `${turnId}:${crypto.randomUUID()}`;
    this.waits.set(key, { turnId, controller });
    const lifetime = AbortSignal.any([this.lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    try {
      for (;;) {
        if (lifetime.aborted) throw new ApplicationConversationSessionError("observation_closed", "Conversation observation was closed.");
        try {
          const control = await this.options.reader.control({ conversationId: this.options.conversationId, turnId }, lifetime);
          if (lifetime.aborted) continue;
          if (control.status === "ready" && control.requestedTurn && terminal(control.requestedTurn)) {
            // Execution is already settled even when its display page is temporarily unavailable.
            await this.refresh().catch(cause => { if (denied(cause)) throw cause; });
            this.assertOpen(); return control.requestedTurn;
          }
        } catch (cause) { if (denied(cause)) throw normalize(cause); }
        await delay(this.pollMilliseconds, lifetime);
      }
    } finally { this.waits.delete(key); }
  }
  async cancelTurn(turnId: string, reason: ConversationTurnCancellationReason): Promise<"already_terminal" | "cancellation_requested"> {
    this.assertOpen();
    const control = await this.options.reader.control({ conversationId: this.options.conversationId, turnId }, this.lifetime.signal);
    this.assertOpen();
    if (control.status !== "ready" || !control.requestedTurn) throw new ApplicationConversationSessionError("turn_unavailable", "Refresh the conversation before stopping this response.", true);
    if (terminal(control.requestedTurn)) return "already_terminal";
    if (control.activeTurnId !== turnId) throw new ApplicationConversationSessionError("turn_changed", "The active response changed.", true);
    const capability = this.options.transport.capabilities.authoritativeCancellation;
    if (!capability.supported) throw new ApplicationConversationSessionError("cancellation_unavailable", "Stopping responses is unavailable.");
    const cancellation = this.cancellationIds.get(turnId) ?? { identity: `cancel_${crypto.randomUUID()}`, reason };
    this.cancellationIds.set(turnId, cancellation);
    while (this.cancellationIds.size > 32) this.cancellationIds.delete(this.cancellationIds.keys().next().value!);
    const result = await capability.capability.cancelTurn({ conversationId: this.options.conversationId,
      turnId, mutationId: cancellation.identity, idempotencyKey: cancellation.identity, reason: cancellation.reason });
    this.assertOpen();
    if (!result.ok) throw new ApplicationConversationSessionError(result.error.code, result.error.message, result.error.retryable);
    await this.refresh(); return result.value.status;
  }
  stopObserving(turnId: string): boolean {
    let stopped = false;
    for (const wait of this.waits.values()) if (wait.turnId === turnId) { wait.controller.abort(); stopped = true; }
    if (this.observationTurnId === turnId) {
      this.observation?.disconnect(); this.observation = null; this.observationTurnId = null; stopped = true;
    }
    return stopped;
  }
  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(); this.displayLifetime.abort(); clearTimeout(this.poll); clearTimeout(this.wake);
    const flushed = Promise.allSettled([this.draft?.dispose(), this.flushPosition()]).then(() => undefined);
    this.options.onLocalStateFlush?.(flushed);
    this.observation?.disconnect(); this.observation = null; this.observationTurnId = null; this.unsubscribeWindow(); this.window.dispose();
    this.control = null; this.related = Object.freeze([]); this.relatedCursor = null; this.relatedKey = "";
    this.admitted = null; this.submission = null; this.callbacks = []; this.cancellationIds.clear();
    this.state = Object.freeze({ kind: "display", conversationId: this.options.conversationId, control: null,
      window: this.window.getSnapshot(), related: this.related, hasMoreRelated: false, loading: false, submitting: false, hasPendingSubmission: false, error: null });
    this.listeners.clear();
  }
}
