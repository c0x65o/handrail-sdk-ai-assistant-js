import { describe, expect, it, vi } from "vitest";

import {
  ConversationEventStoreConflictError,
  ConversationEventStoreUnavailableError,
  InMemoryApprovalProposalStore,
  InMemoryConversationEventStore,
  createApprovalCoordinator,
  parseConversationEvent,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type ApprovalDecision,
  type ApprovalProposalStore,
  type ConversationApprovalGroupId,
  type ConversationApprovalProposalId,
  type ConversationEventAttribution,
  type ConversationEventStore,
  type ConversationId,
  type ConversationRevision,
  type ConversationTimestamp,
  type ReadConversationEventsInput,
  type ReadConversationEventsResult,
} from "../src/index.js";

const conversationId = "conversation-approval" as ConversationId;
const userAttribution = {
  actor: { type: "user", id: "reviewer" },
  source: { type: "client", client_id: "approval-client" },
} as unknown as ConversationEventAttribution;
const systemAttribution = {
  actor: { type: "system", id: "approval-host" },
  source: { type: "runtime" },
} as unknown as ConversationEventAttribution;

describe("ApprovalCoordinator", () => {
  it("confirms and rejects exact persisted versions without executing tools", async () => {
    const fixture = createFixture();
    await fixture.create("confirm-me");
    await fixture.create("reject-me");
    const confirmed = await fixture.coordinator.decide(
      decisionInput("confirm-me", "confirm", "confirm-key"),
    );
    const rejected = await fixture.coordinator.decide({
      ...decisionInput("reject-me", "reject", "reject-key"),
      decisionReason: "The reviewer declined.",
    });

    expect(confirmed).toMatchObject({
      outcome: "accepted",
      decision: "confirmed",
      authorizedVersion: 1,
      proposalVersion: 2,
    });
    expect(rejected).toMatchObject({
      outcome: "accepted",
      decision: "rejected",
      authorizedVersion: 1,
      proposalVersion: 2,
    });
    expect((await fixture.get("confirm-me")).status).toBe("confirmed");
    expect((await fixture.get("reject-me")).status).toBe("rejected");
    const events = await fixture.events.read({ conversationId });
    expect(events.entries.map(({ event }) => event.payload)).toEqual([
      {
        type: "approval.proposal_status_changed",
        proposal_id: "confirm-me",
        proposal_version: 2,
        status: "confirmed",
      },
      {
        type: "approval.proposal_status_changed",
        proposal_id: "reject-me",
        proposal_version: 2,
        status: "rejected",
        decision_reason: "The reviewer declined.",
      },
    ]);
  });

  it.each(["executing", "executed", "failed"] as const)("retains a host execution outcome of %s without inventing another decision event", async (status) => {
    const fixture = createFixture();
    await fixture.create("host-action");
    const pending = await fixture.get("host-action");
    const coordinator = createApprovalCoordinator({
      proposalStore: {
        create: fixture.proposals.create.bind(fixture.proposals),
        get: fixture.proposals.get.bind(fixture.proposals),
        listGroup: fixture.proposals.listGroup.bind(fixture.proposals),
        transition: async () => ({ ...pending, status, proposal_version: 4 }),
      },
      eventStore: fixture.events,
      authorize: () => "allow",
    });
    const result = await coordinator.decide(decisionInput("host-action", "confirm", "host-key"));
    expect(result).toEqual({ outcome: "already_decided", proposalId: "host-action", proposalVersion: 4, currentStatus: status });
    expect((await fixture.events.read({ conversationId })).entries).toEqual([]);
  });

  it("expires a due proposal through the optimistic transition and appends its event", async () => {
    const fixture = createFixture();
    await fixture.create("expire-me");
    fixture.clock.set("2026-08-29T13:00:00.000Z");

    const result = await fixture.coordinator.decide({
      ...decisionInput("expire-me", "expire", "expire-key"),
      attribution: systemAttribution,
    });

    expect(result).toMatchObject({
      outcome: "accepted",
      decision: "expired",
      authorizedVersion: 1,
      proposalVersion: 2,
    });
    expect((await fixture.get("expire-me")).status).toBe("expired");
  });

  it("returns the stable result for duplicate requests and rejects idempotency misuse", async () => {
    const fixture = createFixture();
    await fixture.create("duplicate");
    const request = decisionInput("duplicate", "confirm", "duplicate-key");

    const first = await fixture.coordinator.decide(request);
    const duplicate = await fixture.coordinator.decide(request);
    const misuse = await fixture.coordinator.decide({
      ...request,
      idempotencyFingerprint: "different-fingerprint",
    });

    expect(first).toMatchObject({ outcome: "accepted", eventRevision: 1 });
    expect(duplicate).toMatchObject({
      outcome: "accepted",
      eventRevision: 1,
      eventStatus: "reconciled",
    });
    expect(misuse).toEqual({
      outcome: "conflict",
      proposalId: "duplicate",
      conflict: "idempotency",
    });
    expect((await fixture.events.read({ conversationId })).entries).toHaveLength(1);
  });

  it("reconciles the same decision after storage reorders JSON object keys", async () => {
    const fixture = createFixture();
    await fixture.create("jsonb-replay");
    const request = decisionInput("jsonb-replay", "confirm", "jsonb-replay-key");
    expect(await fixture.coordinator.decide(request)).toMatchObject({ outcome: "accepted" });
    const read = fixture.events.read.bind(fixture.events);
    vi.spyOn(fixture.events, "read").mockImplementation(async input =>
      JSON.parse(JSON.stringify(await read(input), (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? 1 : -1)) : value)));
    expect(await fixture.coordinator.decide(request)).toMatchObject({
      outcome: "accepted", eventRevision: 1, eventStatus: "reconciled",
    });
    expect((await read({ conversationId })).entries).toHaveLength(1);
    vi.mocked(fixture.events.read).mockImplementation(async input => {
      const result = await read(input);
      return { ...result, entries: result.entries.map(entry => ({ ...entry,
        event: parseConversationEvent({ ...entry.event, actor: { type: "user", id: "another-reviewer" } }),
      })) };
    });
    expect(await fixture.coordinator.decide(request)).toMatchObject({ outcome: "conflict", conflict: "event_identity" });
  });

  it("normalizes optimistic races, already-decided proposals, and missing proposals", async () => {
    const fixture = createFixture();
    await fixture.create("raced");
    await fixture.proposals.transition({
      permissionContext: "allowed",
      proposalId: proposalId("raced"),
      expectedVersion: 1,
      status: "confirmed",
      attribution: userAttribution,
      idempotencyKey: "outside-confirm",
      idempotencyFingerprint: "outside-confirm-fingerprint",
    });
    await fixture.create("pending-race");

    await expect(
      fixture.coordinator.decide(decisionInput("raced", "reject", "late-reject")),
    ).resolves.toEqual({
      outcome: "already_decided",
      proposalId: "raced",
      proposalVersion: 2,
      currentStatus: "confirmed",
    });
    await expect(
      fixture.coordinator.decide({
        ...decisionInput("pending-race", "confirm", "stale-version"),
        expectedVersion: 2,
      }),
    ).resolves.toEqual({
      outcome: "conflict",
      proposalId: "pending-race",
      conflict: "version",
    });
    await expect(
      fixture.coordinator.decide(decisionInput("missing", "confirm", "missing-key")),
    ).resolves.toEqual({ outcome: "not_found", proposalId: "missing" });
  });

  it("keeps the host decision hook separate from proposal-store authorization", async () => {
    const fixture = createFixture({ authorizeDecision: () => "deny" });
    await fixture.create("host-denied");

    await expect(
      fixture.coordinator.decide(
        decisionInput("host-denied", "confirm", "host-denied-key"),
      ),
    ).resolves.toEqual({ outcome: "forbidden", proposalId: "host-denied" });
    expect((await fixture.get("host-denied")).status).toBe("pending");

    const storeDenied = createFixture({ authorizeStore: () => "deny" });
    await expect(
      storeDenied.coordinator.decide(
        decisionInput("unknown", "confirm", "store-denied-key"),
      ),
    ).resolves.toEqual({ outcome: "forbidden", proposalId: "unknown" });
  });

  it("decides complete persisted groups in deterministic order and reports partial races", async () => {
    const fixture = createFixture({ maxGroupSize: 2 });
    await fixture.create("group-b", "group-one");
    await fixture.create("group-a", "group-one");

    const result = await fixture.coordinator.decideGroup({
      permissionContext: "allowed",
      conversationId,
      groupId: groupId("group-one"),
      targets: [
        target("group-b", "group-b-key"),
        { ...target("group-a", "group-a-key"), expectedVersion: 2 },
      ],
      decision: "confirm",
      attribution: userAttribution,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("partial");
    if (result.outcome !== "partial") throw new Error("Expected partial group result");
    expect(result.results).toEqual([
      { outcome: "conflict", proposalId: "group-a", conflict: "version" },
      expect.objectContaining({ outcome: "accepted", proposalId: "group-b" }),
    ]);

    const boundedFixture = createFixture({ maxGroupSize: 1 });
    await boundedFixture.create("oversized-a", "oversized");
    await boundedFixture.create("oversized-b", "oversized");
    const bounded = await boundedFixture.coordinator.decideGroup({
      permissionContext: "allowed",
      conversationId,
      groupId: groupId("oversized"),
      targets: [target("oversized-a", "oversized-a-key")],
      decision: "reject",
      attribution: userAttribution,
      signal: new AbortController().signal,
    });
    expect(bounded).toEqual({
      outcome: "invalid_input",
      groupId: "oversized",
      reason: "group_bounds",
    });
    expect((await boundedFixture.get("oversized-a")).status).toBe("pending");
    expect((await boundedFixture.get("oversized-b")).status).toBe("pending");
  });

  it("propagates cancellation through an in-flight host permission hook", async () => {
    let observedSignal: AbortSignal | undefined;
    const fixture = createFixture({
      authorizeDecision: ({ signal }) => {
        observedSignal = signal;
        return new Promise<"allow">(() => undefined);
      },
    });
    await fixture.create("cancel-me");
    const controller = new AbortController();
    const pending = fixture.coordinator.decide({
      ...decisionInput("cancel-me", "confirm", "cancel-key"),
      signal: controller.signal,
    });
    controller.abort(new Error("private cancellation detail"));

    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      proposalId: "cancel-me",
    });
    expect(observedSignal).toBe(controller.signal);
    expect((await fixture.get("cancel-me")).status).toBe("pending");
  });

  it("reconciles an append failure on retry with a recreated coordinator", async () => {
    const proposals = createProposalStore();
    const backingEvents = new InMemoryConversationEventStore();
    const flakyEvents = new FailOnceEventStore(backingEvents);
    await createProposal(proposals, "retry-append");
    const request = decisionInput("retry-append", "confirm", "retry-append-key");

    const firstCoordinator = coordinator(proposals, flakyEvents);
    await expect(firstCoordinator.decide(request)).resolves.toEqual({
      outcome: "persistence_failure",
      proposalId: "retry-append",
      retryable: true,
    });
    expect((await getProposal(proposals, "retry-append")).status).toBe("confirmed");
    expect((await backingEvents.read({ conversationId })).entries).toHaveLength(0);

    const recreated = coordinator(proposals, flakyEvents);
    const reconciled = await recreated.decide(request);
    expect(reconciled).toMatchObject({
      outcome: "accepted",
      decision: "confirmed",
      eventRevision: 1,
    });
    expect((await backingEvents.read({ conversationId })).entries).toHaveLength(1);

    const restartedAgain = coordinator(proposals, flakyEvents);
    await expect(restartedAgain.decide(request)).resolves.toMatchObject({
      outcome: "accepted",
      eventRevision: 1,
      eventStatus: "reconciled",
    });
  });

  it("retries bounded event revision races without repeating the proposal transition", async () => {
    const proposals = createProposalStore();
    const backingEvents = new InMemoryConversationEventStore();
    const racingEvents = new RevisionRaceEventStore(backingEvents);
    await createProposal(proposals, "revision-race");

    const result = await coordinator(proposals, racingEvents).decide(
      decisionInput("revision-race", "reject", "revision-race-key"),
    );

    expect(result).toMatchObject({
      outcome: "accepted",
      decision: "rejected",
      proposalVersion: 2,
      eventRevision: 2,
    });
    expect((await getProposal(proposals, "revision-race")).proposal_version).toBe(2);
  });

  it("never exposes reviewed arguments, host exceptions, or cancellation details", async () => {
    const sensitive = "bank-account-00001111";
    const hostDetail = "authorization backend leaked stack detail";
    const proposals = createProposalStore();
    await createProposal(proposals, "safe-error", undefined, sensitive);
    const events = new InMemoryConversationEventStore();
    const safeCoordinator = createApprovalCoordinator({
      proposalStore: proposals,
      eventStore: events,
      authorize: () => {
        throw new Error(hostDetail);
      },
    });

    const result = await safeCoordinator.decide(
      decisionInput("safe-error", "confirm", "safe-error-key"),
    );
    const serialized = JSON.stringify(result);
    expect(result).toEqual({ outcome: "forbidden", proposalId: "safe-error" });
    expect(serialized).not.toContain(sensitive);
    expect(serialized).not.toContain(hostDetail);
    expect(serialized).not.toContain("arguments");
  });
});

