import { describe, expect, it, vi } from "vitest";

import {
  InMemoryConversationCatalog,
  parseConversationCatalogIdempotencyKey,
  parseConversationCatalogVersion,
  type ConversationCatalogAuthorizer,
  type ConversationCatalogIdempotencyKey,
  type ConversationCatalogVersion,
  type ConversationId,
  type ConversationTimestamp,
  type InMemoryConversationCatalogLimits,
} from "../src/index.js";

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T00:00:01.000Z";
const T2 = "2026-08-01T00:00:02.000Z";
const T3 = "2026-08-01T00:00:03.000Z";
const T4 = "2026-08-01T00:00:04.000Z";
const T5 = "2026-08-01T00:00:05.000Z";

const allow: ConversationCatalogAuthorizer<string> = () => "allow";

function key(value: string): ConversationCatalogIdempotencyKey {
  return parseConversationCatalogIdempotencyKey(value);
}

function version(value: number): ConversationCatalogVersion {
  return parseConversationCatalogVersion(value);
}

function id(value: string): ConversationId {
  return value as ConversationId;
}

function clock(...values: string[]): { now(): ConversationTimestamp } {
  let index = 0;
  return {
    now: () => (values[Math.min(index++, values.length - 1)] ?? T0) as ConversationTimestamp,
  };
}

