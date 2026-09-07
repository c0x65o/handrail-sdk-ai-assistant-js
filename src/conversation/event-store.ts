import {
  parseConversationEvent,
  type ConversationClientMutationId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationRevision,
} from "./events.js";

declare const opaqueConversationEventCursor: unique symbol;

/**
 * An opaque position returned by a ConversationEventStore.
 *
 * Cursors are scoped to the store instance and conversation that produced them.
 * Callers must not parse, construct, or compare their contents.
 */
export type ConversationEventCursor = string & {
  readonly [opaqueConversationEventCursor]: "ConversationEventCursor";
};

export interface StoredConversationEvent {
  readonly cursor: ConversationEventCursor;
  readonly event: ConversationEvent;
}

export interface AppendConversationEventsInput {
  readonly conversationId: ConversationId;
  /** `null` means the caller expects the conversation to contain no events. */
  readonly expectedRevision: ConversationRevision | null;
  /**
   * A non-empty, contiguous batch. The first event revision must be one greater
   * than expectedRevision (or 1 when expectedRevision is null).
   */
  readonly events: readonly ConversationEvent[];
}

export interface AppendConversationEventsResult {
  /** `idempotent` means the complete batch was already durably represented. */
  readonly status: "appended" | "idempotent";
  /** The stored entries, including the original durable identities on a retry. */
  readonly entries: readonly StoredConversationEvent[];
  readonly latestRevision: ConversationRevision;
}

export type ConversationEventReadPosition =
  | {
      /** Read strictly after this store-issued cursor. */
      readonly cursor: ConversationEventCursor;
      readonly revision?: never;
    }
  | {
      /** Read events whose revision is strictly greater than this revision. */
      readonly revision: ConversationRevision;
      readonly cursor?: never;
    };

export interface ReadConversationEventsInput {
  readonly conversationId: ConversationId;
  /** Omit to read from the first event. */
  readonly after?: ConversationEventReadPosition;
  /** A positive safe integer. Stores may apply a default page size; follow hasMore/nextCursor. */
  readonly limit?: number;
}

export interface ReadConversationEventsResult {
  readonly entries: readonly StoredConversationEvent[];
  /** Cursor of the final returned entry, or null when no entry was returned. */
  readonly nextCursor: ConversationEventCursor | null;
  /** Latest revision observed atomically with this read, or null when empty. */
  readonly latestRevision: ConversationRevision | null;
  readonly hasMore: boolean;
}

/** A compact, JSON-safe state snapshot after applying `revision`. */
export interface ConversationEventCheckpoint {
  readonly conversationId: ConversationId;
  /** Projection schema used to encode `state`; absent checkpoints are legacy. */
  readonly schemaVersion?: number;
  readonly revision: ConversationRevision;
  readonly state: ConversationJsonValue;
}

export interface WriteConversationEventCheckpointResult {
  readonly status: "written" | "idempotent";
  readonly checkpoint: ConversationEventCheckpoint;
}

/**
 * Optional compact-checkpoint capability.
 *
 * Implementations retain at most their latest checkpoint per conversation.
 * Writes must be monotonic. Repeating an identical checkpoint is idempotent;
 * replacing a revision with different state or writing an older revision fails.
 */
export interface ConversationEventCheckpointStore {
  read(
    conversationId: ConversationId,
  ): Promise<ConversationEventCheckpoint | null>;
  write(
    checkpoint: ConversationEventCheckpoint,
  ): Promise<WriteConversationEventCheckpointResult>;
}

/**
 * Transport- and platform-independent persistence boundary for conversation
 * event logs.
 *
 * `append` is atomic for the complete batch. A non-idempotent append succeeds
 * only when expectedRevision equals the current latest revision (`null` for an
 * empty log); otherwise it throws ConversationEventStoreConflictError without
 * writing any event. Reusing an event ID or client mutation ID is idempotent
 * only when the complete request represents the already-stored fact or mutation.
 */
