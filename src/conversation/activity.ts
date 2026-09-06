import type { ConversationId } from "./events.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";

export type ConversationActivityTurnStatus = "idle" | "running" | "completed" | "error";

export const CONVERSATION_ACTIVITY_LIMITS = Object.freeze({
  summaryLength: 240,
  progressUnitLength: 64,
} as const);

export interface ConversationActivityProgress {
  readonly completed: number;
  readonly total: number;
  readonly unit?: string;
}

export interface ConversationActivityRecord {
  readonly conversationId: ConversationId | string;
  /** Canonical conversation turn represented by this activity record. */
  readonly turnId?: string;
  /** Canonical revision of this turn's admission, for ordering different turns. */
  readonly turnRevision?: number;
  readonly turnStatus: ConversationActivityTurnStatus;
  readonly unread: boolean;
  readonly updatedAt?: string;
  /** Short, safe status text suitable for a launcher or conversation list. */
  readonly summary?: string;
  readonly progress?: ConversationActivityProgress;
}

export interface ConversationActivityReadable {
  getSnapshot(): readonly ConversationActivityRecord[];
  subscribe(listener: () => void): () => void;
}

export interface ConversationActivityStore extends ConversationActivityReadable {
  replace(records: readonly ConversationActivityRecord[]): void;
  upsert(record: ConversationActivityRecord): void;
  remove(conversationId: ConversationId | string): void;
  markRead(conversationId: ConversationId | string): void;
}

/** Server persistence contract for a principal/workspace-scoped activity index. */
export interface DurableConversationActivityStore {
  list(): Promise<readonly ConversationActivityRecord[]>;
  upsert(record: ConversationActivityRecord): Promise<ConversationActivityRecord>;
  markRead(conversationId: ConversationId | string, observed?: ConversationActivityRecord): Promise<ConversationActivityRecord | null>;
}

export const LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION =
  "handrail.live-conversation-activity.v1" as const;

export interface LiveConversationActivityEnvelope {
  readonly version: typeof LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly deliveryId: string;
  readonly record: ConversationActivityRecord;
}

export interface LiveConversationActivitySubscription
  extends AsyncIterable<LiveConversationActivityEnvelope> {
  close(): void;
}

export interface LiveConversationActivityDelivery {
  publish(record: ConversationActivityRecord): Promise<void>;
  subscribe(signal?: AbortSignal): LiveConversationActivitySubscription;
}

/** Multi-instance fan-out seam for a principal/workspace-scoped activity channel. */
export interface LiveConversationActivityPubSub {
  publish(channel: string, envelope: LiveConversationActivityEnvelope): Promise<void>;
  subscribe(
    channel: string,
    receive: (envelope: LiveConversationActivityEnvelope) => void,
  ): Promise<() => void>;
}

export interface ConversationActivityReportInput {
  readonly conversationId: ConversationId | string;
  readonly turnId?: string;
  readonly turnRevision?: number;
  readonly summary: string;
  readonly progress?: ConversationActivityProgress;
}

export interface ConversationActivityReporter {
  report(input: ConversationActivityReportInput): Promise<ConversationActivityRecord>;
}

export interface CreateConversationActivityReporterOptions {
  readonly store: DurableConversationActivityStore;
  readonly delivery: LiveConversationActivityDelivery;
  readonly now?: () => Date;
}

/** Writes one shared running summary and immediately fans it out to connected clients. */
export function createConversationActivityReporter(
  options: CreateConversationActivityReporterOptions,
): ConversationActivityReporter {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async report(input: ConversationActivityReportInput) {
      const record = parseConversationActivityRecord({
        conversationId: input.conversationId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        ...(input.turnRevision === undefined ? {} : { turnRevision: input.turnRevision }),
        turnStatus: "running",
        unread: false,
        updatedAt: now().toISOString(),
        summary: input.summary,
        ...(input.progress === undefined ? {} : { progress: input.progress }),
      });
      const saved = await options.store.upsert(record);
      await options.delivery.publish(saved);
      return saved;
    },
  });
}

export interface InMemoryLiveConversationActivityOptions {
  readonly pubSub?: LiveConversationActivityPubSub;
  readonly channel?: string;
  readonly now?: () => number;
}

