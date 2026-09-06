import type { ConversationId } from "./events.js";
import type { ConversationRuntimeRegistry } from "./runtime-registry.js";
import type { ConversationRuntime } from "../runtime.js";

export type ConversationWorkspaceTurnStatus = "idle" | "running" | "completed" | "error";

export interface ConversationWorkspaceThreadSnapshot {
  readonly conversationId: ConversationId;
  readonly runtime: ConversationRuntime<unknown>;
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

interface WorkspaceEntry<TRequest> {
  readonly runtime: ConversationRuntime<TRequest>;
  unsubscribe: () => void;
  turnStatus: ConversationWorkspaceTurnStatus;
  unread: boolean;
  revision: number | null;
}

export interface ConversationWorkspaceOptions {
  readonly restoreActiveTurns?: boolean;
  readonly onRecoveryError?: (conversationId: ConversationId, error: unknown) => void;
}

function statusOf(runtime: ConversationRuntime<unknown>): ConversationWorkspaceTurnStatus {
  const state = runtime.store.getSnapshot();
  if (state.active_turn_id !== null) return "running";
  const latest = state.turns.at(-1);
  if (latest === undefined) return "idle";
  if (latest.status === "failed") return "error";
  if (latest.status === "completed" || latest.status === "cancelled") return "completed";
  return "running";
}

/**
 * Owns the UI-level lifetime of many registry runtimes. Selecting another
 * thread never releases the previous runtime, so its turn can finish in the
 * background and become unread.
 */
export class ConversationWorkspace<TRequest, TAuthorizationContext = unknown> {
  readonly #registry: ConversationRuntimeRegistry<TRequest, TAuthorizationContext>;
  readonly #options: ConversationWorkspaceOptions;
  readonly #entries = new Map<ConversationId, WorkspaceEntry<TRequest>>();
  readonly #listeners = new Set<Listener>();
  #selectedConversationId: ConversationId | null = null;
  #visible = true;
  #snapshot: ConversationWorkspaceSnapshot = Object.freeze({
    selectedConversationId: null, runningCount: 0, errorCount: 0, unreadCount: 0,
    threads: Object.freeze([]),
  });

  constructor(registry: ConversationRuntimeRegistry<TRequest, TAuthorizationContext>, options: ConversationWorkspaceOptions = {}) {
    this.#registry = registry;
    this.#options = options;
  }

  getSnapshot = (): ConversationWorkspaceSnapshot => this.#snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async open(input: ConversationWorkspaceOpenInput<TAuthorizationContext>): Promise<ConversationRuntime<TRequest>> {
    let entry = this.#entries.get(input.conversationId);
    if (entry === undefined) {
      const runtime = await this.#registry.open(input);
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
    if (input.select !== false) this.select(input.conversationId);
    else this.#publish();
    return entry.runtime;
  }

  select(conversationId: ConversationId | null): void {
    this.#selectedConversationId = conversationId;
    const selected = conversationId === null ? undefined : this.#entries.get(conversationId);
    if (this.#visible && selected !== undefined) selected.unread = false;
    this.#publish();
  }

  /** Keep selection while a panel or browser tab is hidden without consuming replies. */
  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
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
  pickerRegistry(): Pick<ConversationRuntimeRegistry<TRequest, TAuthorizationContext>, "open" | "clear" | "archive" | "restore" | "permanentlyDelete"> & {
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

  #update(conversationId: ConversationId, entry: WorkspaceEntry<TRequest>): void {
    const state = entry.runtime.store.getSnapshot();
    const previous = entry.turnStatus;
    entry.turnStatus = statusOf(entry.runtime);
    entry.revision = state.revision;
    if ((!this.#visible || this.#selectedConversationId !== conversationId) && previous === "running" &&
      (entry.turnStatus === "completed" || entry.turnStatus === "error")) entry.unread = true;
    this.#publish();
  }

  #publish(): void {
    const threads = Object.freeze([...this.#entries].map(([conversationId, entry]) => Object.freeze({
      conversationId, runtime: entry.runtime as ConversationRuntime<unknown>, turnStatus: entry.turnStatus,
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
}