export interface ConversationEventStore {
  readonly checkpoints?: ConversationEventCheckpointStore;
  append(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult>;
  read(
    input: ReadConversationEventsInput,
  ): Promise<ReadConversationEventsResult>;
  getLatestRevision(
    conversationId: ConversationId,
  ): Promise<ConversationRevision | null>;
}

export type ConversationEventStoreConflictCode =
  | "revision_conflict"
  | "idempotency_conflict"
  | "invalid_append"
  | "cursor_not_found"
  | "checkpoint_conflict";

export interface ConversationEventStoreConflictDetails {
  readonly code: ConversationEventStoreConflictCode;
  readonly conversationId: ConversationId;
  readonly expectedRevision: ConversationRevision | null;
  readonly actualRevision: ConversationRevision | null;
  readonly identifier: string | null;
}

/** A deterministic, non-retryable conflict with current durable state. */
export class ConversationEventStoreConflictError extends Error {
  readonly code: ConversationEventStoreConflictCode;
  readonly conversationId: ConversationId;
  readonly expectedRevision: ConversationRevision | null;
  readonly actualRevision: ConversationRevision | null;
  readonly identifier: string | null;

  constructor(message: string, details: ConversationEventStoreConflictDetails) {
    super(message);
    this.name = "ConversationEventStoreConflictError";
    this.code = details.code;
    this.conversationId = details.conversationId;
    this.expectedRevision = details.expectedRevision;
    this.actualRevision = details.actualRevision;
    this.identifier = details.identifier;
  }
}

export type ConversationEventStoreOperation =
  | "append"
  | "read"
  | "latest_revision"
  | "checkpoint_read"
  | "checkpoint_write";

/** A storage availability failure that may be safe for the caller to retry. */
export class ConversationEventStoreUnavailableError extends Error {
  readonly operation: ConversationEventStoreOperation;
  readonly retryable: boolean;

  constructor(
    operation: ConversationEventStoreOperation,
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = "ConversationEventStoreUnavailableError";
    this.operation = operation;
    this.retryable = retryable;
  }
}

interface InMemoryConversation {
  readonly entries: StoredConversationEvent[];
  checkpoint: ConversationEventCheckpoint | null;
}

interface IndexedEntry {
  readonly conversationId: ConversationId;
  readonly entry: StoredConversationEvent;
}

/**
 * Deterministic process-local reference adapter for tests and development.
 *
 * This adapter is not durable storage: all data disappears with the instance or
 * process. It clones inputs and outputs so callers cannot mutate stored state.
 */
export class InMemoryConversationEventStore implements ConversationEventStore {
  private readonly conversations = new Map<string, InMemoryConversation>();
  private readonly eventIds = new Map<string, IndexedEntry>();
  private readonly mutationIds = new Map<string, IndexedEntry>();

  readonly checkpoints: ConversationEventCheckpointStore = {
    read: async (conversationId) => this.readCheckpoint(conversationId),
    write: async (checkpoint) => this.writeCheckpoint(checkpoint),
  };

  async append(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult> {
    const current = this.conversations.get(input.conversationId);
    const currentRevision = latestRevision(current);

    this.validateAppend(input, currentRevision);

    const matches = input.events.map((event) => this.findIdempotentMatch(event));
    const matchedCount = matches.filter((match) => match !== null).length;

    if (matchedCount > 0) {
      if (matchedCount !== input.events.length) {
        throw conflict(
          "idempotency_conflict",
          input,
          currentRevision,
          "Only part of the atomic batch is already stored.",
        );
      }

      const matchedEntries = matches as IndexedEntry[];
      this.validateCompleteRetry(input, matchedEntries, currentRevision);
      return appendResult(
        "idempotent",
        matchedEntries.map(({ entry }) => entry),
        currentRevision!,
      );
    }

    if (input.expectedRevision !== currentRevision) {
      throw conflict(
        "revision_conflict",
        input,
        currentRevision,
        "The expected revision does not match the latest stored revision.",
      );
    }

    const storedEntries = input.events.map((event) => {
      const storedEvent = cloneJson(event);
      return {
        cursor: memoryCursor(input.conversationId, storedEvent.revision),
        event: storedEvent,
      } satisfies StoredConversationEvent;
    });

    const conversation = current ?? { entries: [], checkpoint: null };
    for (const entry of storedEntries) {
      conversation.entries.push(entry);
      const indexed = { conversationId: input.conversationId, entry };
      this.eventIds.set(entry.event.event_id, indexed);
      if (entry.event.mutation_id !== undefined) {
        this.mutationIds.set(entry.event.mutation_id, indexed);
      }
    }
    if (current === undefined) {
      this.conversations.set(input.conversationId, conversation);
    }

    return appendResult(
      "appended",
      storedEntries,
      storedEntries.at(-1)!.event.revision,
    );
  }

  async read(
    input: ReadConversationEventsInput,
  ): Promise<ReadConversationEventsResult> {
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit <= 0)
    ) {
      throw new RangeError("Conversation event read limit must be a positive safe integer.");
    }

