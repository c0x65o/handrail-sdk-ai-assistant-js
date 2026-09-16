import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConversationCatalog, ConversationCatalogCursor, ConversationCatalogDescriptor, ConversationCatalogIdempotencyKey } from "../conversation/catalog.js";
import { ConversationCatalogError } from "../conversation/catalog.js";
import type { ConversationId } from "../conversation/events.js";
import type { ConversationWorkspaceOpenInput } from "../conversation/workspace.js";
import type { ConversationRuntime } from "../runtime.js";
import { conversationMessageText } from "./message-actions.js";
import { useConversationActivitySnapshot, useConversationWorkspaceSnapshot,
  type ConversationActivityReadable, type ConversationActivityRecord, type ConversationWorkspaceReadable } from "./workspace.js";

export interface ConversationHistoryWorkspace<TRequest, TContext> extends ConversationWorkspaceReadable {
  open(input: ConversationWorkspaceOpenInput<TContext>): Promise<ConversationRuntime<TRequest>>;
  select(conversationId: ConversationId | null): void;
  markRead?(conversationId: ConversationId): void;
  close?(conversationId: ConversationId): Promise<boolean>;
}

export interface UseConversationHistoryOptions<TRequest, TContext> {
  readonly workspace: ConversationHistoryWorkspace<TRequest, TContext>;
  readonly catalog: ConversationCatalog<TContext>;
  readonly authorizationContext: TContext;
  readonly activity?: ConversationActivityReadable;
  readonly pageSize?: number;
  /** Optional background hydration for previews. Defaults to zero; opening a list never preloads other transcripts. */
  readonly preloadCount?: number;
  /** Retry failed history reads with bounded backoff. Defaults to true. Mutations never retry automatically. */
  readonly recover?: boolean;
  readonly autoSelect?: boolean;
  /** Create an initial thread after a successful empty active catalog read. One attempt per scope; failures require New to retry. */
  readonly autoCreate?: boolean;
  readonly refreshKey?: unknown;
  readonly createConversation?: (input: { readonly idempotencyKey: ConversationCatalogIdempotencyKey }) => Promise<ConversationWorkspaceOpenInput<TContext>>;
  readonly onConversationRead?: (conversationId: ConversationId, observed?: ConversationActivityRecord) => void | Promise<void>;
}

interface HistoryState {
  readonly descriptors: readonly ConversationCatalogDescriptor[];
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly error: string | null;
  readonly busyId: ConversationId | "create" | null;
  readonly failedThreads: ReadonlySet<ConversationId>;
  readonly nextCursor: ConversationCatalogCursor | null;
  readonly loadingMore: boolean;
  readonly loadMoreFailed: boolean;
  readonly retainedSelection: ConversationCatalogDescriptor | null;
}
const EMPTY: HistoryState = { descriptors: [], loading: true, loadFailed: false, error: null, busyId: null,
  failedThreads: new Set(), nextCursor: null, loadingMore: false, loadMoreFailed: false, retainedSelection: null };
const OPEN_ERROR = "This conversation could not be refreshed. Select another conversation or retry history.";
const identity = (prefix: string) => `${prefix}-${globalThis.crypto.randomUUID()}` as ConversationCatalogIdempotencyKey;

