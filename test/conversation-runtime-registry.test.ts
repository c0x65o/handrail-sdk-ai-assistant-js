import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_RUNTIME_REGISTRY_LIMITS,
  ConversationRuntimeRegistry,
  ConversationCatalogError,
  createConversationRuntime,
  InMemoryConversationEventStore,
  InMemoryConversationCatalog,
  parseConversationEvent,
  parseConversationCatalogIdempotencyKey,
  parseConversationCatalogVersion,
  type ConversationCatalogAuthorizer,
  type ConversationCatalogIdempotencyKey,
  type ConversationCatalogVersion,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeRegistryPolicy,
  type ConversationTransport,
} from "../src/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function id(value: string): ConversationId {
  return value as ConversationId;
}

function key(value: string): ConversationCatalogIdempotencyKey {
  return parseConversationCatalogIdempotencyKey(value);
}

function version(value: number): ConversationCatalogVersion {
  return parseConversationCatalogVersion(value);
}

function runtime(label: string) {
  const destroy = vi.fn();
  return {
    label,
    destroy,
    value: { label, destroy } as unknown as ConversationRuntime<unknown>,
  };
}

const allowCatalog: ConversationCatalogAuthorizer<string> = () => "allow";

function catalog() {
  let timestamp = 0;
  return new InMemoryConversationCatalog<string>({
    authorize: allowCatalog,
    clock: {
      now: () => `2026-08-01T00:00:${String(timestamp++).padStart(2, "0")}.000Z` as never,
    },
    createConversationId: () => id(`generated-${timestamp}`),
  });
}

async function createConversation(
  target: ReturnType<typeof catalog>,
  conversationId: string,
) {
  return target.create({
    authorizationContext: "host",
    conversationId: id(conversationId),
    idempotencyKey: key(`create-${conversationId}`),
  });
}

const allowPolicy: ConversationRuntimeRegistryPolicy<string> = () => "allow";

function expectRegistryCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({
    name: "ConversationRuntimeRegistryError",
    code,
  });
}

