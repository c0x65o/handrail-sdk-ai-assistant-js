import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import type { ConversationDisplayWindow, ConversationDisplayWindowSnapshot } from "../client/display-window.js";
import type { ConversationDisplayRecord } from "../conversation/display-history.js";

export interface ConversationDisplayPosition {
  readonly messageId: string;
  readonly generation: number;
  /** Pixel displacement of the first visible message from the viewport top. */
  readonly offset: number;
  readonly following: boolean;
}
/** Account-scoped UI state; content is never saved through this interface. */
export interface ConversationDisplayPositionStore {
  get(conversationId: string): ConversationDisplayPosition | undefined;
  set(conversationId: string, position: ConversationDisplayPosition): void;
}
const empty: ConversationDisplayWindowSnapshot = Object.freeze({ conversationId: null, status: "loading", generation: 0,
  revision: 0, activeTurnId: null, records: Object.freeze([]), hasOlder: false, hasNewer: false, loading: null,
  error: null, version: 0, change: "initial", retainedBytes: 0 });

/** Owns selection and foreground-only polling, never a canonical runtime. */
export function useConversationDisplayWindow(controller: ConversationDisplayWindow, conversationId: string | null,
  options: { readonly visible?: boolean; readonly pollingMilliseconds?: number;
    readonly positions?: ConversationDisplayPositionStore } = {}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const positionStore = useRef(options.positions); positionStore.current = options.positions;
  useEffect(() => {
    const saved = conversationId ? positionStore.current?.get(conversationId) : undefined;
    void controller.select(conversationId, saved && !saved.following ? { messageId: saved.messageId,
      generation: saved.generation, direction: "newer", inclusive: true } : undefined).catch(() => {});
    return () => { void controller.select(null).catch(() => {}); };
  }, [controller, conversationId]);
  const polling = options.pollingMilliseconds ?? 1000;
  if (!Number.isFinite(polling) || polling < 0 || polling > 0 && polling < 100) throw new TypeError("Invalid display polling interval");
  useEffect(() => {
    if (!conversationId || options.visible === false || polling === 0) return;
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // Explicit terminal/permission errors wait for Retry; transient errors are retried on the next foreground tick.
      const error = controller.getSnapshot().error?.cause;
      if (error && typeof error === "object" && "retryable" in error && error.retryable === false) return;
      void controller.refresh().catch(() => {});
    };
    const timer = setInterval(poll, polling);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [controller, conversationId, options.visible, polling]);
  return state.conversationId === conversationId ? state : empty;
}

export interface ConversationDisplayTranscriptProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly controller: ConversationDisplayWindow;
  readonly conversationId: string | null;
  readonly positions?: ConversationDisplayPositionStore;
  readonly visible?: boolean;
  readonly pollingMilliseconds?: number;
  readonly renderMessage: (record: Extract<ConversationDisplayRecord, { kind: "message" }>) => ReactNode;
  /** Oversized records are explicit; opening their bounded content viewer is a separate action. */
  readonly renderDeferred?: (record: ConversationDisplayRecord) => ReactNode;
  readonly emptyState?: ReactNode;
  readonly children?: ReactNode;
}

/** A bounded DOM window with upward/downward paging and message-based anchors.
 * It deliberately does not manufacture a partial ConversationState. */