/** Shared catalog navigation, read recovery, preview hydration and lifecycle handling. */
export function useConversationHistory<TRequest, TContext>(options: UseConversationHistoryOptions<TRequest, TContext>) {
  const { workspace, catalog, authorizationContext } = options;
  const pageSize = options.pageSize ?? 50;
  const preloadCount = options.preloadCount ?? 0;
  if (!Number.isSafeInteger(preloadCount) || preloadCount < 0 || preloadCount > 100) throw new TypeError("History preloadCount must be between 0 and 100.");
  const scope = useMemo(() => ({ active: false, load: 0, selection: 0, mutation: false, initialCreationConsidered: false,
    view: "active" as "active" | "archived", paging: false, cursors: new Set<string>(),
    createKey: null as ConversationCatalogIdempotencyKey | null,
    mutationKeys: new Map<string, ConversationCatalogIdempotencyKey>(),
    refreshes: new Map<ConversationId, Promise<unknown>>() }), [workspace, catalog, authorizationContext]);
  const current = useRef(scope); current.current = scope;
  const latestOptions = useRef(options); latestOptions.current = options;
  const [saved, setSaved] = useState({ scope, value: EMPTY });
  const state = saved.scope === scope ? saved.value : EMPTY;
  const stateRef = useRef(state); stateRef.current = state;
  const [view, setView] = useState<"active" | "archived">("active");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  const activity = useConversationActivitySnapshot(workspace, options.activity);
  const isCurrent = useCallback(() => scope.active && current.current === scope, [scope]);
  const publish = useCallback((update: (value: HistoryState) => HistoryState) => {
    if (!isCurrent()) return;
    setSaved((previous) => ({ scope, value: update(previous.scope === scope ? previous.value : EMPTY) }));
  }, [scope, isCurrent]);
  const threadFailed = useCallback((id: ConversationId, failed: boolean) => publish((value) => {
    const failedThreads = new Set(value.failedThreads);
    if (failed) failedThreads.add(id); else failedThreads.delete(id);
    return { ...value, failedThreads, error: !failed && failedThreads.size === 0 && value.error === OPEN_ERROR ? null : value.error };
  }), [publish]);

  const open = useCallback(async (id: ConversationId, synchronize = false) => {
    const pending = scope.refreshes.get(id);
    if (pending) return pending;
    const work = (async () => {
      const loaded = workspace.getSnapshot().threads.find((thread) => thread.conversationId === id);
      const runtime = loaded?.runtime ?? await workspace.open({ authorizationContext, conversationId: id, select: false });
      if (!isCurrent()) return;
      if (synchronize && loaded) await runtime.synchronize?.();
      threadFailed(id, false);
    })();
    scope.refreshes.set(id, work);
    try { return await work; }
    catch (error) { threadFailed(id, true); throw error; }
    finally { if (scope.refreshes.get(id) === work) scope.refreshes.delete(id); }
  }, [scope, workspace, authorizationContext, isCurrent, threadFailed]);

  const refresh = useCallback(async () => {
    if (!isCurrent()) return;
    const generation = ++scope.load;
    scope.paging = false;
    scope.cursors.clear();
    const selection = scope.selection;
    const failedBefore = [...stateRef.current.failedThreads];
    const retained = () => isCurrent() && generation === scope.load;
    publish((value) => ({ ...value, loading: true, loadingMore: false, loadMoreFailed: false }));
    try {
      const page = await catalog.list({ authorizationContext, lifecycle: scope.view, pageSize,
        order: { field: "updated_at", direction: "desc" } });
      if (!retained()) return;
      if (page.hasMore && !page.nextCursor) throw new Error("Conversation history pagination did not advance.");
      const descriptors = [...new Map(page.items.map((descriptor) => [descriptor.conversationId, descriptor])).values()];
      const selectedId = workspace.getSnapshot().selectedConversationId;
      let retainedSelection: ConversationCatalogDescriptor | null = null;
      // A selected older chat need not be on the refreshed first page. Read only
      // its descriptor so title/lifecycle controls remain authoritative.
      if (selectedId && !descriptors.some(row => row.conversationId === selectedId)) {
        try { retainedSelection = (await catalog.get({ authorizationContext, conversationId: selectedId })).descriptor; }
        catch (error) {
          if (!(error instanceof ConversationCatalogError) || !["not_found", "forbidden"].includes(error.code)) throw error;
          if (retained() && selection === scope.selection && workspace.getSnapshot().selectedConversationId === selectedId) workspace.select(null);
        }
        if (!retained()) return;
      }
      publish((value) => ({ ...value, descriptors, loading: false, loadFailed: false,
        retainedSelection,
        nextCursor: page.hasMore ? page.nextCursor : null,
        failedThreads: new Set([...value.failedThreads].filter((id) => descriptors.some((descriptor) => descriptor.conversationId === id))) }));
      const attempted = new Set<ConversationId>();
      const active = descriptors.filter((descriptor) => descriptor.lifecycle === "active");
      // Failed saved history never creates a replacement conversation or blocks navigation.
      if (latestOptions.current.autoSelect !== false && workspace.getSnapshot().selectedConversationId === null) {
        for (const descriptor of descriptors) {
          if (!retained() || selection !== scope.selection || workspace.getSnapshot().selectedConversationId !== null) break;
          try {
            attempted.add(descriptor.conversationId);
            await open(descriptor.conversationId);
            if (retained() && selection === scope.selection && workspace.getSnapshot().selectedConversationId === null) workspace.select(descriptor.conversationId);
            break;
          } catch { /* Try another saved thread; retain the failed one for retry. */ }
        }
      }
      for (const descriptor of active.slice(0, preloadCount)) {
        if (!retained()) return;
        if (attempted.has(descriptor.conversationId) || workspace.getSnapshot().threads.some((thread) => thread.conversationId === descriptor.conversationId)) continue;
        try { await open(descriptor.conversationId); } catch { /* Expose a per-thread recovery state. */ }
      }
      for (const id of failedBefore) {
        if (!retained()) return;
        if (!descriptors.some((descriptor) => descriptor.conversationId === id)) continue;
        try { await open(id, true); } catch { /* A manual refresh also retries failed cached history. */ }
      }
    } catch {
      if (retained()) publish((value) => ({ ...value, loading: false, loadFailed: true }));
    }
  }, [scope, catalog, authorizationContext, pageSize, preloadCount, workspace, isCurrent, publish, open]);

  const loadMore = useCallback(async () => {
    const cursor = stateRef.current.nextCursor;
    if (!isCurrent() || scope.paging || stateRef.current.loading || !cursor) return;
    const generation = scope.load;
    scope.paging = true;
    publish(value => ({ ...value, loadingMore: true, loadMoreFailed: false }));
    try {
      const page = await catalog.list({ authorizationContext, lifecycle: scope.view, pageSize,
        order: { field: "updated_at", direction: "desc" }, cursor });
      if (!isCurrent() || generation !== scope.load) return;
      if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor || scope.cursors.has(page.nextCursor))) {
        throw new Error("Conversation history pagination did not advance.");
      }
      scope.cursors.add(cursor);
      publish(value => {
        const rows = new Map(value.descriptors.map(row => [row.conversationId, row]));
        for (const row of page.items) {
          const previous = rows.get(row.conversationId);
          if (!previous || row.version > previous.version) rows.set(row.conversationId, row);
        }
        return { ...value, descriptors: [...rows.values()], nextCursor: page.hasMore ? page.nextCursor : null };
      });
    } catch {
      if (isCurrent() && generation === scope.load) publish(value => ({ ...value, loadMoreFailed: true }));
    } finally {
      if (isCurrent() && generation === scope.load) {
        scope.paging = false;
        publish(value => ({ ...value, loadingMore: false }));
      }
    }
  }, [scope, catalog, authorizationContext, pageSize, isCurrent, publish]);

  useEffect(() => {
    scope.active = true;
    scope.view = "active";
    setView("active"); setUnreadOnly(false);
    return () => { scope.active = false; scope.load++; scope.selection++; scope.refreshes.clear(); };
  }, [scope]);
  useEffect(() => { void refresh(); }, [refresh, options.refreshKey]);

  const select = useCallback(async (descriptor: ConversationCatalogDescriptor) => {
    if (!isCurrent()) return;
    const generation = ++scope.selection;
    publish((value) => ({ ...value, error: null }));
    const loaded = workspace.getSnapshot().threads.some((thread) => thread.conversationId === descriptor.conversationId);
    if (loaded) workspace.select(descriptor.conversationId);
    try {
      await open(descriptor.conversationId, true);
      if (!isCurrent() || generation !== scope.selection) return;
      if (!loaded) workspace.select(descriptor.conversationId);
      const observed = latestOptions.current.activity?.getSnapshot().find((record) => record.conversationId === descriptor.conversationId);
      workspace.markRead?.(descriptor.conversationId);
      await latestOptions.current.onConversationRead?.(descriptor.conversationId, observed);
    } catch {
      if (isCurrent() && generation === scope.selection) publish((value) => ({ ...value,
        error: OPEN_ERROR }));
    }
  }, [scope, workspace, open, isCurrent, publish]);

  const changeView = useCallback((next: "active" | "archived") => {
    if (!isCurrent() || scope.view === next) return;
    scope.view = next;
    setView(next);
    ++scope.selection;
    workspace.select(null);
    publish(value => ({ ...EMPTY, busyId: value.busyId }));
    void refresh();
  }, [scope, workspace, isCurrent, publish, refresh]);

  const create = useCallback(async () => {
    if (!isCurrent() || scope.mutation) return;
    scope.mutation = true;
    const selection = ++scope.selection;
    scope.createKey ??= identity("conversation");
    publish((value) => ({ ...value, busyId: "create", error: null }));
    try {
      const createConversation = latestOptions.current.createConversation;
      const input = createConversation ? await createConversation({ idempotencyKey: scope.createKey })
        : { authorizationContext, conversationId: (await catalog.create({ authorizationContext, idempotencyKey: scope.createKey })).descriptor.conversationId };
      if (!isCurrent()) return;
      await workspace.open({ ...input, select: false });
      if (!isCurrent()) return;
      scope.createKey = null;
      if (selection === scope.selection) { workspace.select(input.conversationId); scope.view = "active"; setView("active"); setUnreadOnly(false); }
      await refresh();
    } catch { publish((value) => ({ ...value, error: "A new conversation could not be opened. Select New to retry." })); }
    finally { scope.mutation = false; publish((value) => ({ ...value, busyId: null })); }
  }, [scope, catalog, authorizationContext, workspace, refresh, isCurrent, publish]);

  useEffect(() => {
    if (!options.autoCreate || state.loading || state.loadFailed || scope.initialCreationConsidered || !isCurrent()) return;
    scope.initialCreationConsidered = true;
    if (view === "active" && !state.descriptors.some(item => item.lifecycle === "active") &&
      workspace.getSnapshot().selectedConversationId === null && !scope.mutation) void create();
  }, [options.autoCreate, state.loading, state.loadFailed, state.descriptors, scope, isCurrent, view, workspace, create]);

  const changeLifecycle = useCallback(async (descriptor: ConversationCatalogDescriptor) => {
    if (!isCurrent() || scope.mutation) return;
    scope.mutation = true;
    publish((value) => ({ ...value, busyId: descriptor.conversationId, error: null }));
    const restoring = descriptor.lifecycle === "archived";
    try {
      const key = JSON.stringify([descriptor.conversationId, descriptor.version, restoring]);
      const idempotencyKey = scope.mutationKeys.get(key) ?? identity(restoring ? "restore" : "archive");
      scope.mutationKeys.set(key, idempotencyKey);
      const input = { authorizationContext, conversationId: descriptor.conversationId, expectedVersion: descriptor.version, idempotencyKey };
      if (restoring) await catalog.restore(input); else await catalog.archive(input);
      scope.mutationKeys.delete(key);
      if (!isCurrent()) return;
      // Only release a runtime after the authorized lifecycle mutation succeeds.
      // Detach React consumers before releasing the store. In particular, a
      // pending passive effect must not subscribe to a destroyed runtime.
      flushSync(() => {
        if (workspace.getSnapshot().selectedConversationId === descriptor.conversationId) workspace.select(null);
        publish((value) => ({ ...value, descriptors: value.descriptors.filter((item) => item.conversationId !== descriptor.conversationId) }));
      });
      await workspace.close?.(descriptor.conversationId);
      if (restoring) { scope.view = "active"; setView("active"); }
      await refresh();
    } catch {
      if (isCurrent()) {
        await refresh();
        publish((value) => ({ ...value, error: restoring ? "Conversation could not be restored." : "Conversation could not be archived." }));
      }
    } finally { scope.mutation = false; publish((value) => ({ ...value, busyId: null })); }
  }, [scope, catalog, authorizationContext, workspace, refresh, isCurrent, publish]);

  const needsRecovery = state.loadFailed || state.failedThreads.size > 0;
  useEffect(() => {
    if (!needsRecovery || options.recover === false) return;
    let stopped = false, delay = 1_000;
    let timer: ReturnType<typeof setTimeout>;
    const retry = async () => {
      if (!isCurrent() || stopped) return;
      if (stateRef.current.loadFailed) await refresh();
      for (const id of stateRef.current.failedThreads) {
        if (!isCurrent() || stopped) return;
        const selection = scope.selection;
        try {
          await open(id, true);
          if (isCurrent() && !stopped && latestOptions.current.autoSelect !== false && selection === scope.selection &&
            workspace.getSnapshot().selectedConversationId === null &&
            stateRef.current.descriptors.some((descriptor) => descriptor.conversationId === id && descriptor.lifecycle === "active")) workspace.select(id);
        } catch { /* Back off before the next read. */ }
      }
      if (!isCurrent() || stopped) return;
      delay = Math.min(delay * 2, 30_000);
      timer = setTimeout(() => { void retry(); }, delay);
    };
    timer = setTimeout(() => { void retry(); }, delay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [needsRecovery, options.recover, refresh, open, isCurrent, scope, workspace]);

  const unreadCount = state.descriptors.filter((descriptor) => descriptor.lifecycle === "active" &&
    activity.some((record) => record.conversationId === descriptor.conversationId && record.unread)).length;
  const visible = state.descriptors.filter((descriptor) => descriptor.lifecycle === view &&
    (view !== "active" || !unreadOnly || activity.some((record) => record.conversationId === descriptor.conversationId && record.unread)));
  const preview = (descriptor: ConversationCatalogDescriptor) => {
    const record = activity.find((item) => item.conversationId === descriptor.conversationId);
    if (record?.turnStatus === "running") return record.summary ?? "Working on this conversation…";
    if (state.failedThreads.has(descriptor.conversationId)) return "Reconnecting to conversation history…";
    if (record?.turnStatus === "error") return "The last request failed. Open for details.";
    const message = snapshot.threads.find((thread) => thread.conversationId === descriptor.conversationId)?.runtime.getSnapshot().messages.at(-1);
    return message ? conversationMessageText(message).replace(/\s+/gu, " ").slice(0, 120) : "Open conversation";
  };
  return { ...state, view, setView: changeView, unreadOnly, setUnreadOnly, unreadCount, visible, activity, snapshot,
    selected: state.descriptors.find((descriptor) => descriptor.conversationId === snapshot.selectedConversationId) ??
      (state.retainedSelection?.conversationId === snapshot.selectedConversationId ? state.retainedSelection : null),
    capabilities: catalog.capabilities, refresh, loadMore, hasMore: state.nextCursor !== null, select, create, changeLifecycle, preview };
}

export type ConversationHistoryController = ReturnType<typeof useConversationHistory>;
