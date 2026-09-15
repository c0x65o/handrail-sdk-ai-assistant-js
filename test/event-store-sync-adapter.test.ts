import { describe, expect, it, vi } from "vitest";
import {
  InMemoryConversationEventStore,
  ConversationSyncMutationRejectedError,
  createEventStoreConversationSyncAdapter,
  parseConversationEvent,
  type ConversationClientMutationId,
  type ConversationEventId,
  type ConversationId,
  type ConversationSyncMutation,
  type ConversationSyncMutationEvent,
} from "../src/index.js";

const conversationId = "conversation-sync" as ConversationId;

function proposal(mutationId: string, step: number): ConversationSyncMutation {
  const event = parseConversationEvent({
    version: 1,
    event_id: `untrusted-${mutationId}`,
    conversation_id: conversationId,
    revision: step,
    occurred_at: `2026-08-31T20:00:0${step}.000Z`,
    actor: { type: "user", id: "spoofed-user" },
    source: { type: "client", client_id: "spoofed-client", device_id: "spoofed-device" },
    mutation_id: mutationId,
    payload: { type: "conversation.metadata_updated", metadata: { step } },
  }) as ConversationSyncMutationEvent;
  return { mutationId: mutationId as ConversationClientMutationId, events: [event] };
}

function adapter(store: InMemoryConversationEventStore, userId: string, clientId: string, allowed = true) {
  let event = 0;
  const canonicalizeMutation = vi.fn(async ({ proposedEvent }: { proposedEvent: ConversationSyncMutationEvent }) => {
    if (proposedEvent.payload.type !== "conversation.metadata_updated") throw new TypeError("denied");
    return {
      actor: { type: "user" as const, id: userId as never },
      source: { type: "client" as const, client_id: clientId as never, device_id: `${clientId}-device` as never },
      payload: proposedEvent.payload,
    };
  });
  return {
    canonicalizeMutation,
    sync: createEventStoreConversationSyncAdapter({
      authorizationContext: { userId },
      eventStore: store,
      authorize: () => allowed,
      canonicalizeMutation,
      createEventId: () => `server-event-${userId}-${clientId}-${++event}` as ConversationEventId,
      now: () => "2026-08-31T21:00:00.000Z" as never,
      subscriptionPollingMilliseconds: 100,
    }),
  };
}