export function ConversationDisplayTranscript({ controller, conversationId, positions, visible,
  pollingMilliseconds, renderMessage, renderDeferred, emptyState, children, onScroll, ...props }: ConversationDisplayTranscriptProps) {
  const local = useRef({ controller, values: new Map<string, ConversationDisplayPosition>() });
  if (local.current.controller !== controller) local.current = { controller, values: new Map() };
  const localStore = useRef<ConversationDisplayPositionStore>({
    get: id => local.current.values.get(id),
    set: (id, position) => {
      local.current.values.delete(id); local.current.values.set(id, position);
      while (local.current.values.size > 32) local.current.values.delete(local.current.values.keys().next().value!);
    },
  });
  const store = positions ?? localStore.current;
  const state = useConversationDisplayWindow(controller, conversationId, { positions: store,
    ...(visible === undefined ? {} : { visible }), ...(pollingMilliseconds === undefined ? {} : { pollingMilliseconds }) });
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<ConversationDisplayPosition | undefined>(undefined);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const selected = useRef<{ controller: ConversationDisplayWindow; id: string | null } | null>(null);
  const previousVersion = useRef(-1);
  const capture = () => {
    const element = viewport.current;
    if (!element || !conversationId || !state.records.length) return;
    const top = element.getBoundingClientRect().top;
    const items = Array.from(element.querySelectorAll<HTMLElement>("[data-display-message]"));
    const first = items.find(item => item.getBoundingClientRect().bottom > top) ?? items[0];
    if (!first?.dataset.displayMessage) return;
    const position = { messageId: first.dataset.displayMessage, generation: state.generation,
      offset: first.getBoundingClientRect().top - top, following: following.current };
    anchor.current = position; store.set(conversationId, position);
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (selected.current?.id !== conversationId || selected.current.controller !== controller) {
      selected.current = { controller, id: conversationId }; previousVersion.current = -1;
      anchor.current = conversationId ? store.get(conversationId) : undefined;
      following.current = anchor.current?.following ?? true;
      setAway(!following.current);
    }
    if (previousVersion.current === state.version || !state.records.length) return;
    previousVersion.current = state.version;
    if (state.change === "latest" || following.current && !state.hasNewer && state.change !== "older") {
      element.scrollTop = element.scrollHeight; following.current = true; setAway(false);
    } else if (anchor.current && anchor.current.generation === state.generation) {
      const item = Array.from(element.querySelectorAll<HTMLElement>("[data-display-message]"))
        .find(item => item.dataset.displayMessage === anchor.current!.messageId);
      if (item) element.scrollTop += item.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset;
    }
    capture();
  });
  const load = (direction: "older" | "newer") => {
    capture(); if (direction === "older") { following.current = false; setAway(true); }
    void (direction === "older" ? controller.loadOlder() : controller.loadNewer());
  };
  useEffect(() => {
    if (following.current && state.hasNewer && state.loading === null && !state.error && state.status === "ready") {
      void controller.loadNewer();
    }
  }, [controller, state.hasNewer, state.loading, state.error, state.status]);
  useEffect(() => {
    const element = viewport.current, view = element?.ownerDocument.defaultView;
    if (!element || !view || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        if (following.current && !state.hasNewer) element.scrollTop = element.scrollHeight;
        else if (anchor.current && anchor.current.generation === state.generation) {
          const item = Array.from(element.querySelectorAll<HTMLElement>("[data-display-message]"))
            .find(item => item.dataset.displayMessage === anchor.current!.messageId);
          if (item) element.scrollTop += item.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset;
        }
        capture();
      });
    });
    observer.observe(element, { box: "border-box" });
    for (const item of Array.from(element.querySelectorAll("[data-display-message]"))) observer.observe(item, { box: "border-box" });
    return () => { observer.disconnect(); if (frame !== undefined) view.cancelAnimationFrame(frame); };
  }, [controller, conversationId, state.version, state.generation, state.hasNewer]);
  return <div className="hr-chat__transcript-wrap">
    <div {...props} ref={viewport} role={props.role ?? "log"} tabIndex={props.tabIndex ?? 0}
      style={{ ...props.style, overflowAnchor: "none" }}
      aria-label={props["aria-label"] ?? "Conversation transcript"} aria-live="off"
      aria-busy={state.loading !== null || state.status === "preparing"} onScroll={event => {
        onScroll?.(event); if (event.defaultPrevented) return;
        const element = event.currentTarget;
        following.current = !state.hasNewer && element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
        setAway(!following.current);
        capture();
        if (state.loading !== null || state.error || state.status !== "ready") return;
        if (element.scrollTop <= 96 && state.hasOlder) load("older");
        else if (element.scrollHeight - element.scrollTop - element.clientHeight <= 96 && state.hasNewer) load("newer");
      }}>
      {state.hasOlder && <button type="button" disabled={state.loading !== null} onClick={() => load("older")}>Load older messages</button>}
      {(state.status === "loading" || state.status === "preparing") && <p role="status">{state.status === "preparing" ? "Preparing conversation history…" : "Loading conversation…"}</p>}
      {state.records.map(record => record.kind === "message" && <article key={record.id} data-display-message={record.id}>
        {record.deferred ? renderDeferred?.(record) ?? <p>This message is too large for the history preview.</p> : renderMessage(record)}
      </article>)}
      {state.status === "ready" && state.records.length === 0 ? emptyState : null}
      {state.error && <div role="alert"><p>Conversation history could not be loaded.</p>
        <button type="button" disabled={state.loading !== null} onClick={() => { void controller.retry(); }}>Retry history</button></div>}
      {state.hasNewer && <button type="button" disabled={state.loading !== null} onClick={() => load("newer")}>Load newer messages</button>}
      {children}
    </div>
    {(state.hasNewer || away) && <button type="button" className="hr-chat__jump" disabled={state.loading !== null}
      onClick={() => { following.current = true; void controller.jumpToLatest(); }}>Jump to latest</button>}
  </div>;
}
