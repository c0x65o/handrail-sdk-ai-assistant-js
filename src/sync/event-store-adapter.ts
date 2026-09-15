import type { AiDiagnosticSink } from "../diagnostics.js";
import { diagnoseAiOperation } from "../diagnostics.js";
import {
  ConversationEventStoreConflictError,
  type ConversationEventStore,
} from "../conversation/event-store.js";
import {
  CONVERSATION_EVENT_VERSION,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationEventActor,
  type ConversationEventId,
  type ConversationEventMetadata,
  type ConversationEventPayload,
  type ConversationEventSource,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationRevision,
  type ConversationTimestamp,
} from "../conversation/events.js";
import { replayConversation } from "../conversation/replay.js";
import type { ConversationState } from "../conversation/state.js";
import { jsonValuesEqual } from "../json-equality.js";
import { ConversationSyncMutationRejectedError } from "./rejection.js";
import type {
  AppendMutationsInput,
  AppendMutationsResult,
  ConversationSyncAdapter,
  ConversationSyncMutation,
  ConversationSyncMutationEvent,
  ConversationSyncOperationFailure,
  ConversationSyncSubscription,
  ConversationSyncUpdate,
  PublishPresenceInput,
  PublishPresenceResult,
  PullSnapshotInput,
  PullSnapshotResult,
  ReadSinceInput,
  ReadSinceResult,
  SubscribePresenceInput,
  SubscribePresenceResult,
  SubscribeSinceInput,
  SubscribeSinceResult,
} from "./types.js";

export type EventStoreSyncOperation = "pull_snapshot" | "read_since" | "append_mutations" | "subscribe_since";

export interface CanonicalConversationSyncMutation {
  readonly actor: ConversationEventActor;
  readonly source: ConversationEventSource;
  readonly payload: ConversationEventPayload;
  readonly metadata?: ConversationEventMetadata;
}

export interface CanonicalizeConversationSyncMutationInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId: ConversationId;
  readonly mutationId: ConversationSyncMutation["mutationId"];
  /** Untrusted proposal. The callback must revalidate domain and attachment authority. */
  readonly proposedEvent: ConversationSyncMutationEvent;
}

export interface ValidateCanonicalConversationSyncBatchInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId: ConversationId;
  readonly expectedRevision: ConversationRevision | null;
  /** Fully server-authored envelopes in proposed append order. */
  readonly events: readonly ConversationEvent[];
  /** Original untrusted proposals in the same order. */
  readonly proposedEvents: readonly ConversationSyncMutationEvent[];
}

export interface EventStoreConversationSyncAdapterOptions<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly eventStore: ConversationEventStore;
  readonly authorize: (input: {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
    readonly operation: EventStoreSyncOperation;
  }) => boolean | Promise<boolean>;
  /** Must be deterministic for the same mutation proposal and authenticated context. */
  readonly canonicalizeMutation: (
    input: CanonicalizeConversationSyncMutationInput<TAuthorizationContext>,
  ) => CanonicalConversationSyncMutation | Promise<CanonicalConversationSyncMutation>;
  readonly createEventId: (input: {
    readonly conversationId: ConversationId;
    readonly mutationId: ConversationSyncMutation["mutationId"];
  }) => ConversationEventId;
  readonly now?: () => ConversationTimestamp;
  readonly readPageSize?: number;
  readonly subscriptionPollingMilliseconds?: number;
  readonly maximumMutationBatchSize?: number;
  readonly maximumIdempotencyScanEvents?: number;
  /**
   * Runtime-source proposals are rejected by default. Enable this only when
   * `canonicalizeMutation` proves every proposed assistant/runtime fact against
   * a server-owned durable turn or provider record.
   */
  readonly allowRuntimeMutationProposals?: boolean;
  /**
   * Usage receipt linkage proposals are rejected by default. Enable this only
   * when `canonicalizeMutation` verifies the receipt against server metering.
   */
  readonly allowUsageReceiptMutationProposals?: boolean;
  /**
   * Optional cross-event/domain invariant check, run after authoritative
   * envelopes are built and before the atomic append. Throw to deny the whole
   * batch. This is the place to replay a proposed turn admission as one unit.
   */
  readonly validateCanonicalBatch?: (
    input: ValidateCanonicalConversationSyncBatchInput<TAuthorizationContext>,
  ) => void | Promise<void>;
  readonly presence?: Pick<ConversationSyncAdapter, "publishPresence" | "subscribePresence">;
  readonly diagnostics?: AiDiagnosticSink;
}