interface ActivitySubscriber {
  push(value: LiveConversationActivityEnvelope): void;
  close(): void;
}

function activityQueue(onClose: () => void): LiveConversationActivitySubscription & ActivitySubscriber {
  const values: LiveConversationActivityEnvelope[] = [];
  const waiters: Array<(result: IteratorResult<LiveConversationActivityEnvelope>) => void> = [];
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      onClose();
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const value = values.shift();
          if (value) return Promise.resolve({ done: false as const, value });
          if (closed) return Promise.resolve({ done: true as const, value: undefined });
          return new Promise<IteratorResult<LiveConversationActivityEnvelope>>((resolve) => waiters.push(resolve));
        },
        return: async () => {
          this.close();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

/** Process-local delivery with an injectable Redis/NATS/Postgres pub-sub bridge. */
export function createInMemoryLiveConversationActivityDelivery(
  options: InMemoryLiveConversationActivityOptions = {},
): LiveConversationActivityDelivery {
  const subscribers = new Set<ActivitySubscriber>();
  const seen = new Set<string>();
  const channel = options.channel ?? "handrail:conversation-activity";
  const now = options.now ?? Date.now;
  let sequence = 0;
  let counter = 0;
  let subscribed: Promise<() => void> | null = null;
  const emit = (envelope: LiveConversationActivityEnvelope) => {
    if (seen.has(envelope.deliveryId)) return;
    seen.add(envelope.deliveryId);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    for (const subscriber of subscribers) subscriber.push(envelope);
  };
  return Object.freeze({
    async publish(input: ConversationActivityRecord) {
      const record = parseConversationActivityRecord(input);
      const envelope = Object.freeze({
        version: LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION,
        sequence: ++sequence,
        deliveryId: `${now().toString(36)}-${(++counter).toString(36)}`,
        record,
      });
      emit(envelope);
      await options.pubSub?.publish(channel, envelope);
    },
    subscribe(signal?: AbortSignal) {
      const queue = activityQueue(() => subscribers.delete(queue));
      subscribers.add(queue);
      if (options.pubSub && subscribed === null) {
        subscribed = options.pubSub.subscribe(channel, emit);
      }
      signal?.addEventListener("abort", () => queue.close(), { once: true });
      return queue;
    },
  });
}

const ACTIVITY_STATUSES = new Set<ConversationActivityTurnStatus>([
  "idle", "running", "completed", "error",
]);

function parseActivitySummary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("Conversation activity summary is invalid");
  const summary = value.trim();
  if (!summary || summary.length > CONVERSATION_ACTIVITY_LIMITS.summaryLength) {
    throw new TypeError("Conversation activity summary is invalid");
  }
  return summary;
}

function parseActivityProgress(
  value: ConversationActivityProgress | undefined,
): ConversationActivityProgress | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Conversation activity progress is invalid");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "completed" && key !== "total" && key !== "unit") ||
    !Number.isSafeInteger(value.completed) || value.completed < 0 ||
    !Number.isSafeInteger(value.total) || value.total < 1 || value.completed > value.total) {
    throw new TypeError("Conversation activity progress is invalid");
  }
  let unit: string | undefined;
  if (value.unit !== undefined) {
    if (typeof value.unit !== "string") {
      throw new TypeError("Conversation activity progress is invalid");
    }
    unit = value.unit.trim();
    if (!unit || unit.length > CONVERSATION_ACTIVITY_LIMITS.progressUnitLength) {
      throw new TypeError("Conversation activity progress is invalid");
    }
  }
  return Object.freeze({ completed: value.completed, total: value.total,
    ...(unit === undefined ? {} : { unit }) });
}