function catalog(
  options: {
    readonly authorize?: ConversationCatalogAuthorizer<string>;
    readonly times?: readonly string[];
    readonly ids?: readonly string[];
    readonly limits?: Partial<InMemoryConversationCatalogLimits>;
  } = {},
): InMemoryConversationCatalog<string> {
  let idIndex = 0;
  const ids = options.ids ?? ["generated-1", "generated-2"];
  return new InMemoryConversationCatalog({
    authorize: options.authorize ?? allow,
    clock: clock(...(options.times ?? [T0])),
    createConversationId: () => ids[idIndex++] ?? `generated-${idIndex}`,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

async function create(
  target: InMemoryConversationCatalog<string>,
  conversationId: string,
  idempotencyKey = `create-${conversationId}`,
) {
  return target.create({
    authorizationContext: "allow",
    conversationId: id(conversationId),
    title: `Title ${conversationId}`,
    metadata: { label: conversationId },
    idempotencyKey: key(idempotencyKey),
  });
}

function expectCode(
  promise: Promise<unknown>,
  code: string,
  operation?: string,
): Promise<unknown> {
  return expect(promise).rejects.toMatchObject({
    name: "ConversationCatalogError",
    code,
    ...(operation === undefined ? {} : { operation }),
  });
}

describe("InMemoryConversationCatalog", () => {
  it("creates, gets, and keyset-paginates stable timestamp/ID ordering", async () => {
    const target = catalog({ times: [T0, T0, T1, T2] });
    await create(target, "b");
    await create(target, "a");
    await create(target, "c");

    const first = await target.list({
      authorizationContext: "allow",
      lifecycle: "all",
      pageSize: 2,
      order: { field: "updated_at", direction: "desc" },
    });
    expect(first.items.map(({ conversationId }) => conversationId)).toEqual(["c", "a"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await target.list({
      authorizationContext: "allow",
      lifecycle: "all",
      pageSize: 2,
      order: first.order,
      cursor: first.nextCursor!,
    });
    expect(second.items.map(({ conversationId }) => conversationId)).toEqual(["b"]);
    expect(second.hasMore).toBe(false);
    expect((await target.get({
      authorizationContext: "allow",
      conversationId: id("a"),
    })).descriptor.title).toBe("Title a");

    await target.archive({
      authorizationContext: "allow",
      conversationId: id("a"),
      expectedVersion: version(1),
      idempotencyKey: key("archive-a"),
    });
    const active = await target.list({
      authorizationContext: "allow",
      lifecycle: "active",
      pageSize: 10,
      order: { field: "updated_at", direction: "desc" },
    });
    const archived = await target.list({
      authorizationContext: "allow",
      lifecycle: "archived",
      pageSize: 10,
      order: { field: "updated_at", direction: "desc" },
    });
    const allByCreated = await target.list({
      authorizationContext: "allow",
      lifecycle: "all",
      pageSize: 10,
      order: { field: "created_at", direction: "desc" },
    });
    expect(active.items.map(({ conversationId }) => conversationId)).toEqual(["c", "b"]);
    expect(archived.items.map(({ conversationId }) => conversationId)).toEqual(["a"]);
    expect(allByCreated.items.map(({ conversationId }) => conversationId)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("implements rename, clear, archive, restore, and irreversible delete", async () => {
    const target = catalog({ times: [T0, T1, T2, T3, T4, T5] });
    const created = await create(target, "lifecycle");
    expect(created.descriptor.version).toBe(1);

    const renamed = await target.rename({
      authorizationContext: "allow",
      conversationId: id("lifecycle"),
      expectedVersion: version(1),
      idempotencyKey: key("rename-lifecycle"),
      title: "Renamed",
    });
    expect(renamed.descriptor).toMatchObject({ title: "Renamed", version: 2 });

    const cleared = await target.clear({
      authorizationContext: "allow",
      conversationId: id("lifecycle"),
      expectedVersion: version(2),
      idempotencyKey: key("clear-lifecycle"),
    });
    expect(cleared.descriptor).toMatchObject({
      conversationId: id("lifecycle"),
      lifecycle: "active",
      version: 3,
    });

    const archived = await target.archive({
      authorizationContext: "allow",
      conversationId: id("lifecycle"),
      expectedVersion: version(3),
      idempotencyKey: key("archive-lifecycle"),
    });
    expect(archived.descriptor).toMatchObject({
      lifecycle: "archived",
      archivedAt: T3,
      version: 4,
    });

    const restored = await target.restore({
      authorizationContext: "allow",
      conversationId: id("lifecycle"),
      expectedVersion: version(4),
      idempotencyKey: key("restore-lifecycle"),
    });
    expect(restored.descriptor).toMatchObject({
      lifecycle: "active",
      archivedAt: null,
      version: 5,
    });

    const deletionInput = {
      authorizationContext: "allow",
      conversationId: id("lifecycle"),
      expectedVersion: version(5),
      idempotencyKey: key("delete-lifecycle"),
    } as const;
    const deleted = await target.permanentlyDelete(deletionInput);
    expect(deleted).toEqual({
      operation: "permanent_delete",
      status: "deleted",
      conversationId: id("lifecycle"),
      deletedVersion: 5,
    });
    expect(await target.permanentlyDelete(deletionInput)).toEqual({
      ...deleted,
      status: "idempotent",
    });
    await expectCode(target.get({
      authorizationContext: "allow",
      conversationId: id("lifecycle"),
    }), "not_found", "get");
    await expectCode(target.restore({
      ...deletionInput,
      idempotencyKey: key("restore-deleted"),
    }), "not_found", "restore");
    await expectCode(create(target, "lifecycle", "recreate-deleted"),
      "idempotency_conflict", "create");
  });

  it("enforces versions and replays immutable original mutation results", async () => {
    const target = catalog({ times: [T0, T1, T2] });
    await create(target, "retry");
    const renameInput = {
      authorizationContext: "allow",
      conversationId: id("retry"),
      expectedVersion: version(1),
      idempotencyKey: key("retry-key"),
      title: "Original rename",
    } as const;
    const renamed = await target.rename(renameInput);
    await target.clear({
      authorizationContext: "allow",
      conversationId: id("retry"),
      expectedVersion: version(2),
      idempotencyKey: key("later-clear"),
    });
    expect(await target.rename(renameInput)).toEqual({
      ...renamed,
      status: "idempotent",
    });
    expect((await target.get({
      authorizationContext: "allow",
      conversationId: id("retry"),
    })).descriptor.version).toBe(3);

    await expectCode(target.rename({
      ...renameInput,
      idempotencyKey: key("stale-rename"),
      title: "Stale",
    }), "version_conflict", "rename");
    await expectCode(target.rename({
      ...renameInput,
      title: "Changed payload",
    }), "idempotency_conflict", "rename");
    await expectCode(target.clear({
      authorizationContext: "allow",
      conversationId: id("retry"),
      expectedVersion: version(1),
      idempotencyKey: key("retry-key"),
    }), "idempotency_conflict", "clear");
  });

  it("authorizes before existence and idempotency access without leakage", async () => {
    const requests: unknown[] = [];
    const target = catalog({
      authorize: (request) => {
        requests.push(request);
        if (request.authorizationContext === "throw") throw new Error("host detail");
        return request.authorizationContext === "allow" ? "allow" : "deny";
      },
      times: [T0, T1],
    });
    await create(target, "secret");
    const renameInput = {
      authorizationContext: "allow",
      conversationId: id("secret"),
      expectedVersion: version(1),
      idempotencyKey: key("authorized-retry"),
      title: "Safe",
    } as const;
    await target.rename(renameInput);

    for (const [authorizationContext, conversationId] of [
      ["deny", "secret"],
      ["deny", "absent"],
      ["throw", "secret"],
      ["throw", "absent"],
    ] as const) {
      await expectCode(target.get({ authorizationContext, conversationId: id(conversationId) }),
        "forbidden", "get");
    }
    await expectCode(target.rename({
      ...renameInput,
      authorizationContext: "deny",
    }), "forbidden", "rename");
    expect(requests.at(-1)).toEqual({
      action: "rename",
      authorizationContext: "deny",
      conversationId: id("secret"),
    });
    expect(requests.at(-1)).not.toHaveProperty("descriptor");
  });

  it("enforces record and tombstone capacities without discarding state", async () => {
    const recordBound = catalog({ limits: { maxRecords: 1 } });
    await create(recordBound, "one");
    await expectCode(create(recordBound, "two"), "unavailable", "create");
    expect((await recordBound.get({
      authorizationContext: "allow",
      conversationId: id("one"),
    })).descriptor.conversationId).toBe("one");

    const tombstoneBound = catalog({
      limits: { maxRecords: 2, maxTombstones: 1 },
      times: [T0, T0, T1, T1],
    });
    await create(tombstoneBound, "deleted");
    await create(tombstoneBound, "retained");
    await tombstoneBound.permanentlyDelete({
      authorizationContext: "allow",
      conversationId: id("deleted"),
      expectedVersion: version(1),
      idempotencyKey: key("delete-first"),
    });
    await expectCode(tombstoneBound.permanentlyDelete({
      authorizationContext: "allow",
      conversationId: id("retained"),
      expectedVersion: version(1),
      idempotencyKey: key("delete-overflow"),
    }), "unavailable", "permanent_delete");
    expect((await tombstoneBound.get({
      authorizationContext: "allow",
      conversationId: id("retained"),
    })).descriptor.version).toBe(1);
    await expectCode(create(tombstoneBound, "deleted", "recreate-first"),
      "idempotency_conflict", "create");
  });

  it("evicts idempotency history FIFO at its configured bound", async () => {
    const target = catalog({
      limits: { maxRecords: 2, maxIdempotencyEntries: 1 },
      times: [T0, T1],
    });
    await create(target, "bounded", "oldest-key");
    await target.rename({
      authorizationContext: "allow",
      conversationId: id("bounded"),
      expectedVersion: version(1),
      idempotencyKey: key("newest-key"),
      title: "Renamed",
    });
    await expectCode(create(target, "bounded", "oldest-key"),
      "idempotency_conflict", "create");
  });

  it("isolates catalog instances", async () => {
    const first = catalog();
    const second = catalog();
    await create(first, "isolated");
    await expectCode(second.get({
      authorizationContext: "allow",
      conversationId: id("isolated"),
    }), "not_found", "get");
    expect((await first.get({
      authorizationContext: "allow",
      conversationId: id("isolated"),
    })).descriptor.conversationId).toBe("isolated");
  });

  it("snapshots mutable inputs and returns deeply frozen independent results", async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const idFactory = vi.fn(() => "generated-safe");
    const target = catalog({
      authorize: async () => {
        await authorizationGate;
        return "allow" as const;
      },
      ids: [],
    });
    const metadata: { label: string; nested: { values: string[] } } = {
      label: "original",
      nested: { values: ["safe"] },
    };
    const pending = new InMemoryConversationCatalog<string>({
      authorize: async () => {
        await authorizationGate;
        return "allow" as const;
      },
      clock: clock(T0),
      createConversationId: idFactory,
    }).create({
      authorizationContext: "allow",
      metadata,
      idempotencyKey: key("mutable-create"),
    });
    metadata.label = "mutated";
    metadata.nested.values[0] = "mutated";
    releaseAuthorization();

    const created = await pending;
    expect(idFactory).toHaveBeenCalledTimes(1);
    expect(created.descriptor.metadata).toEqual({
      label: "original",
      nested: { values: ["safe"] },
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.descriptor)).toBe(true);
    expect(Object.isFrozen(created.descriptor.metadata)).toBe(true);
    expect(Object.isFrozen(created.descriptor.metadata.nested)).toBe(true);
    expect(() => {
      (created.descriptor.metadata.nested as { values: string[] }).values[0] = "changed";
    }).toThrow();

    const loaded = await target.create({
      authorizationContext: "allow",
      conversationId: id("separate"),
      idempotencyKey: key("separate-create"),
    });
    expect(loaded.descriptor.conversationId).toBe("separate");
  });

  it("serializes concurrent mutations at the optimistic version boundary", async () => {
    const target = catalog({ times: [T0, T1, T1] });
    await create(target, "atomic");
    const [left, right] = await Promise.allSettled([
      target.rename({
        authorizationContext: "allow",
        conversationId: id("atomic"),
        expectedVersion: version(1),
        idempotencyKey: key("atomic-left"),
        title: "Left",
      }),
      target.rename({
        authorizationContext: "allow",
        conversationId: id("atomic"),
        expectedVersion: version(1),
        idempotencyKey: key("atomic-right"),
        title: "Right",
      }),
    ]);
    const outcomes = [left, right];
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "version_conflict", operation: "rename" },
    });
    expect((await target.get({
      authorizationContext: "allow",
      conversationId: id("atomic"),
    })).descriptor.version).toBe(2);
  });

  it("validates required collaborators and bounded configuration", () => {
    expect(() => new InMemoryConversationCatalog({
      authorize: undefined as never,
    })).toThrow(TypeError);
    for (const limits of [
      { maxRecords: 0 },
      { maxTombstones: -1 },
      { maxIdempotencyEntries: 1.5 },
      { maxRecords: 1_000_001 },
      { unknownLimit: 1 },
    ]) {
      expect(() => catalog({
        limits: limits as Partial<InMemoryConversationCatalogLimits>,
      })).toThrow(TypeError);
    }
  });
});
