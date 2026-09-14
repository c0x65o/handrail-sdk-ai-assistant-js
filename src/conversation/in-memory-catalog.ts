import type { ConversationId, ConversationTimestamp } from "./events.js";
import {
  ConversationCatalogError,
  authorizeConversationCatalogRequest,
  paginateConversationCatalogDescriptors,
  parseArchiveConversationInput,
  parseClearConversationInput,
  parseConversationCatalogCapabilities,
  parseConversationCatalogDescriptor,
  parseCreateConversationInput,
  parseGetConversationInput,
  parseListConversationsInput,
  parsePermanentlyDeleteConversationInput,
  parseRenameConversationInput,
  parseRestoreConversationInput,
  type ArchiveConversationInput,
  type ArchiveConversationResult,
  type ClearConversationInput,
  type ClearConversationResult,
  type ConversationCatalog,
  type ConversationCatalogAuthorizationAction,
  type ConversationCatalogAuthorizer,
  type ConversationCatalogCapabilities,
  type ConversationCatalogDescriptor,
  type ConversationCatalogIdempotencyKey,
  type ConversationCatalogMetadata,
  type ConversationCatalogVersion,
  type CreateConversationInput,
  type CreateConversationResult,
  type GetConversationInput,
  type GetConversationResult,
  type ListConversationsInput,
  type ListConversationsResult,
  type PermanentlyDeleteConversationInput,
  type PermanentlyDeleteConversationResult,
  type RenameConversationInput,
  type RenameConversationResult,
  type RestoreConversationInput,
  type RestoreConversationResult,
} from "./catalog.js";

export const IN_MEMORY_CONVERSATION_CATALOG_LIMITS = Object.freeze({
  recordCapacity: 1_000,
  tombstoneCapacity: 1_000,
  idempotencyEntryCapacity: 2_000,
} as const);

export interface InMemoryConversationCatalogLimits {
  /** Maximum live active and archived descriptors. New creates fail when full. */
  readonly maxRecords: number;
  /** Maximum permanently deleted identities. Deletes fail rather than evicting one. */
  readonly maxTombstones: number;
  /** Maximum replay entries. The oldest retained entry is evicted first. */
  readonly maxIdempotencyEntries: number;
}

export const DEFAULT_IN_MEMORY_CONVERSATION_CATALOG_LIMITS: Readonly<InMemoryConversationCatalogLimits> =
  Object.freeze({
    maxRecords: IN_MEMORY_CONVERSATION_CATALOG_LIMITS.recordCapacity,
    maxTombstones: IN_MEMORY_CONVERSATION_CATALOG_LIMITS.tombstoneCapacity,
    maxIdempotencyEntries:
      IN_MEMORY_CONVERSATION_CATALOG_LIMITS.idempotencyEntryCapacity,
  });

export interface ConversationCatalogClock {
  now(): ConversationTimestamp;
}

export type ConversationCatalogIdFactory = () =>
  | ConversationId
  | string
  | Promise<ConversationId | string>;

export interface InMemoryConversationCatalogOptions<TAuthorizationContext> {
  /** Required host-owned policy boundary. */
  readonly authorize: ConversationCatalogAuthorizer<TAuthorizationContext>;
  readonly clock?: ConversationCatalogClock;
  readonly createConversationId?: ConversationCatalogIdFactory;
  readonly limits?: Partial<InMemoryConversationCatalogLimits>;
}

type MutationOperation = Exclude<
  ConversationCatalogAuthorizationAction,
  "list" | "create" | "get"
>;
type CatalogMutationResult =
  | RenameConversationResult
  | ClearConversationResult
  | ArchiveConversationResult
  | RestoreConversationResult
  | PermanentlyDeleteConversationResult;
type CatalogIdempotencyResult = CreateConversationResult | CatalogMutationResult;