function createFixture(options: {
  authorizeDecision?: Parameters<typeof createApprovalCoordinator<string>>[0]["authorize"];
  authorizeStore?: ConstructorParameters<typeof InMemoryApprovalProposalStore<string>>[0]["authorize"];
  maxGroupSize?: number;
} = {}) {
  const clock = mutableClock();
  const proposals = createProposalStore(clock, options.authorizeStore);
  const events = new InMemoryConversationEventStore();
  return {
    clock,
    proposals,
    events,
    coordinator: createApprovalCoordinator({
      proposalStore: proposals,
      eventStore: events,
      authorize: options.authorizeDecision ?? (() => "allow"),
      ...(options.maxGroupSize === undefined
        ? {}
        : { limits: { maxGroupSize: options.maxGroupSize } }),
    }),
    create: (id: string, group?: string) => createProposal(proposals, id, group),
    get: (id: string) => getProposal(proposals, id),
  };
}

function coordinator(
  proposals: ApprovalProposalStore<string>,
  events: ConversationEventStore,
) {
  return createApprovalCoordinator({
    proposalStore: proposals,
    eventStore: events,
    authorize: () => "allow",
  });
}

function createProposalStore(
  clock = mutableClock(),
  authorize: ConstructorParameters<typeof InMemoryApprovalProposalStore<string>>[0]["authorize"] =
    () => "allow",
) {
  return new InMemoryApprovalProposalStore<string>({ authorize, clock });
}