    const conversation = this.conversations.get(input.conversationId);
    const allEntries = conversation?.entries ?? [];
    let startIndex = 0;

    if (input.after !== undefined && "cursor" in input.after) {
      const cursorIndex = allEntries.findIndex(
        (entry) => entry.cursor === input.after?.cursor,
      );
      if (cursorIndex < 0) {
        throw new ConversationEventStoreConflictError(
          "The cursor was not issued for this conversation or is no longer available.",
          {
            code: "cursor_not_found",
            conversationId: input.conversationId,
            expectedRevision: null,
            actualRevision: latestRevision(conversation),
            identifier: input.after.cursor,
          },
        );
      }
      startIndex = cursorIndex + 1;
    } else if (input.after !== undefined && "revision" in input.after) {
      const afterRevision = input.after.revision;
      startIndex = allEntries.findIndex(
        (entry) => entry.event.revision > afterRevision,
      );
      if (startIndex < 0) startIndex = allEntries.length;
    }

    const remaining = allEntries.slice(startIndex);
    const selected =
      input.limit === undefined ? remaining : remaining.slice(0, input.limit);
    const entries = cloneEntries(selected);

    return {
      entries,
      nextCursor: entries.at(-1)?.cursor ?? null,
      latestRevision: latestRevision(conversation),
      hasMore: selected.length < remaining.length,
    };
  }

  async getLatestRevision(
    conversationId: ConversationId,
  ): Promise<ConversationRevision | null> {
    return latestRevision(this.conversations.get(conversationId));
  }

  private validateAppend(
    input: AppendConversationEventsInput,
    currentRevision: ConversationRevision | null,
  ): void {
    if (input.events.length === 0) {
      throw conflict(
        "invalid_append",
        input,
        currentRevision,
        "An append batch must contain at least one event.",
      );
    }

    const expectedNumber = input.expectedRevision ?? 0;
    const batchEventIds = new Set<string>();
    const batchMutationIds = new Set<string>();

    input.events.forEach((event, index) => {
      parseConversationEvent(event);
      const requiredRevision = expectedNumber + index + 1;
      if (event.conversation_id !== input.conversationId) {
        throw conflict(
          "invalid_append",
          input,
          currentRevision,
          "Every event in a batch must belong to the requested conversation.",
          event.conversation_id,
        );
      }
      if (event.revision !== requiredRevision) {
        throw conflict(
          "invalid_append",
          input,
          currentRevision,
          `Expected contiguous event revision ${requiredRevision}.`,
          event.event_id,
        );
      }
      if (batchEventIds.has(event.event_id)) {
        throw conflict(
          "invalid_append",
          input,
          currentRevision,
          "An append batch cannot repeat an event ID.",
          event.event_id,
        );
      }
      batchEventIds.add(event.event_id);

      if (event.mutation_id !== undefined) {
        if (batchMutationIds.has(event.mutation_id)) {
          throw conflict(
            "invalid_append",
            input,
            currentRevision,
            "An append batch cannot repeat a client mutation ID.",
            event.mutation_id,
          );
        }
        batchMutationIds.add(event.mutation_id);
      }
    });
  }

  private findIdempotentMatch(event: ConversationEvent): IndexedEntry | null {
    const eventMatch = this.eventIds.get(event.event_id);
    const mutationMatch =
      event.mutation_id === undefined
        ? undefined
        : this.mutationIds.get(event.mutation_id);

    if (
      eventMatch !== undefined &&
      mutationMatch !== undefined &&
      eventMatch.entry !== mutationMatch.entry
    ) {
      throw idempotencyConflict(event, event.event_id);
    }
    if (eventMatch !== undefined && !jsonEqual(eventMatch.entry.event, event)) {
      throw idempotencyConflict(event, event.event_id);
    }
    if (
      mutationMatch !== undefined &&
      !sameClientMutation(mutationMatch.entry.event, event)
    ) {
      throw idempotencyConflict(event, event.mutation_id ?? null);
    }

    return eventMatch ?? mutationMatch ?? null;
  }

  private validateCompleteRetry(
    input: AppendConversationEventsInput,
    matches: readonly IndexedEntry[],
    currentRevision: ConversationRevision | null,
  ): void {
    const expectedFirstRevision = (input.expectedRevision ?? 0) + 1;
    for (const [index, match] of matches.entries()) {
      if (
        match.conversationId !== input.conversationId ||
        match.entry.event.revision !== expectedFirstRevision + index
      ) {
        throw conflict(
          "idempotency_conflict",
          input,
          currentRevision,
          "The identifiers do not describe one previously stored atomic batch.",
          input.events[index]?.event_id ?? null,
        );
      }
    }
  }