export function parseConversationActivityRecord(input: ConversationActivityRecord): ConversationActivityRecord {
  const conversationId = String(input.conversationId).trim();
  if (!conversationId || conversationId.length > 256 || !ACTIVITY_STATUSES.has(input.turnStatus) ||
    typeof input.unread !== "boolean") throw new TypeError("Conversation activity record is invalid");
  if (input.updatedAt !== undefined && (!Number.isFinite(Date.parse(input.updatedAt)) || input.updatedAt.length > 64)) {
    throw new TypeError("Conversation activity timestamp is invalid");
  }
  if (input.turnId !== undefined && (typeof input.turnId !== "string" || !input.turnId.trim() || input.turnId.length > 256)) {
    throw new TypeError("Conversation activity turn identity is invalid");
  }
  if (input.turnRevision !== undefined && (input.turnId === undefined ||
      !Number.isSafeInteger(input.turnRevision) || input.turnRevision < 1)) {
    throw new TypeError("Conversation activity turn revision is invalid");
  }
  const summary = parseActivitySummary(input.summary);
  const progress = parseActivityProgress(input.progress);
  if (progress !== undefined && summary === undefined) {
    throw new TypeError("Conversation activity progress requires a summary");
  }
  return Object.freeze({ conversationId, turnStatus: input.turnStatus, unread: input.unread,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.turnRevision === undefined ? {} : { turnRevision: input.turnRevision }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: new Date(input.updatedAt).toISOString() }),
    ...(summary === undefined ? {} : { summary }),
    ...(progress === undefined ? {} : { progress }) });
}

/** A delayed read acknowledgement must not consume a different or newer result. */
export function matchesConversationActivityRead(current: ConversationActivityRecord, observed: ConversationActivityRecord): boolean {
  return current.conversationId === observed.conversationId && current.turnId === observed.turnId &&
    current.turnRevision === observed.turnRevision && current.turnStatus === observed.turnStatus &&
    (current.updatedAt === observed.updatedAt || (current.updatedAt !== undefined && observed.updatedAt !== undefined &&
      Date.parse(current.updatedAt) === Date.parse(observed.updatedAt)));
}

/** Prevent delayed writers from reviving finished work or replacing a newer turn. */
export function retainConversationActivity(
  current: ConversationActivityRecord | undefined,
  incoming: ConversationActivityRecord,
): ConversationActivityRecord {
  if (!current) return incoming;
  if (current.turnRevision !== undefined && incoming.turnRevision !== undefined &&
      current.turnRevision > incoming.turnRevision) return current;
  if (current.turnId !== undefined && current.turnId === incoming.turnId) {
    // Completion is immutable for a turn, including its subsequently cleared read marker.
    if (current.turnStatus === "completed" || current.turnStatus === "error") {
      return incoming.turnStatus === current.turnStatus && current.unread && !incoming.unread
        ? Object.freeze({ ...current, unread: false }) : current;
    }
    if (current.updatedAt && incoming.updatedAt && current.updatedAt > incoming.updatedAt) return current;
  }
  return incoming;
}

function activitySnapshot(records: Iterable<ConversationActivityRecord>): readonly ConversationActivityRecord[] {
  return Object.freeze([...records].sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    String(left.conversationId).localeCompare(String(right.conversationId))));
}

/** Shared activity index for open, unopened, local, or remotely running conversations. */
export class InMemoryConversationActivityStore implements ConversationActivityStore {
  readonly #records = new Map<string, ConversationActivityRecord>();
  readonly #listeners = new Set<() => void>();
  #snapshot: readonly ConversationActivityRecord[] = Object.freeze([]);