describe("event-store conversation synchronization adapter", () => {
  it("returns a permanent, safe mutation rejection without pretending permission was denied", async () => {
    const store = new InMemoryConversationEventStore();
    vi.spyOn(store, "append").mockRejectedValue(new ConversationSyncMutationRejectedError("attachment_expired"));
    const sync = adapter(store, "user", "browser").sync;
    const result = await sync.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("expired", 1)] });
    expect(result).toEqual({ status: "rejected", code: "attachment_expired",
      message: "A file upload expired before the message was saved. Select the file again." });
    expect((await store.read({ conversationId })).entries).toHaveLength(0);
  });
  it("returns a conflict when history advances during validation, but still denies invalid current batches", async () => {
    const store = new InMemoryConversationEventStore();
    const writer = adapter(store, "user", "writer");
    let advance = true;
    const sync = createEventStoreConversationSyncAdapter({ authorizationContext: {}, eventStore: store, authorize: () => true,
      canonicalizeMutation: ({ proposedEvent }) => ({ actor: { type: "user" }, source: proposedEvent.source, payload: proposedEvent.payload }),
      createEventId: () => "validation-race" as never,
      async validateCanonicalBatch() {
        if (advance) {
          advance = false;
          await writer.sync.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("concurrent", 1)] });
        }
        throw new TypeError("The replay advanced or the transition is invalid");
      } });
    await expect(sync.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("obsolete", 1)] }))
      .resolves.toMatchObject({ status: "conflict", actualRevision: 1 });
    await expect(sync.appendMutations({ conversationId, expectedRevision: 1 as never, mutations: [proposal("invalid", 2)] }))
      .resolves.toMatchObject({ status: "unauthorized" });
    expect(await store.getLatestRevision(conversationId)).toBe(1);
  });

  it("returns a newer canonical revision before validating an obsolete batch", async () => {
    const store = new InMemoryConversationEventStore();
    const first = adapter(store, "user", "first");
    await first.sync.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("first", 1)] });
    const validateCanonicalBatch = vi.fn(() => { throw new TypeError("Obsolete revisions cannot be replayed"); });
    const stale = createEventStoreConversationSyncAdapter({ authorizationContext: {}, eventStore: store, authorize: () => true,
      canonicalizeMutation: ({ proposedEvent }) => ({ actor: { type: "user" }, source: proposedEvent.source, payload: proposedEvent.payload }),
      createEventId: () => "stale-event" as never, validateCanonicalBatch });
    await expect(stale.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("stale", 1)] }))
      .resolves.toMatchObject({ status: "conflict", actualRevision: 1 });
    expect(validateCanonicalBatch).not.toHaveBeenCalled();
  });

  it("converges two devices on server-authored events and acknowledges lost-response retries exactly once", async () => {
    const store = new InMemoryConversationEventStore();
    const first = adapter(store, "user-1", "client-1");
    const second = adapter(store, "user-1", "client-2");
    const firstMutation = proposal("mutation-1", 1);

    const accepted = await first.sync.appendMutations({ conversationId, expectedRevision: null,
      mutations: [firstMutation] });
    expect(accepted).toMatchObject({ status: "mutations", latestRevision: 1,
      acknowledgements: [{ status: "accepted", mutationId: "mutation-1", events: [{
        event_id: "server-event-user-1-client-1-1", revision: 1,
        occurred_at: "2026-08-31T21:00:00.000Z",
        actor: { type: "user", id: "user-1" },
        source: { type: "client", client_id: "client-1", device_id: "client-1-device" },
      }] }] });

    const snapshot = await second.sync.pullSnapshot({ conversationId });
    expect(snapshot).toMatchObject({ status: "snapshot", snapshot: {
      revision: 1, state: { revision: 1, metadata: { step: 1 } },
    } });
    const secondMutation = proposal("mutation-2", 2);
    await expect(second.sync.appendMutations({ conversationId, expectedRevision: 1 as never,
      mutations: [secondMutation] })).resolves.toMatchObject({ status: "mutations", latestRevision: 2 });
    await expect(first.sync.readSince({ conversationId, afterRevision: 1 as never })).resolves.toMatchObject({
      status: "events", revision: 2, latestRevision: 2,
      events: [{ mutation_id: "mutation-2", source: { client_id: "client-2" } }],
    });

    const duplicate = await first.sync.appendMutations({ conversationId, expectedRevision: null,
      mutations: [firstMutation] });
    expect(duplicate).toMatchObject({ status: "mutations", latestRevision: 2,
      acknowledgements: [{ status: "duplicate", mutationId: "mutation-1",
        events: [{ event_id: "server-event-user-1-client-1-1", revision: 1 }] }] });
    expect((await store.read({ conversationId })).entries).toHaveLength(2);

    await expect(first.sync.appendMutations({ conversationId, expectedRevision: null,
      mutations: [proposal("mutation-1", 9)] })).resolves.toEqual({
      status: "unauthorized", message: "Conversation synchronization was denied.",
    });
    expect((await store.read({ conversationId })).entries).toHaveLength(2);
  });

  it("keeps optimistic competing batches atomic and lets the losing device converge", async () => {
    const store = new InMemoryConversationEventStore();
    const first = adapter(store, "user-1", "client-1").sync;
    const second = adapter(store, "user-1", "client-2").sync;
    const [left, right] = await Promise.all([
      first.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("left", 1)] }),
      second.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("right", 1)] }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["conflict", "mutations"]);
    const conflict = left.status === "conflict" ? left : right;
    expect(conflict).toEqual({ status: "conflict", expectedRevision: null, actualRevision: 1 });
    const converged = await (left.status === "conflict" ? first : second).pullSnapshot({ conversationId });
    expect(converged).toMatchObject({ status: "snapshot", snapshot: { revision: 1 } });
    expect((await store.read({ conversationId })).entries).toHaveLength(1);
  });

  it("fails closed before reading or canonicalizing an unauthorized conversation", async () => {
    const store = new InMemoryConversationEventStore();
    const denied = adapter(store, "user-2", "client-2", false);
    await expect(denied.sync.pullSnapshot({ conversationId })).resolves.toMatchObject({ status: "unauthorized" });
    await expect(denied.sync.readSince({ conversationId, afterRevision: null })).resolves.toMatchObject({ status: "unauthorized" });
    await expect(denied.sync.appendMutations({ conversationId, expectedRevision: null,
      mutations: [proposal("denied", 1)] })).resolves.toMatchObject({ status: "unauthorized" });
    expect(denied.canonicalizeMutation).not.toHaveBeenCalled();
    expect(await store.getLatestRevision(conversationId)).toBeNull();
  });

  it("polls subscriptions from the requested revision without inventing ephemeral facts", async () => {
    const store = new InMemoryConversationEventStore();
    const sync = adapter(store, "user-1", "client-1").sync;
    const subscribed = await sync.subscribeSince({ conversationId, afterRevision: null });
    expect(subscribed.status).toBe("subscribed");
    if (subscribed.status !== "subscribed") return;
    const next = subscribed.subscription.updates[Symbol.asyncIterator]().next();
    await sync.appendMutations({ conversationId, expectedRevision: null, mutations: [proposal("live", 1)] });
    await expect(next).resolves.toMatchObject({ value: { status: "events", revision: 1,
      events: [{ mutation_id: "live" }] } });
    subscribed.subscription.close();
  });

  it("denies an entire canonical batch when a host cross-event invariant fails", async () => {
    const store = new InMemoryConversationEventStore();
    const validateCanonicalBatch = vi.fn(() => { throw new TypeError("turn admission is not self-consistent"); });
    const sync = createEventStoreConversationSyncAdapter({
      authorizationContext: { userId: "user-1" },
      eventStore: store,
      authorize: () => true,
      canonicalizeMutation: async ({ proposedEvent }) => ({
        actor: { type: "user" }, source: proposedEvent.source, payload: proposedEvent.payload,
      }),
      createEventId: () => "server-batch-event" as ConversationEventId,
      validateCanonicalBatch,
    });
    await expect(sync.appendMutations({ conversationId, expectedRevision: null,
      mutations: [proposal("invalid-batch", 1)] })).resolves.toMatchObject({ status: "unauthorized" });
    expect(validateCanonicalBatch).toHaveBeenCalledOnce();
    expect(await store.getLatestRevision(conversationId)).toBeNull();
  });

  it("lets the atomic store decide when a preliminary latest-revision read is stale", async () => {
    const authority = new InMemoryConversationEventStore();
    const staleReader = {
      append: authority.append.bind(authority),
      read: authority.read.bind(authority),
      getLatestRevision: vi.fn(async () => null),
    };
    const sync = createEventStoreConversationSyncAdapter({
      authorizationContext: { userId: "user-1" },
      eventStore: staleReader,
      authorize: () => true,
      canonicalizeMutation: async ({ proposedEvent }) => ({
        actor: { type: "user" }, source: proposedEvent.source, payload: proposedEvent.payload,
      }),
      createEventId: ({ mutationId }) => `server:${mutationId}` as ConversationEventId,
    });
    await authority.append({ conversationId, expectedRevision: null, events: [
      parseConversationEvent({
        version: 1, event_id: "seed-event", conversation_id: conversationId, revision: 1,
        occurred_at: "2026-08-31T20:00:00.000Z", actor: { type: "user" },
        source: { type: "client", client_id: "seed-client" }, mutation_id: "seed-mutation",
        payload: { type: "conversation.metadata_updated", metadata: { seed: true } },
      }),
    ] });
    await expect(sync.appendMutations({ conversationId, expectedRevision: 1 as never,
      mutations: [proposal("after-stale-read", 2)] })).resolves.toMatchObject({
        status: "mutations", latestRevision: 2,
      });
    await expect(sync.readSince({ conversationId, afterRevision: 1 as never })).resolves.toMatchObject({
      status: "events", revision: 2, latestRevision: 2,
      events: [{ mutation_id: "after-stale-read" }],
    });
    expect(await authority.getLatestRevision(conversationId)).toBe(2);
  });
});