interface CanonicalMutationProposal {
  readonly mutation: ConversationSyncMutation;
  readonly proposedEvent: ConversationSyncMutationEvent;
  readonly canonical: CanonicalConversationSyncMutation;
}

const unavailable = (): ConversationSyncOperationFailure => Object.freeze({
  status: "temporarily_unavailable" as const,
  message: "Conversation synchronization is temporarily unavailable.",
});

const denied = (): ConversationSyncOperationFailure => Object.freeze({
  status: "unauthorized" as const,
  message: "Conversation synchronization was denied.",
});

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return resolved;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function proposalEvent(
  mutation: ConversationSyncMutation,
  conversationId: ConversationId,
  allowRuntime: boolean,
  allowUsageReceipt: boolean,
): ConversationSyncMutationEvent {
  if (!mutation || typeof mutation !== "object" || !Array.isArray(mutation.events) || mutation.events.length !== 1) {
    throw new TypeError("Each synchronization mutation must contain exactly one event");
  }
  const event = parseConversationEvent(mutation.events[0]);
  const allowedSource = event.source.type === "client" ||
    (allowRuntime && event.source.type === "runtime");
  if (event.conversation_id !== conversationId || event.mutation_id !== mutation.mutationId || !allowedSource ||
    (!allowUsageReceipt && event.payload.type === "usage.receipt_linked")) {
    throw new TypeError("Synchronization mutation identity is invalid");
  }
  return event as ConversationSyncMutationEvent;
}

function canonicalComparable(value: CanonicalConversationSyncMutation): ConversationJsonValue {
  return JSON.parse(JSON.stringify({ actor: value.actor, source: value.source, payload: value.payload,
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }) })) as ConversationJsonValue;
}

function storedComparable(event: ConversationEvent): ConversationJsonValue {
  return canonicalComparable({ actor: event.actor, source: event.source,
    payload: event.payload,
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }) });
}

/**
 * Server-authoritative synchronization over any conforming event store.
 * Client envelope identity, actor, time, revision, and metadata are never trusted.
 */