  getSnapshot = (): readonly ConversationActivityRecord[] => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  };
  replace(records: readonly ConversationActivityRecord[]): void {
    const next = new Map<string, ConversationActivityRecord>();
    for (const input of records) {
      const record = parseConversationActivityRecord(input);
      if (next.has(String(record.conversationId))) throw new TypeError("Conversation activity record is duplicated");
      next.set(String(record.conversationId), retainConversationActivity(this.#records.get(String(record.conversationId)), record));
    }
    this.#records.clear();
    for (const [key, value] of next) this.#records.set(key, value);
    this.#publish();
  }
  upsert(input: ConversationActivityRecord): void {
    const record = parseConversationActivityRecord(input);
    const key = String(record.conversationId);
    this.#records.set(key, retainConversationActivity(this.#records.get(key), record)); this.#publish();
  }
  remove(conversationId: ConversationId | string): void {
    if (this.#records.delete(String(conversationId))) this.#publish();
  }
  markRead(conversationId: ConversationId | string): void {
    const current = this.#records.get(String(conversationId));
    if (current?.unread) {
      this.#records.set(String(conversationId), Object.freeze({ ...current, unread: false }));
      this.#publish();
    }
  }
  #publish(): void {
    const next = activitySnapshot(this.#records.values());
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

export interface PollingConversationActivityOptions {
  readonly load: (signal: AbortSignal) => Promise<readonly ConversationActivityRecord[]>;
  readonly intervalMilliseconds?: number;
  readonly store?: ConversationActivityStore;
  /** Optional protected live stream. Polling remains the convergence fallback. */
  readonly subscribe?: (signal: AbortSignal) => AsyncIterable<ConversationActivityRecord>;
  /** Receives bounded lifecycle failures for both the live and polling paths. */
  readonly diagnostics?: AiDiagnosticSink;
}

/** Cross-platform polling adapter for server-backed launcher activity indexes. */
export class PollingConversationActivity implements ConversationActivityReadable {
  readonly #store: ConversationActivityStore;
  readonly #load: PollingConversationActivityOptions["load"];
  readonly #intervalMilliseconds: number;
  readonly #subscribe: PollingConversationActivityOptions["subscribe"];
  readonly #diagnostics: AiDiagnosticSink | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;
  #liveController: AbortController | null = null;
  #pollLiveUpdates: Set<string> | null = null;

  constructor(options: PollingConversationActivityOptions) {
    const interval = options.intervalMilliseconds ?? 5_000;
    if (!Number.isSafeInteger(interval) || interval < 500 || interval > 300_000) {
      throw new TypeError("intervalMilliseconds must be between 500 and 300000");
    }
    this.#store = options.store ?? new InMemoryConversationActivityStore();
    this.#load = options.load;
    this.#subscribe = options.subscribe;
    this.#diagnostics = options.diagnostics;
    this.#intervalMilliseconds = interval;
  }
  getSnapshot = () => this.#store.getSnapshot();
  subscribe = (listener: () => void) => this.#store.subscribe(listener);
  /** Apply an authoritative write response without waiting for the next poll. */
  accept(record: ConversationActivityRecord): void {
    this.#pollLiveUpdates?.add(String(record.conversationId));
    this.#store.upsert(record);
  }
  start(): void {
    if (this.#timer === null && this.#controller === null) void this.refresh();
    if (this.#subscribe && this.#liveController === null) {
      const controller = new AbortController();
      this.#liveController = controller;
      void (async () => {
        try {
          for await (const record of this.#subscribe!(controller.signal)) {
            if (controller.signal.aborted) break;
            this.#pollLiveUpdates?.add(String(record.conversationId));
            this.#store.upsert(record);
          }
        } catch (cause) {
          if (!controller.signal.aborted) emitAiDiagnostic(this.#diagnostics, {
            domain: "activity", operation: "live_subscribe", phase: "failed",
            code: "activity_stream_unavailable", retryable: true, cause,
          });
          // The scheduled authoritative poll remains the recovery path.
        } finally {
          if (this.#liveController === controller) this.#liveController = null;
        }
      })();
    }
  }
  async refresh(): Promise<void> {
    if (this.#controller) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const controller = new AbortController(); this.#controller = controller;
    const liveUpdates = new Set<string>();
    this.#pollLiveUpdates = liveUpdates;
    try {
      const records = await this.#load(controller.signal);
      if (controller.signal.aborted) return;
      // Events received while this request was pending are newer than its snapshot.
      this.#store.replace([
        ...records.filter((record) => !liveUpdates.has(String(record.conversationId))),
        ...this.#store.getSnapshot().filter((record) => liveUpdates.has(String(record.conversationId))),
      ]);
    } catch (cause) {
      if (!controller.signal.aborted) emitAiDiagnostic(this.#diagnostics, {
        domain: "activity", operation: "poll", phase: "failed",
        code: "activity_poll_unavailable", retryable: true, cause,
      });
    }
    finally {
      if (this.#controller === controller) this.#controller = null;
      if (this.#pollLiveUpdates === liveUpdates) this.#pollLiveUpdates = null;
      if (!controller.signal.aborted) this.#timer = setTimeout(() => {
        this.#timer = null; void this.refresh();
      }, this.#intervalMilliseconds);
    }
  }
  stop(): void {
    this.#controller?.abort(); this.#controller = null;
    this.#liveController?.abort(); this.#liveController = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