describe("ConversationRuntimeRegistry", () => {
  it.each(["unavailable", "version_conflict"] as const)(
    "keeps a usable live runtime after archive %s and cleans it up on retry", async (code) => {
    const target = catalog();
    await createConversation(target, "retry");
    const eventStore = new InMemoryConversationEventStore();
    const transport: ConversationTransport<unknown, unknown> = {
      capabilities: {
        authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
      },
      async startTurn() { throw new Error("not used"); },
      async resumeTurn() { throw new Error("not used"); },
    };
    const actual = await createConversationRuntime({ conversationId: id("retry"), clientId: "client" as never,
      transport, eventStore });
    const destroy = vi.fn(() => actual.destroy());
    const live = { ...actual, destroy };
    const createRuntime = vi.fn(() => live);
    const registry = new ConversationRuntimeRegistry({ catalog: target, authorize: allowPolicy, createRuntime });
    const input = { authorizationContext: "host", conversationId: id("retry"),
      expectedVersion: version(1), idempotencyKey: key("archive-retry") };
    await registry.open({ authorizationContext: input.authorizationContext, conversationId: input.conversationId });
    if (code === "unavailable") {
      vi.spyOn(target, "archive").mockRejectedValueOnce(new ConversationCatalogError(code, "archive"));
    } else {
      await target.rename({ ...input, title: "Updated elsewhere", idempotencyKey: key("rename-retry") });
    }
    try {
      await expect(registry.archive(input)).rejects.toMatchObject({ code });
      expect(destroy).not.toHaveBeenCalled();
      expect(registry.getSnapshot()).toMatchObject({ liveCount: 1, lifecycleOperationCount: 0 });
      expect(await registry.open({ authorizationContext: input.authorizationContext, conversationId: input.conversationId })).toBe(live);
      expect(createRuntime).toHaveBeenCalledOnce();
      // Exercise the actual runtime's observation and synchronization after rejection.
      const observed = vi.fn();
      const unsubscribe = live.observe(observed);
      await eventStore.append({ conversationId: id("retry"), expectedRevision: null, events: [parseConversationEvent({
        version: 1, event_id: "after-rejection", conversation_id: "retry", revision: 1,
        occurred_at: "2026-09-09T00:00:00.000Z", actor: { type: "user", id: "host" },
        source: { type: "runtime" }, payload: { type: "message.created", message_id: "still-usable",
          role: "user", content: [{ type: "text", text: "Continue after failed archive" }] },
      })] });
      await live.synchronize!();
      expect(live.getSnapshot().messages[0]?.message_id).toBe("still-usable");
      expect(observed).toHaveBeenCalled();
      unsubscribe();
      await expect(registry.archive({ ...input, expectedVersion: version(code === "version_conflict" ? 2 : 1) }))
        .resolves.toMatchObject({ descriptor: { lifecycle: "archived" } });
      expect(destroy).toHaveBeenCalledOnce();
      expect(registry.getSnapshot().entryCount).toBe(0);
    } finally { await registry.dispose(); }
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)(
    "gates concurrent lifecycle operations and disposes a retained archive runtime on host %s", async (outcome) => {
    const target = catalog();
    await createConversation(target, "in-flight");
    const live = runtime("in-flight");
    const registry = new ConversationRuntimeRegistry({ catalog: target, authorize: allowPolicy,
      createRuntime: () => live.value });
    const input = { authorizationContext: "host", conversationId: id("in-flight"),
      expectedVersion: version(1), idempotencyKey: key("archive-in-flight") };
    await registry.open({ authorizationContext: input.authorizationContext, conversationId: input.conversationId });
    const gate = deferred<void>();
    const archive = target.archive.bind(target);
    const host = vi.spyOn(target, "archive").mockImplementation(async (value) => { await gate.promise; return archive(value); });
    const archiving = registry.archive(input);
    const settled = outcome === "failure"
      ? expect(archiving).rejects.toMatchObject({ code: "unavailable" })
      : expect(archiving).resolves.toMatchObject({ descriptor: { lifecycle: "archived" } });
    try {
      await vi.waitFor(() => expect(host).toHaveBeenCalledOnce());
      expect(live.destroy).not.toHaveBeenCalled();
      await expectRegistryCode(registry.open({ authorizationContext: input.authorizationContext,
        conversationId: input.conversationId }), "lifecycle_in_progress");
      await expectRegistryCode(registry.release(input.conversationId), "lifecycle_in_progress");
      for (const operation of ["archive", "clear", "restore", "permanentlyDelete"] as const) {
        await expectRegistryCode(registry[operation](input), "lifecycle_in_progress");
      }
      expect(host).toHaveBeenCalledOnce();
      const disposing = registry.dispose();
      expect(registry.dispose()).toBe(disposing);
      await disposing;
      expect(live.destroy).toHaveBeenCalledOnce();
    } finally {
      if (outcome === "failure") gate.reject(new ConversationCatalogError("unavailable", "archive"));
      else gate.resolve();
      await settled;
      await registry.dispose();
    }
    expect(live.destroy).toHaveBeenCalledOnce();
    expect(registry.getSnapshot()).toMatchObject({ disposed: true, entryCount: 0 });
    await expectRegistryCode(registry.open({ authorizationContext: input.authorizationContext, conversationId: input.conversationId }), "disposed");
  });

  it.each(["success", "failure"] as const)(
    "invalidates a pending construction during archive %s and permits a fresh runtime", async (outcome) => {
    const target = catalog();
    await createConversation(target, "pending-archive");
    const pending = deferred<ConversationRuntime<unknown>>();
    const stale = runtime("stale");
    const fresh = runtime("fresh");
    const createRuntime = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(fresh.value);
    const registry = new ConversationRuntimeRegistry({ catalog: target, authorize: allowPolicy, createRuntime });
    const input = { authorizationContext: "host", conversationId: id("pending-archive") };
    const opening = registry.open(input);
    const invalidated = expectRegistryCode(opening, "construction_invalidated");
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());
    if (outcome === "failure") {
      vi.spyOn(target, "archive").mockRejectedValueOnce(new ConversationCatalogError("unavailable", "archive"));
    }
    try {
      const archiving = registry.archive({ ...input, expectedVersion: version(1), idempotencyKey: key("pending-archive") });
      if (outcome === "failure") await expect(archiving).rejects.toMatchObject({ code: "unavailable" });
      else await expect(archiving).resolves.toMatchObject({ descriptor: { lifecycle: "archived" } });
      expect(createRuntime.mock.calls[0]?.[0].signal.aborted).toBe(true);
      pending.resolve(stale.value);
      await invalidated;
      expect(stale.destroy).toHaveBeenCalledOnce();
      expect(await registry.open(input)).toBe(fresh.value);
      expect(createRuntime).toHaveBeenCalledTimes(2);
    } finally { pending.resolve(stale.value); await invalidated; await registry.dispose(); }
    expect(stale.destroy).toHaveBeenCalledOnce();
    expect(fresh.destroy).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent same-ID opens and isolates different IDs", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "same"),
      createConversation(target, "other"),
    ]);
    const constructions = new Map<string, Deferred<ConversationRuntime<unknown>>>();
    const createRuntime = vi.fn(({ conversationId }: { conversationId: ConversationId }) => {
      const operation = deferred<ConversationRuntime<unknown>>();
      constructions.set(conversationId, operation);
      return operation.promise;
    });
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    const first = registry.open({ authorizationContext: "host", conversationId: id("same") });
    const concurrent = registry.open({ authorizationContext: "host", conversationId: id("same") });
    const other = registry.open({ authorizationContext: "host", conversationId: id("other") });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2));
    const sameRuntime = runtime("same");
    const otherRuntime = runtime("other");
    constructions.get("same")!.resolve(sameRuntime.value);
    constructions.get("other")!.resolve(otherRuntime.value);

    expect(await first).toBe(sameRuntime.value);
    expect(await concurrent).toBe(sameRuntime.value);
    expect(await other).toBe(otherRuntime.value);
    expect(await registry.open({
      authorizationContext: "host",
      conversationId: id("same"),
    })).toBe(sameRuntime.value);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("removes failed construction so a later open can retry", async () => {
    const target = catalog();
    await createConversation(target, "retry");
    const created = runtime("retry");
    const failure = new Error("host factory failed");
    const createRuntime = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(created.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("retry"),
    })).rejects.toBe(failure);
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("retry"),
    })).resolves.toBe(created.value);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("releases live and pending runtimes without deleting catalog identity", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "live"),
      createConversation(target, "pending"),
    ]);
    const live = runtime("live");
    const late = runtime("late");
    const pending = deferred<ConversationRuntime<unknown>>();
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime: ({ conversationId }) =>
        conversationId === id("live") ? live.value : pending.promise,
    });

    await registry.open({ authorizationContext: "host", conversationId: id("live") });
    expect(await registry.release(id("live"))).toBe(true);
    expect(live.destroy).toHaveBeenCalledTimes(1);

    const opening = registry.open({ authorizationContext: "host", conversationId: id("pending") });
    await vi.waitFor(() => expect(registry.getSnapshot().pendingCount).toBe(1));
    const releasing = registry.release(id("pending"));
    pending.resolve(late.value);
    await expectRegistryCode(opening, "construction_invalidated");
    await expect(releasing).resolves.toBe(true);
    expect(late.destroy).toHaveBeenCalledTimes(1);
    await expect(target.get({
      authorizationContext: "host",
      conversationId: id("pending"),
    })).resolves.toMatchObject({ status: "found" });
    await registry.dispose();
  });

  it("clears without tombstoning and constructs a fresh runtime afterward", async () => {
    const target = catalog();
    await createConversation(target, "clearable");
    const before = runtime("before");
    const after = runtime("after");
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(before.value)
      .mockResolvedValueOnce(after.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    await registry.open({ authorizationContext: "host", conversationId: id("clearable") });
    const cleared = await registry.clear({
      authorizationContext: "host",
      conversationId: id("clearable"),
      expectedVersion: version(1),
      idempotencyKey: key("clear-clearable"),
    });
    expect(cleared.descriptor.version).toBe(2);
    expect(before.destroy).toHaveBeenCalledTimes(1);
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("clearable"),
    })).resolves.toBe(after.value);
    expect(registry.getSnapshot().tombstoneCount).toBe(0);
    await registry.dispose();
  });

  it("uses supplied policy for archived opens and restore", async () => {
    const target = catalog();
    await createConversation(target, "archived");
    let allowArchivedOpen = false;
    let allowRestore = false;
    const policy = vi.fn<ConversationRuntimeRegistryPolicy<string>>(({ action, descriptor }) => {
      if (action === "open" && descriptor.lifecycle === "archived") {
        return allowArchivedOpen ? "allow" : "deny";
      }
      if (action === "restore") return allowRestore ? "allow" : "deny";
      return "allow";
    });
    const activeRuntime = runtime("active");
    const archivedRuntime = runtime("archived");
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(activeRuntime.value)
      .mockResolvedValueOnce(archivedRuntime.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: policy,
      createRuntime,
    });

    await registry.open({ authorizationContext: "host", conversationId: id("archived") });
    await expect(registry.archive({
      authorizationContext: "host",
      conversationId: id("archived"),
      expectedVersion: version(1),
      idempotencyKey: key("archive-first"),
    })).resolves.toMatchObject({ descriptor: { lifecycle: "archived", version: 2 } });
    expect(activeRuntime.destroy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ action: "archive" }));

    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("archived"),
    }), "policy_denied");
    allowArchivedOpen = true;
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("archived"),
    })).resolves.toBe(archivedRuntime.value);
    await registry.release(id("archived"));

    const restoreInput = {
      authorizationContext: "host",
      conversationId: id("archived"),
      expectedVersion: version(2),
      idempotencyKey: key("restore-archived"),
    } as const;
    await expectRegistryCode(registry.restore(restoreInput), "policy_denied");
    expect((await target.get({
      authorizationContext: "host",
      conversationId: id("archived"),
    })).descriptor.lifecycle).toBe("archived");
    allowRestore = true;
    await expect(registry.restore(restoreInput)).resolves.toMatchObject({
      descriptor: { lifecycle: "active", version: 3 },
    });
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ action: "restore" }));
    await registry.dispose();
  });

  it("tombstones permanent deletion and destroys a late stale construction", async () => {
    const target = catalog();
    await createConversation(target, "deleted");
    const pending = deferred<ConversationRuntime<unknown>>();
    const stale = runtime("stale");
    const createRuntime = vi.fn(() => pending.promise);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    const opening = registry.open({ authorizationContext: "host", conversationId: id("deleted") });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    await registry.permanentlyDelete({
      authorizationContext: "host",
      conversationId: id("deleted"),
      expectedVersion: version(1),
      idempotencyKey: key("delete-deleted"),
    });
    pending.resolve(stale.value);
    await expectRegistryCode(opening, "permanently_deleted");
    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot()).toMatchObject({ entryCount: 1, tombstoneCount: 1 });
    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("deleted"),
    }), "permanently_deleted");
    expect(createRuntime).toHaveBeenCalledTimes(1);
    await registry.dispose();
    expect(stale.destroy).toHaveBeenCalledTimes(1);
  });

  it("disposes live and late runtimes exactly once and rejects further use", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "live"),
      createConversation(target, "late"),
    ]);
    const live = runtime("live");
    const late = runtime("late");
    const pending = deferred<ConversationRuntime<unknown>>();
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime: ({ conversationId }) =>
        conversationId === id("live") ? live.value : pending.promise,
    });
    await registry.open({ authorizationContext: "host", conversationId: id("live") });
    const opening = registry.open({ authorizationContext: "host", conversationId: id("late") });
    await vi.waitFor(() => expect(registry.getSnapshot().pendingCount).toBe(1));

    const disposing = registry.dispose();
    expect(registry.dispose()).toBe(disposing);
    expect(live.destroy).toHaveBeenCalledTimes(1);
    pending.resolve(late.value);
    await disposing;
    await expectRegistryCode(opening, "disposed");
    expect(late.destroy).toHaveBeenCalledTimes(1);
    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("live"),
    }), "disposed");
    await expectRegistryCode(registry.release(id("live")), "disposed");
    expect(live.destroy).toHaveBeenCalledTimes(1);
    expect(late.destroy).toHaveBeenCalledTimes(1);
  });

  it("enforces construction and retained-entry bounds without unbounded queues", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "one"),
      createConversation(target, "two"),
    ]);
    const first = deferred<ConversationRuntime<unknown>>();
    const firstRuntime = runtime("one");
    const secondRuntime = runtime("two");
    const createRuntime = vi.fn(({ conversationId }: { conversationId: ConversationId }) =>
      conversationId === id("one") ? first.promise : secondRuntime.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
      limits: { maxEntries: 1, maxConcurrentConstructions: 1 },
    });

    const opening = registry.open({ authorizationContext: "host", conversationId: id("one") });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("two"),
    }), "capacity_exhausted");
    expect(registry.getSnapshot()).toMatchObject({
      entryCount: 1,
      pendingCount: 1,
      activeConstructionCount: 1,
    });
    first.resolve(firstRuntime.value);
    await opening;
    await registry.release(id("one"));
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("two"),
    })).resolves.toBe(secondRuntime.value);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("validates every configurable limit", () => {
    const target = catalog();
    const options = {
      catalog: target,
      authorize: allowPolicy,
      createRuntime: () => runtime("unused").value,
    };
    for (const limits of [
      { maxEntries: 0 },
      { maxEntries: CONVERSATION_RUNTIME_REGISTRY_LIMITS.entriesMaximum + 1 },
      { maxConcurrentConstructions: 0 },
      {
        maxConcurrentConstructions:
          CONVERSATION_RUNTIME_REGISTRY_LIMITS.concurrentConstructionsMaximum + 1,
      },
      { maxEntries: 1.5 },
      { unexpected: 1 },
    ]) {
      expect(() => new ConversationRuntimeRegistry({
        ...options,
        limits,
      } as never)).toThrowError(expect.objectContaining({
        name: "ConversationRuntimeRegistryError",
        code: "invalid_options",
      }));
    }
  });
});
