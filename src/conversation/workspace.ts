import type { ConversationPresentationRuntime } from "./presentation.js";
import type { ConversationId } from "./events.js";
import type { ConversationRuntimeRegistry } from "./runtime-registry.js";
import type { ConversationRuntime } from "../runtime.js";

export type ConversationWorkspaceTurnStatus = "idle" | "running" | "completed" | "error";

export interface ConversationWorkspaceThreadSnapshot {
  readonly conversationId: ConversationId;
  readonly runtime: ConversationPresentationRuntime<unknown>;
  readonly turnStatus: ConversationWorkspaceTurnStatus;
  readonly unread: boolean;
  readonly revision: number | null;
}

export interface ConversationWorkspaceSnapshot {
  readonly selectedConversationId: ConversationId | null;
  readonly runningCount: number;
  /** Diagnostic count; use runningCount and unreadCount for attention indicators. */
  readonly errorCount: number;
  readonly unreadCount: number;
  readonly threads: readonly ConversationWorkspaceThreadSnapshot[];
}

export interface ConversationWorkspaceOpenInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId: ConversationId;
  readonly select?: boolean;
}

type Listener = () => void;

interface WorkspaceEntry<TRuntime> {
  readonly runtime: TRuntime;
  unsubscribe: () => void;
  turnStatus: ConversationWorkspaceTurnStatus;
  unread: boolean;
  revision: number | null;
}

export interface ConversationWorkspaceOptions {
  /** Idle runtime LRU bound. Running/submitting turns keep their scalar observer. */
  readonly maximumCachedIdleThreads?: number;
  readonly restoreActiveTurns?: boolean;
  readonly onRecoveryError?: (conversationId: ConversationId, error: unknown) => void;
}

function statusOf(runtime: ConversationPresentationRuntime<unknown>): ConversationWorkspaceTurnStatus {
  const state = runtime.store.getSnapshot();
  if (state.active_turn_id !== null) return "running";
  const latest = state.turns.at(-1);
  if (latest === undefined) return "idle";
  if (latest.status === "failed") return "error";
  if (latest.status === "completed" || latest.status === "cancelled" || latest.status === "waiting_for_approval") return "completed";
  return "running";
}

/**
 * Owns the UI-level lifetime of many registry runtimes. Selecting another
 * thread never releases the previous runtime, so its turn can finish in the
 * background and become unread.
 */