interface IdempotencyRecord {
  readonly operation: "create" | MutationOperation;
  readonly signature: string;
  readonly result: CatalogIdempotencyResult;
}

interface CreateSnapshot<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId?: ConversationId;
  readonly title: string | null;
  readonly metadata: ConversationCatalogMetadata;
  readonly idempotencyKey: ConversationCatalogIdempotencyKey;
  readonly signature: string;
}

interface MutationSnapshot<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId: ConversationId;
  readonly expectedVersion: ConversationCatalogVersion;
  readonly idempotencyKey: ConversationCatalogIdempotencyKey;
  readonly signature: string;
}

interface RenameSnapshot<TAuthorizationContext>
  extends MutationSnapshot<TAuthorizationContext> {
  readonly title: string;
}

const MAX_CONFIGURED_CAPACITY = 1_000_000;
const SUPPORTED_CAPABILITIES: ConversationCatalogCapabilities =
  parseConversationCatalogCapabilities({
    rename: { supported: true },
    clear: { supported: true },
    archive: { supported: true },
    restore: { supported: true },
    permanentDelete: { supported: true },
  });

/**
 * Bounded process-local lifecycle adapter for tests, examples, and development.
 *
 * It retains selection metadata only, never conversation contents. Records and
 * tombstones are capacity-rejecting so identities are not silently discarded;
 * replay history uses deterministic FIFO eviction. All state is instance-local.
 */