async function createProposal(
  store: ApprovalProposalStore<string>,
  id: string,
  group?: string,
  sensitive = "review-safe-summary",
) {
  return store.create({
    permissionContext: "allowed",
    proposalId: proposalId(id),
    ...(group === undefined ? {} : { groupId: groupId(group) }),
    turnId: "turn-approval" as never,
    toolCallId: `call-${id}` as never,
    toolName: "sensitive.tool",
    reviewedArguments: {
      type: "redacted_json",
      value: { private_value: sensitive },
    },
    expiresAt: "2026-08-29T13:00:00.000Z" as ConversationTimestamp,
    attribution: systemAttribution,
    idempotencyKey: `create-${id}`,
    idempotencyFingerprint: `create-${id}-fingerprint`,
  });
}

async function getProposal(store: ApprovalProposalStore<string>, id: string) {
  const proposal = await store.get({
    permissionContext: "allowed",
    proposalId: proposalId(id),
  });
  if (proposal === null) throw new Error("Expected proposal");
  return proposal;
}

function decisionInput(id: string, decision: ApprovalDecision, key: string) {
  return {
    permissionContext: "allowed",
    conversationId,
    proposalId: proposalId(id),
    expectedVersion: 1,
    decision,
    attribution: decision === "expire" ? systemAttribution : userAttribution,
    idempotencyKey: key,
    idempotencyFingerprint: `${key}-fingerprint`,
    signal: new AbortController().signal,
  } as const;
}

