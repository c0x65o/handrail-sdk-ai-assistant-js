import {
  parseConversationEvent,
  type ConversationEvent,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationRevision,
} from "./events.js";
import type {
  ConversationEventCheckpoint,
  ConversationEventCursor,
  ConversationEventStore,
  WriteConversationEventCheckpointResult,
} from "./event-store.js";
import { isConversationState } from "./state-validation.js";
import {
  createInitialConversationState,
  type ConversationState,
} from "./state.js";
import {
  createConversationStore,
  type ConversationStore,
} from "./store.js";

// Version 3 adds normalized citation source/link projections. Older
// checkpoints intentionally fall back to full durable-log replay.
export const CONVERSATION_CHECKPOINT_SCHEMA_VERSION = 3 as const;

export interface ConversationCheckpointPolicy {
  /** Write after at least this many events have been folded since the checkpoint. */
  readonly eventCount?: number;
  /** Write when the current serialized projection is at least this many UTF-8 bytes. */
  readonly serializedBytes?: number;
}

export const DEFAULT_CONVERSATION_CHECKPOINT_POLICY: Readonly<ConversationCheckpointPolicy> =
  Object.freeze({ eventCount: 100, serializedBytes: 256 * 1024 });

export interface ConversationCheckpointPolicyInput {
  readonly eventsSinceCheckpoint: number;
  readonly serializedBytes: number;
}

/** Decide checkpoint eligibility without depending on a clock or host runtime. */
export function shouldWriteConversationCheckpoint(
  input: ConversationCheckpointPolicyInput,
  policy: ConversationCheckpointPolicy = DEFAULT_CONVERSATION_CHECKPOINT_POLICY,
): boolean {
  validateThreshold(policy.eventCount, "eventCount");
  validateThreshold(policy.serializedBytes, "serializedBytes");
  return (
    (policy.eventCount !== undefined &&
      input.eventsSinceCheckpoint >= policy.eventCount) ||
    (policy.serializedBytes !== undefined &&
      input.serializedBytes >= policy.serializedBytes)
  );
}

export type ConversationReplayFailureCode =
  | "corrupt_event"
  | "revision_gap";

export interface ConversationReplayFailureDetails {
  readonly code: ConversationReplayFailureCode;
  readonly conversationId: ConversationId;
  readonly lastSafeCursor: ConversationEventCursor | null;
  readonly lastSafeRevision: ConversationRevision | null;
  readonly eventCursor: ConversationEventCursor | null;
  readonly expectedRevision?: number;
  readonly receivedRevision?: number;
  readonly cause?: unknown;
}

/** A durable-log failure. The safe position may be retained for diagnosis/resume. */
export class ConversationReplayFailure extends Error {
  readonly code: ConversationReplayFailureCode;
  readonly conversationId: ConversationId;
  readonly lastSafeCursor: ConversationEventCursor | null;
  readonly lastSafeRevision: ConversationRevision | null;
  readonly eventCursor: ConversationEventCursor | null;
  readonly expectedRevision: number | undefined;
  readonly receivedRevision: number | undefined;
  override readonly cause: unknown;

  constructor(message: string, details: ConversationReplayFailureDetails) {
    super(message, { cause: details.cause });
    this.name = "ConversationReplayFailure";
    this.code = details.code;
    this.conversationId = details.conversationId;
    this.lastSafeCursor = details.lastSafeCursor;
    this.lastSafeRevision = details.lastSafeRevision;
    this.eventCursor = details.eventCursor;
    this.expectedRevision = details.expectedRevision;
    this.receivedRevision = details.receivedRevision;
    this.cause = details.cause;
  }
}

export type ConversationCheckpointStatus = "absent" | "invalid" | "used";

export interface ReplayConversationOptions {
  readonly conversationId: ConversationId;
  readonly eventStore: ConversationEventStore;
  /** Positive page size. Omit to let the adapter return its complete remainder. */
  readonly readBatchSize?: number;
  /** Set false to disable writes after replay. */
  readonly checkpointPolicy?: ConversationCheckpointPolicy | false;
  /** Observe each validated, newly applied tail event without reading history again. */
  readonly onEvent?: (event: ConversationEvent) => void;
}