export class InMemoryConversationCatalog<TAuthorizationContext = unknown>
  implements ConversationCatalog<TAuthorizationContext>
{
  readonly capabilities = SUPPORTED_CAPABILITIES;

  readonly #authorize: ConversationCatalogAuthorizer<TAuthorizationContext>;
  readonly #clock: ConversationCatalogClock;
  readonly #createConversationId: ConversationCatalogIdFactory;
  readonly #limits: Readonly<InMemoryConversationCatalogLimits>;
  readonly #records = new Map<ConversationId, ConversationCatalogDescriptor>();
  readonly #tombstones = new Map<ConversationId, PermanentlyDeleteConversationResult>();
  readonly #idempotency = new Map<ConversationCatalogIdempotencyKey, IdempotencyRecord>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: InMemoryConversationCatalogOptions<TAuthorizationContext>) {
    if (typeof options?.authorize !== "function") {
      throw new TypeError("options.authorize must be a function");
    }
    this.#authorize = options.authorize;
    this.#clock = options.clock ?? {
      now: () => new Date().toISOString() as ConversationTimestamp,
    };
    if (typeof this.#clock.now !== "function") {
      throw new TypeError("options.clock.now must be a function");
    }
    this.#createConversationId = options.createConversationId ?? (() => {
      const randomUuid = globalThis.crypto?.randomUUID;
      if (typeof randomUuid !== "function") {
        throw new Error("A conversation ID factory is unavailable.");
      }
      return `conversation-${randomUuid.call(globalThis.crypto)}`;
    });
    if (typeof this.#createConversationId !== "function") {
      throw new TypeError("options.createConversationId must be a function");
    }
    this.#limits = resolveLimits(options.limits);
  }

  async list(
    input: ListConversationsInput<TAuthorizationContext>,
  ): Promise<ListConversationsResult> {
    const snapshot = parseListConversationsInput<TAuthorizationContext>(input);
    await authorizeConversationCatalogRequest(this.#authorize, {
      action: "list",
      authorizationContext: snapshot.authorizationContext,
    });
    await this.#mutationTail;
    const descriptors = [...this.#records.values()].filter((descriptor) =>
      snapshot.lifecycle === "all" || descriptor.lifecycle === snapshot.lifecycle);
    return paginateConversationCatalogDescriptors(descriptors, {
      pageSize: snapshot.pageSize,
      order: snapshot.order,
      ...(snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor }),
    });
  }

  async create(
    input: CreateConversationInput<TAuthorizationContext>,
  ): Promise<CreateConversationResult> {
    const snapshot = snapshotCreate(input);
    await authorizeConversationCatalogRequest(this.#authorize, {
      action: "create",
      authorizationContext: snapshot.authorizationContext,
      ...(snapshot.conversationId === undefined
        ? {}
        : { conversationId: snapshot.conversationId }),
    });
    return this.#serialize(() => this.#create(snapshot));
  }

  async get(
    input: GetConversationInput<TAuthorizationContext>,
  ): Promise<GetConversationResult> {
    const snapshot = parseGetConversationInput<TAuthorizationContext>(input);
    await authorizeConversationCatalogRequest(this.#authorize, {
      action: "get",
      authorizationContext: snapshot.authorizationContext,
      conversationId: snapshot.conversationId,
    });
    await this.#mutationTail;
    const descriptor = this.#records.get(snapshot.conversationId);
    if (descriptor === undefined) throw catalogError("not_found", "get");
    return Object.freeze({
      operation: "get",
      status: "found",
      descriptor: cloneDescriptor(descriptor),
    });
  }

  async rename(
    input: RenameConversationInput<TAuthorizationContext>,
  ): Promise<RenameConversationResult> {
    const snapshot = snapshotRename(input);
    await this.#authorizeMutation("rename", snapshot);
    return this.#serialize<RenameConversationResult>(() => {
      const replay = this.#replay("rename", snapshot);
      if (replay !== null) return replay as RenameConversationResult;
      const current = this.#current(snapshot, "rename");
      const next = this.#nextDescriptor(current, "rename", {
        title: snapshot.title,
      });
      const result = freezeResult({
        operation: "rename",
        status: "updated",
        descriptor: next,
      } satisfies RenameConversationResult);
      this.#commit(snapshot.idempotencyKey, "rename", snapshot.signature, result);
      return cloneResult(result);
    });
  }

  async clear(
    input: ClearConversationInput<TAuthorizationContext>,
  ): Promise<ClearConversationResult> {
    const snapshot = snapshotMutation(
      parseClearConversationInput<TAuthorizationContext>(input),
      "clear",
    );
    await this.#authorizeMutation("clear", snapshot);
    return this.#serialize<ClearConversationResult>(() => {
      const replay = this.#replay("clear", snapshot);
      if (replay !== null) return replay as ClearConversationResult;
      const current = this.#current(snapshot, "clear");
      if (current.lifecycle !== "active") throw catalogError("not_found", "clear");
      const next = this.#nextDescriptor(current, "clear", {});
      if (next.lifecycle !== "active") throw catalogError("unavailable", "clear");
      const result = freezeResult({
        operation: "clear",
        status: "cleared",
        descriptor: next,
      } satisfies ClearConversationResult);
      this.#commit(snapshot.idempotencyKey, "clear", snapshot.signature, result);
      return cloneResult(result);
    });
  }

  async archive(
    input: ArchiveConversationInput<TAuthorizationContext>,
  ): Promise<ArchiveConversationResult> {
    const snapshot = snapshotMutation(
      parseArchiveConversationInput<TAuthorizationContext>(input),
      "archive",
    );
    await this.#authorizeMutation("archive", snapshot);
    return this.#serialize<ArchiveConversationResult>(() => {
      const replay = this.#replay("archive", snapshot);
      if (replay !== null) return replay as ArchiveConversationResult;
      const current = this.#current(snapshot, "archive");
      if (current.lifecycle !== "active") throw catalogError("not_found", "archive");
      const now = this.#now("archive", current.updatedAt);
      const next = cloneDescriptor({
        ...current,
        lifecycle: "archived",
        archivedAt: now,
        updatedAt: now,
        version: nextVersion(current.version, "archive"),
      });
      if (next.lifecycle !== "archived") throw catalogError("unavailable", "archive");
      this.#records.set(next.conversationId, next);
      const result = freezeResult({
        operation: "archive",
        status: "archived",
        descriptor: next,
      } satisfies ArchiveConversationResult);
      this.#commit(snapshot.idempotencyKey, "archive", snapshot.signature, result);
      return cloneResult(result);
    });
  }

  async restore(
    input: RestoreConversationInput<TAuthorizationContext>,
  ): Promise<RestoreConversationResult> {
    const snapshot = snapshotMutation(
      parseRestoreConversationInput<TAuthorizationContext>(input),
      "restore",
    );
    await this.#authorizeMutation("restore", snapshot);
    return this.#serialize<RestoreConversationResult>(() => {
      const replay = this.#replay("restore", snapshot);
      if (replay !== null) return replay as RestoreConversationResult;
      const current = this.#current(snapshot, "restore");
      if (current.lifecycle !== "archived") throw catalogError("not_found", "restore");
      const now = this.#now("restore", current.updatedAt);
      const next = cloneDescriptor({
        ...current,
        lifecycle: "active",
        archivedAt: null,
        updatedAt: now,
        version: nextVersion(current.version, "restore"),
      });
      if (next.lifecycle !== "active") throw catalogError("unavailable", "restore");
      this.#records.set(next.conversationId, next);
      const result = freezeResult({
        operation: "restore",
        status: "restored",
        descriptor: next,
      } satisfies RestoreConversationResult);
      this.#commit(snapshot.idempotencyKey, "restore", snapshot.signature, result);
      return cloneResult(result);
    });
  }

  async permanentlyDelete(
    input: PermanentlyDeleteConversationInput<TAuthorizationContext>,
  ): Promise<PermanentlyDeleteConversationResult> {
    const snapshot = snapshotMutation(
      parsePermanentlyDeleteConversationInput<TAuthorizationContext>(input),
      "permanent_delete",
    );
    await this.#authorizeMutation("permanent_delete", snapshot);
    return this.#serialize<PermanentlyDeleteConversationResult>(() => {
      const replay = this.#replay("permanent_delete", snapshot);
      if (replay !== null) return replay as PermanentlyDeleteConversationResult;
      const current = this.#current(snapshot, "permanent_delete");
      if (this.#tombstones.size >= this.#limits.maxTombstones) {
        throw catalogError("unavailable", "permanent_delete");
      }
      const result = freezeResult({
        operation: "permanent_delete",
        status: "deleted",
        conversationId: current.conversationId,
        deletedVersion: current.version,
      } satisfies PermanentlyDeleteConversationResult);
      this.#records.delete(current.conversationId);
      this.#tombstones.set(current.conversationId, result);
      this.#commit(
        snapshot.idempotencyKey,
        "permanent_delete",
        snapshot.signature,
        result,
      );
      return cloneResult(result);
    });
  }

  async #create(
    snapshot: CreateSnapshot<TAuthorizationContext>,
  ): Promise<CreateConversationResult> {
    const replay = this.#replay("create", snapshot);
    if (replay !== null) return replay as CreateConversationResult;
    if (this.#records.size >= this.#limits.maxRecords) {
      throw catalogError("unavailable", "create");
    }
    const conversationId = snapshot.conversationId ?? await this.#generatedId();
    if (this.#records.has(conversationId) || this.#tombstones.has(conversationId)) {
      throw catalogError("idempotency_conflict", "create");
    }
    const now = this.#now("create");
    const descriptor = cloneDescriptor({
      conversationId,
      title: snapshot.title,
      createdAt: now,
      updatedAt: now,
      version: 1 as ConversationCatalogVersion,
      lifecycle: "active",
      archivedAt: null,
      metadata: snapshot.metadata,
    });
    if (descriptor.lifecycle !== "active") throw catalogError("unavailable", "create");
    const result = freezeResult({
      operation: "create",
      status: "created",
      descriptor,
    } satisfies CreateConversationResult);
    this.#records.set(conversationId, descriptor);
    this.#commit(snapshot.idempotencyKey, "create", snapshot.signature, result);
    return cloneResult(result);
  }

  async #authorizeMutation(
    operation: MutationOperation,
    snapshot: MutationSnapshot<TAuthorizationContext>,
  ): Promise<void> {
    await authorizeConversationCatalogRequest(this.#authorize, {
      action: operation,
      authorizationContext: snapshot.authorizationContext,
      conversationId: snapshot.conversationId,
    });
  }

  #current(
    snapshot: MutationSnapshot<TAuthorizationContext>,
    operation: MutationOperation,
  ): ConversationCatalogDescriptor {
    const current = this.#records.get(snapshot.conversationId);
    if (current === undefined) throw catalogError("not_found", operation);
    if (current.version !== snapshot.expectedVersion) {
      throw catalogError("version_conflict", operation);
    }
    return current;
  }

  #nextDescriptor(
    current: ConversationCatalogDescriptor,
    operation: "rename" | "clear",
    changes: { readonly title?: string },
  ): ConversationCatalogDescriptor {
    const next = cloneDescriptor({
      ...current,
      ...changes,
      updatedAt: this.#now(operation, current.updatedAt),
      version: nextVersion(current.version, operation),
    });
    this.#records.set(next.conversationId, next);
    return next;
  }

  #replay(
    operation: IdempotencyRecord["operation"],
    snapshot: { readonly idempotencyKey: ConversationCatalogIdempotencyKey; readonly signature: string },
  ): CatalogIdempotencyResult | null {
    const retained = this.#idempotency.get(snapshot.idempotencyKey);
    if (retained === undefined) return null;
    if (retained.operation !== operation || retained.signature !== snapshot.signature) {
      throw catalogError("idempotency_conflict", operation);
    }
    return cloneIdempotentResult(retained.result);
  }

  #commit(
    key: ConversationCatalogIdempotencyKey,
    operation: IdempotencyRecord["operation"],
    signature: string,
    result: CatalogIdempotencyResult,
  ): void {
    while (this.#idempotency.size >= this.#limits.maxIdempotencyEntries) {
      const oldest = this.#idempotency.keys().next().value as
        | ConversationCatalogIdempotencyKey
        | undefined;
      if (oldest === undefined) break;
      this.#idempotency.delete(oldest);
    }
    this.#idempotency.set(key, Object.freeze({
      operation,
      signature,
      result: cloneResult(result),
    }));
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #now(
    operation: ConversationCatalogAuthorizationAction,
    minimum?: ConversationTimestamp,
  ): ConversationTimestamp {
    let value: unknown;
    try {
      value = this.#clock.now();
    } catch {
      throw catalogError("unavailable", operation);
    }
    if (!isCanonicalTimestamp(value) || (minimum !== undefined && value < minimum)) {
      throw catalogError("unavailable", operation);
    }
    return value as ConversationTimestamp;
  }

  async #generatedId(): Promise<ConversationId> {
    let candidate: unknown;
    try {
      candidate = await this.#createConversationId();
      return parseCreateConversationInput({
        authorizationContext: null,
        conversationId: candidate,
        idempotencyKey: "generated-id-validation",
      }).conversationId!;
    } catch {
      throw catalogError("unavailable", "create");
    }
  }
}

