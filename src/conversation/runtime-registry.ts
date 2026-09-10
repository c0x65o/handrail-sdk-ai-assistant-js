import {
  parseArchiveConversationInput,
  parseClearConversationInput,
  parseConversationCatalogDescriptor,
  parseGetConversationInput,
  parsePermanentlyDeleteConversationInput,
  parseRestoreConversationInput,
  type ArchiveConversationInput,
  type ArchiveConversationResult,
  type ClearConversationInput,
  type ClearConversationResult,
  type ConversationCatalog,
  type ConversationCatalogDescriptor,
  type GetConversationInput,
  type PermanentlyDeleteConversationInput,
  type PermanentlyDeleteConversationResult,
  type RestoreConversationInput,
  type RestoreConversationResult,
} from "./catalog.js";
import type { ConversationId } from "./events.js";
import type { ConversationRuntime } from "../runtime.js";

export const CONVERSATION_RUNTIME_REGISTRY_LIMITS = Object.freeze({
  entriesDefault: 100,
  entriesMaximum: 10_000,
  concurrentConstructionsDefault: 8,
  concurrentConstructionsMaximum: 64,
} as const);

export interface ConversationRuntimeRegistryLimits {
  /** Live, pending, lifecycle-gated, and permanently deleted identities retained together. */
  readonly maxEntries: number;
  /** Distinct runtime factories executing concurrently. Same-ID opens share one execution. */
  readonly maxConcurrentConstructions: number;
}

export type ConversationRuntimeRegistryPolicyAction =
  | "open"
  | "clear"
  | "archive"
  | "restore"
  | "permanent_delete";

export interface ConversationRuntimeRegistryPolicyRequest<TAuthorizationContext> {
  readonly action: ConversationRuntimeRegistryPolicyAction;
  readonly authorizationContext: TAuthorizationContext;
  readonly descriptor: ConversationCatalogDescriptor;
}

/** Additional host-owned runtime/lifecycle policy applied after catalog authorization. */
export type ConversationRuntimeRegistryPolicy<TAuthorizationContext> = (
  request: ConversationRuntimeRegistryPolicyRequest<TAuthorizationContext>,
) => "allow" | "deny" | Promise<"allow" | "deny">;

export interface ConversationRuntimeFactoryInput<TAuthorizationContext> {
  readonly conversationId: ConversationId;
  readonly descriptor: ConversationCatalogDescriptor;
  readonly authorizationContext: TAuthorizationContext;
  /** Aborted when release, lifecycle mutation, permanent deletion, or disposal wins. */
  readonly signal: AbortSignal;
}

/** Event stores, transports, credentials, and all other runtime dependencies stay host-owned. */
export type ConversationRuntimeFactory<TRequest, TAuthorizationContext> = (
  input: ConversationRuntimeFactoryInput<TAuthorizationContext>,
) => ConversationRuntime<TRequest> | Promise<ConversationRuntime<TRequest>>;

export interface ConversationRuntimeRegistryOptions<TRequest, TAuthorizationContext> {
  readonly catalog: ConversationCatalog<TAuthorizationContext>;
  readonly createRuntime: ConversationRuntimeFactory<TRequest, TAuthorizationContext>;
  readonly authorize: ConversationRuntimeRegistryPolicy<TAuthorizationContext>;
  readonly limits?: Partial<ConversationRuntimeRegistryLimits>;
}

export interface ConversationRuntimeRegistrySnapshot {
  readonly disposed: boolean;
  readonly entryCount: number;
  readonly liveCount: number;
  readonly pendingCount: number;
  readonly lifecycleOperationCount: number;
  readonly tombstoneCount: number;
  readonly activeConstructionCount: number;
  readonly limits: Readonly<ConversationRuntimeRegistryLimits>;
}

export type ConversationRuntimeRegistryErrorCode =
  | "invalid_options"
  | "disposed"
  | "capacity_exhausted"
  | "policy_denied"
  | "lifecycle_in_progress"
  | "construction_invalidated"
  | "permanently_deleted";

const ERROR_MESSAGES: Readonly<Record<ConversationRuntimeRegistryErrorCode, string>> =
  Object.freeze({
    invalid_options: "The conversation runtime registry options are invalid.",
    disposed: "The conversation runtime registry has been disposed.",
    capacity_exhausted: "The conversation runtime registry capacity is exhausted.",
    policy_denied: "The conversation runtime registry operation is not permitted.",
    lifecycle_in_progress: "A conversation lifecycle operation is in progress.",
    construction_invalidated: "The conversation runtime construction was invalidated.",
    permanently_deleted: "The conversation identity was permanently deleted.",
  });