export interface ReplayConversationResult {
  readonly store: ConversationStore;
  readonly state: ConversationState;
  readonly checkpointStatus: ConversationCheckpointStatus;
  readonly replayedEventCount: number;
  readonly duplicateEventCount: number;
  readonly lastCursor: ConversationEventCursor | null;
  readonly lastRevision: ConversationRevision | null;
  readonly checkpointWrite: WriteConversationEventCheckpointResult | null;
}

/**
 * Hydrate a headless store from the newest compatible checkpoint and its tail.
 * Invalid checkpoints are ignored; invalid durable events are never ignored.
 */
export async function replayConversation(
  options: ReplayConversationOptions,
): Promise<ReplayConversationResult> {
  const { conversationId, eventStore } = options;
  if (
    options.readBatchSize !== undefined &&
    (!Number.isSafeInteger(options.readBatchSize) || options.readBatchSize <= 0)
  ) {
    throw new RangeError("Conversation replay batch size must be a positive safe integer");
  }

  const rawCheckpoint =
    eventStore.checkpoints === undefined
      ? null
      : await eventStore.checkpoints.read(conversationId);
  // The final event page carries an atomic head revision. A separate head read
  // is only needed to validate a checkpoint before trusting its projection.
  const durableLatestRevision = rawCheckpoint === null
    ? null : await eventStore.getLatestRevision(conversationId);
  const checkpoint = parseCheckpoint(
    rawCheckpoint,
    conversationId,
    durableLatestRevision,
  );
  const checkpointStatus: ConversationCheckpointStatus =
    rawCheckpoint === null ? "absent" : checkpoint === null ? "invalid" : "used";
  const initialState =
    checkpoint?.state ?? createInitialConversationState(conversationId);
  const store = createConversationStore(conversationId, initialState);
  let lastSafeRevision = initialState.revision;
  let lastSafeCursor: ConversationEventCursor | null = null;
  let readCursor: ConversationEventCursor | null = null;
  let replayedEventCount = 0;
  let duplicateEventCount = 0;
  const seenEventIds = new Set<string>(initialState.processed_event_ids);
  const seenMutationIds = new Set<string>(initialState.processed_mutation_ids);

  try {
    for (;;) {
      const page = await eventStore.read({
        conversationId,
        ...(readCursor !== null
          ? { after: { cursor: readCursor } }
          : checkpoint !== null
            ? { after: { revision: checkpoint.revision } }
            : {}),
        ...(options.readBatchSize === undefined
          ? {}
          : { limit: options.readBatchSize }),
      });

      for (const entry of page.entries) {
        let event: ConversationEvent;
        try {
          event = parseConversationEvent(entry.event);
        } catch (cause) {
          throw replayFailure("corrupt_event", conversationId, {
            lastSafeCursor,
            lastSafeRevision,
            eventCursor: entry.cursor,
            cause,
          });
        }

        if (event.conversation_id !== conversationId) {
          throw replayFailure("corrupt_event", conversationId, {
            lastSafeCursor,
            lastSafeRevision,
            eventCursor: entry.cursor,
            cause: new TypeError("Stored event belongs to another conversation"),
          });
        }

        if (
          seenEventIds.has(event.event_id) ||
          (event.mutation_id !== undefined && seenMutationIds.has(event.mutation_id))
        ) {
          duplicateEventCount += 1;
          readCursor = entry.cursor;
          continue;
        }

        const expectedRevision = (lastSafeRevision ?? 0) + 1;
        if (event.revision !== expectedRevision) {
          throw replayFailure("revision_gap", conversationId, {
            lastSafeCursor,
            lastSafeRevision,
            eventCursor: entry.cursor,
            expectedRevision,
            receivedRevision: event.revision,
          });
        }

        const state = await store.applyEvent(event);
        if (state.replay_error !== null) {
          throw replayFailure("corrupt_event", conversationId, {
            lastSafeCursor,
            lastSafeRevision,
            eventCursor: entry.cursor,
            cause: state.replay_error,
          });
        }
        options.onEvent?.(event);
        seenEventIds.add(event.event_id);
        if (event.mutation_id !== undefined) seenMutationIds.add(event.mutation_id);
        lastSafeRevision = event.revision;
        lastSafeCursor = entry.cursor;
        readCursor = entry.cursor;
        replayedEventCount += 1;
      }

      if (!page.hasMore) {
        if (page.latestRevision !== lastSafeRevision) {
          throw replayFailure("revision_gap", conversationId, {
            lastSafeCursor,
            lastSafeRevision,
            eventCursor: null,
            expectedRevision: (lastSafeRevision ?? 0) + 1,
            ...(page.latestRevision === null
              ? {}
              : { receivedRevision: page.latestRevision }),
          });
        }
        break;
      }
      if (page.nextCursor === null || page.nextCursor === readCursor && page.entries.length === 0) {
        throw replayFailure("corrupt_event", conversationId, {
          lastSafeCursor,
          lastSafeRevision,
          eventCursor: null,
          cause: new TypeError("Event store returned a non-advancing replay page"),
        });
      }
      readCursor = page.nextCursor;
    }
  } catch (error) {
    store.destroy();
    throw error;
  }

  const state = store.getSnapshot();
  let checkpointWrite: WriteConversationEventCheckpointResult | null = null;
  const policy = options.checkpointPolicy ?? DEFAULT_CONVERSATION_CHECKPOINT_POLICY;
  if (
    policy !== false &&
    eventStore.checkpoints !== undefined &&
    state.revision !== null &&
    (checkpoint === null || state.revision > checkpoint.revision)
  ) {
    const serializedState = JSON.stringify(state);
    if (
      shouldWriteConversationCheckpoint(
        {
          eventsSinceCheckpoint: replayedEventCount,
          serializedBytes: utf8ByteLength(serializedState),
        },
        policy,
      )
    ) {
      checkpointWrite = await eventStore.checkpoints.write({
        conversationId,
        schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
        revision: state.revision,
        state: JSON.parse(serializedState) as ConversationJsonValue,
      });
    }
  }

  return Object.freeze({
    store,
    state,
    checkpointStatus,
    replayedEventCount,
    duplicateEventCount,
    lastCursor: lastSafeCursor,
    lastRevision: lastSafeRevision,
    checkpointWrite,
  });
}