function resolveLimits(
  overrides: Partial<InMemoryConversationCatalogLimits> | undefined,
): Readonly<InMemoryConversationCatalogLimits> {
  if (
    overrides !== undefined &&
    (overrides === null || typeof overrides !== "object" || Array.isArray(overrides))
  ) {
    throw new TypeError("options.limits must be an object");
  }
  const allowed = new Set([
    "maxRecords",
    "maxTombstones",
    "maxIdempotencyEntries",
  ]);
  if (
    overrides !== undefined &&
    Object.keys(overrides).some((name) => !allowed.has(name))
  ) {
    throw new TypeError("options.limits contains an unknown field");
  }
  const limits = { ...DEFAULT_IN_MEMORY_CONVERSATION_CATALOG_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > MAX_CONFIGURED_CAPACITY
    ) {
      throw new TypeError(
        `limits.${name} must be a positive safe integer no greater than ${MAX_CONFIGURED_CAPACITY}`,
      );
    }
  }
  return Object.freeze(limits);
}

function snapshotCreate<TAuthorizationContext>(
  input: CreateConversationInput<TAuthorizationContext>,
): CreateSnapshot<TAuthorizationContext> {
  const parsed = parseCreateConversationInput<TAuthorizationContext>(input);
  const metadata = parsed.metadata ?? Object.freeze({});
  const title = parsed.title ?? null;
  return Object.freeze({
    authorizationContext: parsed.authorizationContext,
    ...(parsed.conversationId === undefined
      ? {}
      : { conversationId: parsed.conversationId }),
    title,
    metadata,
    idempotencyKey: parsed.idempotencyKey,
    signature: canonicalStringify({
      conversationId: parsed.conversationId ?? null,
      title,
      metadata,
    }),
  });
}