/** Stable, safe registry error that never includes host policy or factory details. */
export class ConversationRuntimeRegistryError extends Error {
  readonly code: ConversationRuntimeRegistryErrorCode;
  readonly retryable: boolean;

  constructor(code: ConversationRuntimeRegistryErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ConversationRuntimeRegistryError";
    this.code = code;
    this.retryable = code === "capacity_exhausted" ||
      code === "lifecycle_in_progress" ||
      code === "construction_invalidated";
  }
}

type RegistryEntry<TRequest> =
  | {
      kind: "pending";
      readonly controller: AbortController;
      promise: Promise<ConversationRuntime<TRequest>>;
      invalidation: ConversationRuntimeRegistryError | null;
    }
  | {
      readonly kind: "live";
      readonly runtime: ConversationRuntime<TRequest>;
    }
  | {
      readonly kind: "lifecycle";
      readonly action: Exclude<ConversationRuntimeRegistryPolicyAction, "open">;
      /** A live archive runtime stays usable until the host commits. */
      readonly retainedRuntime?: ConversationRuntime<TRequest>;
    }
  | {
      readonly kind: "deleted";
      readonly result: PermanentlyDeleteConversationResult;
    };

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1 ||
    (resolved as number) > maximum) {
    throw new ConversationRuntimeRegistryError("invalid_options");
  }
  return resolved as number;
}

function registryLimits(
  input: Partial<ConversationRuntimeRegistryLimits> | undefined,
): Readonly<ConversationRuntimeRegistryLimits> {
  if (input !== undefined &&
    (input === null || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) =>
        key !== "maxEntries" && key !== "maxConcurrentConstructions"))) {
    throw new ConversationRuntimeRegistryError("invalid_options");
  }
  return Object.freeze({
    maxEntries: boundedInteger(
      input?.maxEntries,
      CONVERSATION_RUNTIME_REGISTRY_LIMITS.entriesDefault,
      CONVERSATION_RUNTIME_REGISTRY_LIMITS.entriesMaximum,
    ),
    maxConcurrentConstructions: boundedInteger(
      input?.maxConcurrentConstructions,
      CONVERSATION_RUNTIME_REGISTRY_LIMITS.concurrentConstructionsDefault,
      CONVERSATION_RUNTIME_REGISTRY_LIMITS.concurrentConstructionsMaximum,
    ),
  });
}

/**
 * Framework-free coordinator for one lazy ConversationRuntime per catalog identity.
 *
 * Released identities may be opened again. Cleared identities remain openable.
 * Deleted identities retain bounded tombstones for this registry's entire lifetime.
 */