interface ValidCheckpoint {
  readonly revision: ConversationRevision;
  readonly state: ConversationState;
}

function parseCheckpoint(
  checkpoint: ConversationEventCheckpoint | null,
  conversationId: ConversationId,
  durableLatestRevision: ConversationRevision | null,
): ValidCheckpoint | null {
  if (checkpoint === null || !isRecord(checkpoint)) return null;
  if (
    checkpoint.schemaVersion !== CONVERSATION_CHECKPOINT_SCHEMA_VERSION ||
    checkpoint.conversationId !== conversationId ||
    !isRevision(checkpoint.revision) ||
    durableLatestRevision === null ||
    checkpoint.revision > durableLatestRevision ||
    !isConversationState(checkpoint.state, conversationId, checkpoint.revision)
  ) {
    return null;
  }
  return {
    revision: checkpoint.revision,
    state: deepFreeze(cloneJson(checkpoint.state)) as unknown as ConversationState,
  };
}

function isRevision(value: unknown): value is ConversationRevision {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateThreshold(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`Conversation checkpoint ${name} must be a positive safe integer`);
  }
}

function replayFailure(
  code: ConversationReplayFailureCode,
  conversationId: ConversationId,
  details: Omit<ConversationReplayFailureDetails, "code" | "conversationId">,
): ConversationReplayFailure {
  const message = code === "corrupt_event"
    ? "Conversation replay encountered a corrupt stored event"
    : `Conversation replay expected revision ${details.expectedRevision} but received ${details.receivedRevision ?? "no event"}`;
  return new ConversationReplayFailure(message, { code, conversationId, ...details });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