function snapshotRename<TAuthorizationContext>(
  input: RenameConversationInput<TAuthorizationContext>,
): RenameSnapshot<TAuthorizationContext> {
  const parsed = parseRenameConversationInput<TAuthorizationContext>(input);
  return Object.freeze({
    ...snapshotMutation(parsed, "rename"),
    title: parsed.title,
    signature: canonicalStringify({
      conversationId: parsed.conversationId,
      expectedVersion: parsed.expectedVersion,
      title: parsed.title,
    }),
  });
}

function snapshotMutation<TAuthorizationContext>(
  parsed:
    | RenameConversationInput<TAuthorizationContext>
    | ClearConversationInput<TAuthorizationContext>
    | ArchiveConversationInput<TAuthorizationContext>
    | RestoreConversationInput<TAuthorizationContext>
    | PermanentlyDeleteConversationInput<TAuthorizationContext>,
  operation: MutationOperation,
): MutationSnapshot<TAuthorizationContext> {
  return Object.freeze({
    authorizationContext: parsed.authorizationContext,
    conversationId: parsed.conversationId,
    expectedVersion: parsed.expectedVersion,
    idempotencyKey: parsed.idempotencyKey,
    signature: canonicalStringify({
      operation,
      conversationId: parsed.conversationId,
      expectedVersion: parsed.expectedVersion,
    }),
  });
}