export class ConversationRuntimeRegistry<TRequest, TAuthorizationContext = unknown> {
  readonly #catalog: ConversationCatalog<TAuthorizationContext>;
  readonly #createRuntime: ConversationRuntimeFactory<TRequest, TAuthorizationContext>;
  readonly #authorize: ConversationRuntimeRegistryPolicy<TAuthorizationContext>;
  readonly #limits: Readonly<ConversationRuntimeRegistryLimits>;
  readonly #entries = new Map<ConversationId, RegistryEntry<TRequest>>();
  readonly #destroyedRuntimes = new WeakSet<object>();
  #activeConstructions = 0;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: ConversationRuntimeRegistryOptions<TRequest, TAuthorizationContext>) {
    if (options === null || typeof options !== "object" ||
      typeof options.createRuntime !== "function" ||
      typeof options.authorize !== "function" ||
      options.catalog === null || typeof options.catalog !== "object" ||
      typeof options.catalog.get !== "function") {
      throw new ConversationRuntimeRegistryError("invalid_options");
    }
    this.#catalog = options.catalog;
    this.#createRuntime = options.createRuntime;
    this.#authorize = options.authorize;
    this.#limits = registryLimits(options.limits);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getSnapshot(): ConversationRuntimeRegistrySnapshot {
    let liveCount = 0;
    let pendingCount = 0;
    let lifecycleOperationCount = 0;
    let tombstoneCount = 0;
    for (const entry of this.#entries.values()) {
      if (entry.kind === "live") liveCount += 1;
      else if (entry.kind === "pending") pendingCount += 1;
      else if (entry.kind === "lifecycle") lifecycleOperationCount += 1;
      else tombstoneCount += 1;
    }
    return Object.freeze({
      disposed: this.#disposed,
      entryCount: this.#entries.size,
      liveCount,
      pendingCount,
      lifecycleOperationCount,
      tombstoneCount,
      activeConstructionCount: this.#activeConstructions,
      limits: this.#limits,
    });
  }

  async open(
    input: GetConversationInput<TAuthorizationContext>,
  ): Promise<ConversationRuntime<TRequest>> {
    this.#assertUsable();
    const parsed = parseGetConversationInput<TAuthorizationContext>(input);
    const existing = this.#entries.get(parsed.conversationId);
    if (existing?.kind === "live") return existing.runtime;
    if (existing?.kind === "pending") return existing.promise;
    if (existing?.kind === "deleted") this.#fail("permanently_deleted");
    if (existing?.kind === "lifecycle") this.#fail("lifecycle_in_progress");
    this.#reserveEntryCapacity();
    if (this.#activeConstructions >= this.#limits.maxConcurrentConstructions) {
      this.#fail("capacity_exhausted");
    }

    const controller = new AbortController();
    const entry: Extract<RegistryEntry<TRequest>, { kind: "pending" }> = {
      kind: "pending",
      controller,
      promise: Promise.resolve(undefined as never),
      invalidation: null,
    };
    this.#entries.set(parsed.conversationId, entry);
    this.#activeConstructions += 1;
    entry.promise = this.#construct(parsed, entry).finally(() => {
      this.#activeConstructions -= 1;
    });
    return entry.promise;
  }

  /** Removes only the cached/pending runtime. Catalog identity and contents remain intact. */
  async release(conversationId: ConversationId): Promise<boolean> {
    this.#assertUsable();
    const parsedId = parseGetConversationInput({
      authorizationContext: undefined,
      conversationId,
    }).conversationId;
    const entry = this.#entries.get(parsedId);
    if (entry === undefined || entry.kind === "deleted") return false;
    if (entry.kind === "lifecycle") this.#fail("lifecycle_in_progress");
    this.#entries.delete(parsedId);
    if (entry.kind === "live") {
      this.#destroyRuntime(entry.runtime);
    } else {
      this.#invalidatePending(entry, "construction_invalidated");
      await entry.promise.catch(() => undefined);
    }
    return true;
  }

  async clear(
    input: ClearConversationInput<TAuthorizationContext>,
  ): Promise<ClearConversationResult> {
    const parsed = parseClearConversationInput<TAuthorizationContext>(input);
    return this.#mutate("clear", parsed, (value) => this.#catalog.clear(value));
  }

  async archive(
    input: ArchiveConversationInput<TAuthorizationContext>,
  ): Promise<ArchiveConversationResult> {
    const parsed = parseArchiveConversationInput<TAuthorizationContext>(input);
    return this.#mutate("archive", parsed, (value) => this.#catalog.archive(value));
  }

  async restore(
    input: RestoreConversationInput<TAuthorizationContext>,
  ): Promise<RestoreConversationResult> {
    const parsed = parseRestoreConversationInput<TAuthorizationContext>(input);
    return this.#mutate("restore", parsed, (value) => this.#catalog.restore(value));
  }

  async permanentlyDelete(
    input: PermanentlyDeleteConversationInput<TAuthorizationContext>,
  ): Promise<PermanentlyDeleteConversationResult> {
    const parsed = parsePermanentlyDeleteConversationInput<TAuthorizationContext>(input);
    return this.#mutate(
      "permanent_delete",
      parsed,
      (value) => this.#catalog.permanentlyDelete(value),
    );
  }

  /** Terminal and idempotent. It waits for every late factory result to be cleaned up. */
  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    const pending: Promise<unknown>[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.kind === "live") this.#destroyRuntime(entry.runtime);
      else if (entry.kind === "lifecycle" && entry.retainedRuntime !== undefined) {
        this.#destroyRuntime(entry.retainedRuntime);
      } else if (entry.kind === "pending") {
        this.#invalidatePending(entry, "disposed");
        pending.push(entry.promise);
      }
    }
    this.#entries.clear();
    this.#disposePromise = Promise.allSettled(pending).then(() => undefined);
    return this.#disposePromise;
  }

  async #construct(
    input: GetConversationInput<TAuthorizationContext>,
    entry: Extract<RegistryEntry<TRequest>, { kind: "pending" }>,
  ): Promise<ConversationRuntime<TRequest>> {
    try {
      const loaded = await this.#catalog.get(input);
      const descriptor = parseConversationCatalogDescriptor(loaded.descriptor);
      await this.#authorizeRequest("open", input.authorizationContext, descriptor);
      const runtime = await this.#createRuntime(Object.freeze({
        conversationId: input.conversationId,
        descriptor,
        authorizationContext: input.authorizationContext,
        signal: entry.controller.signal,
      }));
      if (this.#disposed || this.#entries.get(input.conversationId) !== entry) {
        this.#destroyRuntime(runtime);
        throw entry.invalidation ?? new ConversationRuntimeRegistryError("disposed");
      }
      this.#entries.set(input.conversationId, { kind: "live", runtime });
      return runtime;
    } catch (error) {
      if (this.#entries.get(input.conversationId) === entry) {
        this.#entries.delete(input.conversationId);
      }
      throw error;
    }
  }

  async #mutate<TInput extends {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
  }, TResult>(
    action: Exclude<ConversationRuntimeRegistryPolicyAction, "open">,
    input: TInput,
    execute: (input: TInput) => Promise<TResult>,
  ): Promise<TResult> {
    this.#assertUsable();
    const loaded = await this.#catalog.get({
      authorizationContext: input.authorizationContext,
      conversationId: input.conversationId,
    });
    const descriptor = parseConversationCatalogDescriptor(loaded.descriptor);
    await this.#authorizeRequest(action, input.authorizationContext, descriptor);
    this.#assertUsable();
    const existing = this.#entries.get(input.conversationId);
    if (existing?.kind === "deleted") this.#fail("permanently_deleted");
    if (existing?.kind === "lifecycle") this.#fail("lifecycle_in_progress");
    if (existing === undefined) this.#reserveEntryCapacity();
    const retainedRuntime = action === "archive" && existing?.kind === "live" ? existing.runtime : undefined;
    const operation: RegistryEntry<TRequest> = { kind: "lifecycle", action,
      ...(retainedRuntime === undefined ? {} : { retainedRuntime }) };
    this.#entries.set(input.conversationId, operation);
    if (existing?.kind === "live" && retainedRuntime === undefined) this.#destroyRuntime(existing.runtime);
    else if (existing?.kind === "pending") {
      this.#invalidatePending(
        existing,
        action === "permanent_delete"
          ? "permanently_deleted"
          : "construction_invalidated",
      );
    }

    try {
      const result = await execute(input);
      if (retainedRuntime !== undefined) this.#destroyRuntime(retainedRuntime);
      if (this.#entries.get(input.conversationId) === operation) {
        if (!this.#disposed && action === "permanent_delete") {
          this.#entries.set(input.conversationId, {
            kind: "deleted",
            result: result as PermanentlyDeleteConversationResult,
          });
        } else {
          this.#entries.delete(input.conversationId);
        }
      }
      return result;
    } catch (error) {
      if (this.#entries.get(input.conversationId) === operation) {
        if (retainedRuntime !== undefined && !this.#disposed) {
          this.#entries.set(input.conversationId, { kind: "live", runtime: retainedRuntime });
        } else {
          this.#entries.delete(input.conversationId);
        }
      }
      throw error;
    }
  }

  async #authorizeRequest(
    action: ConversationRuntimeRegistryPolicyAction,
    authorizationContext: TAuthorizationContext,
    descriptor: ConversationCatalogDescriptor,
  ): Promise<void> {
    try {
      const decision = await this.#authorize(Object.freeze({
        action,
        authorizationContext,
        descriptor,
      }));
      if (decision !== "allow") this.#fail("policy_denied");
    } catch (error) {
      if (error instanceof ConversationRuntimeRegistryError) throw error;
      this.#fail("policy_denied");
    }
  }

  #invalidatePending(
    entry: Extract<RegistryEntry<TRequest>, { kind: "pending" }>,
    code: "disposed" | "construction_invalidated" | "permanently_deleted",
  ): void {
    if (entry.invalidation !== null) return;
    const error = new ConversationRuntimeRegistryError(code);
    entry.invalidation = error;
    entry.controller.abort(error);
  }

  #destroyRuntime(runtime: ConversationRuntime<TRequest>): void {
    if (this.#destroyedRuntimes.has(runtime)) return;
    this.#destroyedRuntimes.add(runtime);
    runtime.destroy();
  }

  #reserveEntryCapacity(): void {
    if (this.#entries.size >= this.#limits.maxEntries) {
      this.#fail("capacity_exhausted");
    }
  }

  #assertUsable(): void {
    if (this.#disposed) this.#fail("disposed");
  }

  #fail(code: ConversationRuntimeRegistryErrorCode): never {
    throw new ConversationRuntimeRegistryError(code);
  }
}

export function createConversationRuntimeRegistry<TRequest, TAuthorizationContext = unknown>(
  options: ConversationRuntimeRegistryOptions<TRequest, TAuthorizationContext>,
): ConversationRuntimeRegistry<TRequest, TAuthorizationContext> {
  return new ConversationRuntimeRegistry(options);
}