export function createEventStoreConversationSyncAdapter<TAuthorizationContext>(
  options: EventStoreConversationSyncAdapterOptions<TAuthorizationContext>,
): ConversationSyncAdapter<ConversationState & ConversationJsonValue> {
  const readPageSize = boundedInteger(options.readPageSize, 500, 1, 10_000, "readPageSize");
  const pollingMilliseconds = boundedInteger(options.subscriptionPollingMilliseconds, 1_000, 100, 300_000,
    "subscriptionPollingMilliseconds");
  const maximumBatch = boundedInteger(options.maximumMutationBatchSize, 50, 1, 500, "maximumMutationBatchSize");
  const maximumScan = boundedInteger(options.maximumIdempotencyScanEvents, 50_000, 1, 1_000_000,
    "maximumIdempotencyScanEvents");

  const authorize = (operation: EventStoreSyncOperation, conversationId: ConversationId) =>
    options.authorize({ authorizationContext: options.authorizationContext, conversationId, operation });

  const canonicalize = async (input: AppendMutationsInput): Promise<readonly CanonicalMutationProposal[]> => {
    if (!Array.isArray(input.mutations) || input.mutations.length < 1 || input.mutations.length > maximumBatch) {
      throw new TypeError("Synchronization mutation batch is invalid");
    }
    const seen = new Set<string>();
    const values: CanonicalMutationProposal[] = [];
    for (const mutation of input.mutations) {
      if (seen.has(mutation.mutationId)) throw new TypeError("Synchronization mutation is duplicated in the batch");
      seen.add(mutation.mutationId);
      const proposedEvent = proposalEvent(
        mutation,
        input.conversationId,
        options.allowRuntimeMutationProposals === true,
        options.allowUsageReceiptMutationProposals === true,
      );
      const canonical = await options.canonicalizeMutation({ authorizationContext: options.authorizationContext,
        conversationId: input.conversationId, mutationId: mutation.mutationId, proposedEvent });
      // Round-trip through the event parser below; this clone also rejects non-JSON callback output.
      JSON.stringify(canonicalComparable(canonical));
      values.push(Object.freeze({ mutation, proposedEvent, canonical }));
    }
    return Object.freeze(values);
  };

  const findMutations = async (conversationId: ConversationId, ids: ReadonlySet<string>) => {
    const found = new Map<string, ConversationEvent>();
    let after: ConversationRevision | null = null;
    let scanned = 0;
    for (;;) {
      const page = await options.eventStore.read({ conversationId,
        ...(after === null ? {} : { after: { revision: after } }), limit: Math.min(readPageSize, maximumScan - scanned) });
      for (const { event } of page.entries) {
        scanned += 1;
        if (event.mutation_id && ids.has(event.mutation_id)) found.set(event.mutation_id, event);
      }
      if (found.size === ids.size || !page.hasMore) return found;
      if (scanned >= maximumScan || page.entries.length === 0) throw new Error("Synchronization idempotency scan limit exceeded");
      after = page.entries.at(-1)!.event.revision;
    }
  };

  const duplicateResult = async (input: AppendMutationsInput, proposals: readonly CanonicalMutationProposal[],
    latestRevision: ConversationRevision | null): Promise<AppendMutationsResult | null> => {
    const found = await findMutations(input.conversationId, new Set(proposals.map(({ mutation }) => mutation.mutationId)));
    if (found.size !== proposals.length || latestRevision === null) return null;
    const acknowledgements = proposals.map(({ mutation, canonical }) => {
      const event = found.get(mutation.mutationId)!;
      if (!jsonValuesEqual(storedComparable(event), canonicalComparable(canonical))) {
        throw new TypeError("Synchronization mutation identity was reused with different content");
      }
      return Object.freeze({ status: "duplicate" as const, mutationId: mutation.mutationId,
        events: Object.freeze([event]) });
    });
    return Object.freeze({ status: "mutations" as const,
      acknowledgements: Object.freeze(acknowledgements), latestRevision });
  };

  const pullSnapshot = async (input: PullSnapshotInput): Promise<PullSnapshotResult<ConversationState & ConversationJsonValue>> => {
    if (!await authorize("pull_snapshot", input.conversationId)) return denied();
    try {
      return await diagnoseAiOperation(options.diagnostics, { domain: "persistence", operation: "sync_pull_snapshot",
        conversationId: input.conversationId }, async () => {
        const replay = await replayConversation({ conversationId: input.conversationId,
          eventStore: options.eventStore, readBatchSize: readPageSize, checkpointPolicy: false });
        return Object.freeze({ status: "snapshot" as const, snapshot: Object.freeze({
          conversationId: input.conversationId, revision: replay.state.revision,
          state: replay.state as ConversationState & ConversationJsonValue,
        }) });
      });
    } catch { return unavailable(); }
  };

  const readSince = async (input: ReadSinceInput): Promise<ReadSinceResult> => {
    if (!await authorize("read_since", input.conversationId)) return denied();
    try {
      return await diagnoseAiOperation(options.diagnostics, { domain: "persistence", operation: "sync_read_since",
        conversationId: input.conversationId }, async () => {
        const limit = boundedInteger(input.limit, readPageSize, 1, readPageSize, "limit");
        const page = await options.eventStore.read({ conversationId: input.conversationId,
          ...(input.afterRevision === null ? {} : { after: { revision: input.afterRevision } }), limit });
        const latestRevision = page.latestRevision;
        if (input.afterRevision !== null && (latestRevision === null || input.afterRevision > latestRevision)) {
          return Object.freeze({ status: "snapshot_required" as const, reason: "revision_gap" as const, latestRevision });
        }
        const events = Object.freeze(page.entries.map(({ event }) => event));
        const expectedFirst = (input.afterRevision ?? 0) + 1;
        if (events[0] && events[0].revision !== expectedFirst) {
          return Object.freeze({ status: "snapshot_required" as const, reason: "compacted" as const, latestRevision });
        }
        return Object.freeze({ status: "events" as const, events,
          revision: events.at(-1)?.revision ?? input.afterRevision,
          latestRevision, hasMore: page.hasMore });
      });
    } catch { return unavailable(); }
  };

  const appendMutations = async (input: AppendMutationsInput): Promise<AppendMutationsResult> => {
    if (!await authorize("append_mutations", input.conversationId)) return denied();
    try {
      return await diagnoseAiOperation(options.diagnostics, { domain: "persistence", operation: "sync_append_mutations",
        conversationId: input.conversationId }, async () => {
        const proposals = await canonicalize(input);
        const observedRevision = await options.eventStore.getLatestRevision(input.conversationId);
        if (observedRevision !== input.expectedRevision) {
          const duplicate = await duplicateResult(input, proposals, observedRevision);
          if (duplicate !== null) return duplicate;
          if ((observedRevision ?? 0) > (input.expectedRevision ?? 0)) return Object.freeze({ status: "conflict" as const,
            expectedRevision: input.expectedRevision, actualRevision: observedRevision });
        }
        const occurredAt = (options.now ?? (() => new Date().toISOString() as ConversationTimestamp))();
        const events = proposals.map(({ mutation, canonical }, index) => parseConversationEvent({
          version: CONVERSATION_EVENT_VERSION,
          event_id: options.createEventId({ conversationId: input.conversationId, mutationId: mutation.mutationId }),
          conversation_id: input.conversationId,
          revision: ((input.expectedRevision ?? 0) + index + 1) as ConversationRevision,
          occurred_at: occurredAt,
          actor: canonical.actor,
          source: canonical.source,
          mutation_id: mutation.mutationId,
          ...(canonical.metadata === undefined ? {} : { metadata: canonical.metadata }),
          payload: canonical.payload,
        }));
        try {
          await options.validateCanonicalBatch?.({
            authorizationContext: options.authorizationContext,
            conversationId: input.conversationId,
            expectedRevision: input.expectedRevision,
            events: Object.freeze(events),
            proposedEvents: Object.freeze(proposals.map(({ proposedEvent }) => proposedEvent)),
          });
        } catch (error) {
          // Validation replays history, which may advance after the revision read
          // above. Let the client catch up instead of classifying that race as denial.
          const latest = await options.eventStore.getLatestRevision(input.conversationId);
          if ((latest ?? 0) > (observedRevision ?? 0)) return Object.freeze({ status: "conflict" as const,
            expectedRevision: input.expectedRevision, actualRevision: latest });
          throw error;
        }
        try {
          const appended = await options.eventStore.append({ conversationId: input.conversationId,
            expectedRevision: input.expectedRevision, events });
          const status = appended.status === "appended" ? "accepted" as const : "duplicate" as const;
          return Object.freeze({ status: "mutations" as const,
            acknowledgements: Object.freeze(appended.entries.map((entry, index) => Object.freeze({ status,
              mutationId: proposals[index]!.mutation.mutationId, events: Object.freeze([entry.event]) }))),
            latestRevision: appended.latestRevision });
        } catch (error) {
          if (!(error instanceof ConversationEventStoreConflictError)) throw error;
          const latest = await options.eventStore.getLatestRevision(input.conversationId);
          const duplicate = await duplicateResult(input, proposals, latest);
          return duplicate ?? Object.freeze({ status: "conflict" as const,
            expectedRevision: input.expectedRevision, actualRevision: latest });
        }
      });
    } catch (error) {
      if (error instanceof ConversationSyncMutationRejectedError) return error.toResult();
      return error instanceof TypeError ? denied() : unavailable();
    }
  };

  const subscribeSince = async (input: SubscribeSinceInput): Promise<SubscribeSinceResult> => {
    if (!await authorize("subscribe_since", input.conversationId)) return denied();
    const controller = new AbortController();
    const updates = (async function* (): AsyncIterable<ConversationSyncUpdate> {
      let afterRevision = input.afterRevision;
      while (!controller.signal.aborted) {
        const result = await readSince({ conversationId: input.conversationId, afterRevision, limit: readPageSize });
        if (result.status !== "events") { yield result; return; }
        if (result.events.length > 0) {
          yield result;
          afterRevision = result.revision;
          if (result.hasMore) continue;
        }
        await delay(pollingMilliseconds, controller.signal);
      }
    })();
    const subscription: ConversationSyncSubscription = Object.freeze({ updates, close: () => controller.abort() });
    return Object.freeze({ status: "subscribed" as const, subscription });
  };

  return Object.freeze({
    pullSnapshot,
    readSince,
    appendMutations,
    subscribeSince,
    publishPresence: (input: PublishPresenceInput): Promise<PublishPresenceResult> => options.presence
      ? options.presence.publishPresence(input) : Promise.resolve(denied()),
    subscribePresence: (input: SubscribePresenceInput): Promise<SubscribePresenceResult> => options.presence
      ? options.presence.subscribePresence(input) : Promise.resolve(denied()),
  });
}