function target(id: string, key: string) {
  const input = decisionInput(id, "confirm", key);
  return {
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
  };
}

function proposalId(value: string): ConversationApprovalProposalId {
  return value as ConversationApprovalProposalId;
}

function groupId(value: string): ConversationApprovalGroupId {
  return value as ConversationApprovalGroupId;
}

function mutableClock() {
  let value = "2026-08-29T12:00:00.000Z" as ConversationTimestamp;
  return {
    now: () => value,
    set: (next: string) => {
      value = next as ConversationTimestamp;
    },
  };
}

class FailOnceEventStore implements ConversationEventStore {
  #failed = false;

  constructor(readonly backing: ConversationEventStore) {}

  append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    if (!this.#failed) {
      this.#failed = true;
      throw new ConversationEventStoreUnavailableError("append", "private detail");
    }
    return this.backing.append(input);
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.backing.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.backing.getLatestRevision(id);
  }
}

class RevisionRaceEventStore implements ConversationEventStore {
  #raced = false;

  constructor(readonly backing: ConversationEventStore) {}

  async append(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult> {
    if (!this.#raced) {
      this.#raced = true;
      const revision = ((input.expectedRevision ?? 0) + 1) as ConversationRevision;
      await this.backing.append({
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        events: [
          parseConversationEvent({
            version: 1,
            event_id: "competing-event",
            conversation_id: input.conversationId,
            revision,
            occurred_at: "2026-08-29T12:00:00.000Z",
            actor: { type: "user", id: "other-user" },
            source: { type: "client", client_id: "other-client" },
            mutation_id: "competing-mutation",
            payload: {
              type: "conversation.metadata_updated",
              metadata: { race: true },
            },
          }),
        ],
      });
      throw new ConversationEventStoreConflictError("private race detail", {
        code: "revision_conflict",
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        actualRevision: revision,
        identifier: null,
      });
    }
    return this.backing.append(input);
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.backing.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.backing.getLatestRevision(id);
  }
}