export class ConversationWorkspace<TRequest, TAuthorizationContext = unknown, TRuntime extends ConversationPresentationRuntime<TRequest> = ConversationRuntime<TRequest>> {
  readonly #registry: ConversationRuntimeRegistry<TRequest, TAuthorizationContext, TRuntime>;
  readonly #options: ConversationWorkspaceOptions;
  readonly #entries = new Map<ConversationId, WorkspaceEntry<TRuntime>>();
  readonly #listeners = new Set<Listener>();
  #selectedConversationId: ConversationId | null = null;
  #visible = true;
  #snapshot: ConversationWorkspaceSnapshot = Object.freeze({
    selectedConversationId: null, runningCount: 0, errorCount: 0, unreadCount: 0,
    threads: Object.freeze([]),
  });

  constructor(registry: ConversationRuntimeRegistry<TRequest, TAuthorizationContext, TRuntime>, options: ConversationWorkspaceOptions = {}) {
    if (options.maximumCachedIdleThreads !== undefined && (!Number.isSafeInteger(options.maximumCachedIdleThreads) ||
      options.maximumCachedIdleThreads < 1 || options.maximumCachedIdleThreads > 100)) throw new TypeError("Invalid idle conversation cache size");
    this.#registry = registry;
    this.#options = options;
  }

  getSnapshot = (): ConversationWorkspaceSnapshot => this.#snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async open(input: ConversationWorkspaceOpenInput<TAuthorizationContext>): Promise<TRuntime> {
    let entry = this.#entries.get(input.conversationId);
    if (entry === undefined) {
      // Selection belongs to the workspace; the registry accepts only the
      // catalog lookup fields and rejects extra options such as `select`.
      const runtime = await this.#registry.open({
        authorizationContext: input.authorizationContext,
        conversationId: input.conversationId,
      });
      // A foreground click can join the registry construction already started
      // by prefetch. Register only one subscription and recovery observer.
      entry = this.#entries.get(input.conversationId);
      if (entry === undefined) {
        entry = {
          runtime, unsubscribe: () => undefined, turnStatus: statusOf(runtime), unread: false,
          revision: runtime.store.getSnapshot().revision,
        };
        const captured = entry;
        captured.unsubscribe = runtime.store.subscribe(() => this.#update(input.conversationId, captured));
        this.#entries.set(input.conversationId, captured);
        if (this.#options.restoreActiveTurns === true) {
          // Recovery observes the whole run; never hold opening the UI until it finishes.
          void Promise.resolve().then(() => runtime.restoreActiveTurn()).catch((error: unknown) => {
            try { this.#options.onRecoveryError?.(input.conversationId, error); } catch { /* Diagnostics must not reject recovery. */ }
          });
        }
      }
    }
    if (input.select !== false) this.select(input.conversationId);
    else { entry.runtime.setSynchronizationActive?.(this.#selectedConversationId === input.conversationId && this.#visible); this.#publish(); }
    return entry.runtime;
  }

  select(conversationId: ConversationId | null): void {
    if (this.#selectedConversationId !== conversationId && this.#selectedConversationId !== null) {
      this.#entries.get(this.#selectedConversationId)?.runtime.setSynchronizationActive?.(false);
    }
    this.#selectedConversationId = conversationId;
    const selected = conversationId === null ? undefined : this.#entries.get(conversationId);
    if (selected && conversationId !== null) { this.#entries.delete(conversationId); this.#entries.set(conversationId, selected); }
    selected?.runtime.setSynchronizationActive?.(this.#visible);
    if (this.#visible && selected !== undefined) selected.unread = false;
    this.#trimIdleThreads();
    this.#publish();
  }

  /** Keep selection while a panel or browser tab is hidden without consuming replies. */
  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (this.#selectedConversationId !== null) {
      this.#entries.get(this.#selectedConversationId)?.runtime.setSynchronizationActive?.(visible);
    }
    if (visible && this.#selectedConversationId !== null) this.markRead(this.#selectedConversationId);
  }

  markRead(conversationId: ConversationId): void {
    const entry = this.#entries.get(conversationId);
    if (entry !== undefined && entry.unread) {
      entry.unread = false;
      this.#publish();
    }
  }

  async close(conversationId: ConversationId): Promise<boolean> {
    const entry = this.#entries.get(conversationId);
    if (entry === undefined) return false;
    entry.unsubscribe();
    this.#entries.delete(conversationId);
    if (this.#selectedConversationId === conversationId) this.#selectedConversationId = null;
    await this.#registry.release(conversationId);
    this.#publish();
    return true;
  }

  /** Picker-compatible view whose release is intentionally selection-neutral. */
  pickerRegistry(): Pick<ConversationRuntimeRegistry<TRequest, TAuthorizationContext, TRuntime>, "open" | "clear" | "archive" | "restore" | "permanentlyDelete"> & {
    release(conversationId: ConversationId): Promise<boolean>;
  } {
    return Object.freeze({
      open: async (input) => this.open({ ...input, select: true }),
      release: async () => false,
      clear: (input) => this.#registry.clear(input),
      archive: async (input) => { const result = await this.#registry.archive(input); await this.close(input.conversationId); return result; },
      restore: (input) => this.#registry.restore(input),
      permanentlyDelete: async (input) => { const result = await this.#registry.permanentlyDelete(input); await this.close(input.conversationId); return result; },
    });
  }

  async dispose(): Promise<void> {
    for (const entry of this.#entries.values()) entry.unsubscribe();
    this.#entries.clear();
    this.#selectedConversationId = null;
    this.#publish();
    await this.#registry.dispose();
  }

  #update(conversationId: ConversationId, entry: WorkspaceEntry<TRuntime>): void {
    const state = entry.runtime.store.getSnapshot();
    const previous = entry.turnStatus;
    entry.turnStatus = statusOf(entry.runtime);
    entry.revision = state.revision;
    if ((!this.#visible || this.#selectedConversationId !== conversationId) && previous === "running" &&
      (entry.turnStatus === "completed" || entry.turnStatus === "error")) entry.unread = true;
    this.#trimIdleThreads();
    this.#publish();
  }

  #publish(): void {
    const threads = Object.freeze([...this.#entries].map(([conversationId, entry]) => Object.freeze({
      conversationId, runtime: entry.runtime as ConversationPresentationRuntime<unknown>, turnStatus: entry.turnStatus,
      unread: entry.unread, revision: entry.revision,
    })));
    this.#snapshot = Object.freeze({
      selectedConversationId: this.#selectedConversationId,
      runningCount: threads.filter((thread) => thread.turnStatus === "running").length,
      errorCount: threads.filter((thread) => thread.turnStatus === "error").length,
      unreadCount: threads.filter((thread) => thread.unread).length,
      threads,
    });
    for (const listener of this.#listeners) listener();
  }

  #trimIdleThreads(): void {
    const limit = this.#options.maximumCachedIdleThreads;
    if (limit === undefined) return;
    const idle = [...this.#entries].filter(([, entry]) => entry.turnStatus !== "running" &&
      !entry.runtime.displaySession?.getSnapshot().submitting && !entry.runtime.displaySession?.getSnapshot().loading);
    let excess = idle.length - limit;
    for (const [id] of idle) {
      if (excess <= 0) break;
      if (id === this.#selectedConversationId) continue;
      excess--;
      void this.close(id).catch(error => { try { this.#options.onRecoveryError?.(id, error); } catch { /* Diagnostic only. */ } });
    }
  }
}