function cloneDescriptor(
  descriptor: ConversationCatalogDescriptor | Record<string, unknown>,
): ConversationCatalogDescriptor {
  return parseConversationCatalogDescriptor(descriptor);
}

function cloneResult<T extends CatalogIdempotencyResult>(result: T): T {
  if ("descriptor" in result) {
    return Object.freeze({
      ...result,
      descriptor: cloneDescriptor(result.descriptor),
    }) as unknown as T;
  }
  return Object.freeze({ ...result }) as unknown as T;
}

function cloneIdempotentResult(
  result: CatalogIdempotencyResult,
): CatalogIdempotencyResult {
  return cloneResult({ ...result, status: "idempotent" } as CatalogIdempotencyResult);
}

function freezeResult<T extends CatalogIdempotencyResult>(result: T): T {
  return cloneResult(result);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1);
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(",")}}`;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function nextVersion(
  current: ConversationCatalogVersion,
  operation: MutationOperation,
): ConversationCatalogVersion {
  if (current >= Number.MAX_SAFE_INTEGER) throw catalogError("unavailable", operation);
  return (current + 1) as ConversationCatalogVersion;
}

function catalogError(
  code: ConstructorParameters<typeof ConversationCatalogError>[0],
  operation: ConversationCatalogAuthorizationAction,
): ConversationCatalogError {
  return new ConversationCatalogError(code, operation);
}