  private async readCheckpoint(
    conversationId: ConversationId,
  ): Promise<ConversationEventCheckpoint | null> {
    const checkpoint = this.conversations.get(conversationId)?.checkpoint;
    return checkpoint === null || checkpoint === undefined
      ? null
      : cloneJson(checkpoint);
  }

  private async writeCheckpoint(
    checkpoint: ConversationEventCheckpoint,
  ): Promise<WriteConversationEventCheckpointResult> {
    const conversation = this.conversations.get(checkpoint.conversationId);
    const actualRevision = latestRevision(conversation);
    if (
      conversation === undefined ||
      actualRevision === null ||
      checkpoint.revision > actualRevision ||
      checkpoint.revision < 1 ||
      !Number.isSafeInteger(checkpoint.revision)
    ) {
      throw checkpointConflict(
        checkpoint,
        actualRevision,
        "A checkpoint must reference an existing conversation revision.",
      );
    }

    const current = conversation.checkpoint;
    if (current !== null) {
      if (checkpoint.revision < current.revision) {
        throw checkpointConflict(
          checkpoint,
          current.revision,
          "A checkpoint cannot replace a newer checkpoint.",
        );
      }
      if (checkpoint.revision === current.revision) {
        if (!jsonEqual(checkpoint.state, current.state)) {
          throw checkpointConflict(
            checkpoint,
            current.revision,
            "A checkpoint revision cannot be reused with different state.",
          );
        }
        if (checkpoint.schemaVersion === current.schemaVersion) {
          return {
            status: "idempotent",
            checkpoint: cloneJson(current),
          };
        }
      }
    }

    const stored = cloneJson(checkpoint);
    conversation.checkpoint = stored;
    return { status: "written", checkpoint: cloneJson(stored) };
  }
}

function latestRevision(
  conversation: InMemoryConversation | undefined,
): ConversationRevision | null {
  return conversation?.entries.at(-1)?.event.revision ?? null;
}

function memoryCursor(
  conversationId: ConversationId,
  revision: ConversationRevision,
): ConversationEventCursor {
  return `memory:${encodeURIComponent(conversationId)}:${revision}` as ConversationEventCursor;
}

function appendResult(
  status: AppendConversationEventsResult["status"],
  entries: readonly StoredConversationEvent[],
  latestRevisionValue: ConversationRevision,
): AppendConversationEventsResult {
  const cloned = cloneEntries(entries);
  return {
    status,
    entries: cloned,
    latestRevision: latestRevisionValue,
  };
}

function cloneEntries(
  entries: readonly StoredConversationEvent[],
): readonly StoredConversationEvent[] {
  return Object.freeze(entries.map((entry) => cloneJson(entry)));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameClientMutation(
  stored: ConversationEvent,
  requested: ConversationEvent,
): boolean {
  return (
    stored.mutation_id !== undefined &&
    requested.mutation_id !== undefined &&
    stored.mutation_id === requested.mutation_id &&
    stored.version === requested.version &&
    stored.conversation_id === requested.conversation_id &&
    jsonEqual(stored.actor, requested.actor) &&
    jsonEqual(stored.source, requested.source) &&
    jsonEqual(stored.metadata, requested.metadata) &&
    jsonEqual(stored.payload, requested.payload)
  );
}

function conflict(
  code: ConversationEventStoreConflictCode,
  input: AppendConversationEventsInput,
  actualRevision: ConversationRevision | null,
  message: string,
  identifier: string | null = null,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(message, {
    code,
    conversationId: input.conversationId,
    expectedRevision: input.expectedRevision,
    actualRevision,
    identifier,
  });
}

function idempotencyConflict(
  event: ConversationEvent,
  identifier: ConversationEventId | ConversationClientMutationId | null,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(
    "An idempotency identifier is already stored for a different fact or mutation.",
    {
      code: "idempotency_conflict",
      conversationId: event.conversation_id,
      expectedRevision: null,
      actualRevision: null,
      identifier,
    },
  );
}

function checkpointConflict(
  checkpoint: ConversationEventCheckpoint,
  actualRevision: ConversationRevision | null,
  message: string,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(message, {
    code: "checkpoint_conflict",
    conversationId: checkpoint.conversationId,
    expectedRevision: checkpoint.revision,
    actualRevision,
    identifier: null,
  });
}
