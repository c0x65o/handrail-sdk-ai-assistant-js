import { describe, expect, it, vi } from "vitest";

import {
  BoundedToolExecutor,
  InMemoryApprovalProposalStore,
  InMemoryConversationEventStore,
  InMemoryToolExecutionLedger,
  ToolRegistry,
  createApprovalCoordinator,
  createApprovalExecutionCoordinator,
  parseConversationEvent,
  type ApplicationToolExecutor,
  type ApprovalExecutionCoordinator,
  type ApprovalExecutionResume,
  type ApprovalProposalStore,
  type ConversationApprovalProposalId,
  type ConversationEventAttribution,
  type ConversationEventStore,
  type ConversationId,
  type ConversationTimestamp,
  type ToolDefinition,
} from "../src/index.js";

const conversationId = "conversation-approval-execution" as ConversationId;
const turnId = "turn-approval-execution" as never;
const toolCallId = "call-approval-execution" as never;
const systemAttribution = {
  actor: { type: "system", id: "trusted-tool-host" },
  source: { type: "runtime" },
} as unknown as ConversationEventAttribution;
const userAttribution = {
  actor: { type: "user", id: "reviewer" },
  source: { type: "client", client_id: "approval-review" },
} as unknown as ConversationEventAttribution;

interface Fixture {
  readonly proposals: ApprovalProposalStore<string>;
  readonly events: ConversationEventStore;
  readonly approval: ApprovalExecutionCoordinator<string>;
  readonly ledger: InMemoryToolExecutionLedger;
  readonly registry: ToolRegistry<ApplicationToolExecutor, undefined>;
  readonly discoveredTools: readonly ToolDefinition[];
  readonly invoke: ReturnType<typeof vi.fn<ApplicationToolExecutor>>;
  readonly clock: ReturnType<typeof mutableClock>;
}

function toolDefinition(): ToolDefinition {
  return {
    name: "sensitive.lookup",
    description: "A side-effecting test tool",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

async function fixture(
  options: {
    authorizeExecution?: () => "allow" | "deny";
    invoke?: ApplicationToolExecutor;
  } = {},
): Promise<Fixture> {
  const clock = mutableClock();
  const events = new InMemoryConversationEventStore();
  const proposals = new InMemoryApprovalProposalStore<string>({
    authorize: () => "allow",
    clock,
  });
  const invoke = vi.fn<ApplicationToolExecutor>(
    options.invoke ?? (async () => ({ ok: true })),
  );
  const registry = new ToolRegistry<ApplicationToolExecutor, undefined>();
  registry.register({ definition: toolDefinition(), executor: invoke });
  const approval = createApprovalExecutionCoordinator({
    proposalStore: proposals,
    eventStore: events,
    authorize: options.authorizeExecution ?? (() => "allow"),
    verifyArguments: ({ binding, reviewedArguments, arguments: arguments_, definition }) =>
      binding.type === "reviewed_arguments_digest" &&
        binding.digest === "digest-weather" &&
        JSON.stringify(definition) === JSON.stringify(toolDefinition()) &&
        reviewedArguments.type === "redacted_json" &&
        JSON.stringify(reviewedArguments.value) === JSON.stringify(arguments_)
        ? "match"
        : "mismatch",
  });
  return {
    proposals,
    events,
    approval,
    ledger: new InMemoryToolExecutionLedger(),
    registry,
    discoveredTools: registry.discover({ context: undefined }),
    invoke,
    clock,
  };
}

async function createProposal(f: Fixture, id = "proposal-execution") {
  const proposalId = id as ConversationApprovalProposalId;
  const proposal = await f.proposals.create({
    permissionContext: "allowed",
    proposalId,
    turnId,
    toolCallId,
    toolName: "sensitive.lookup",
    reviewedArguments: { type: "redacted_json", value: { query: "weather" } },
    expiresAt: "2026-08-29T13:00:00.000Z" as ConversationTimestamp,
    attribution: systemAttribution,
    idempotencyKey: `create-${id}`,
    idempotencyFingerprint: `create-${id}`,
  });
  const latest = await f.events.getLatestRevision(conversationId);
  await f.events.append({
    conversationId,
    expectedRevision: latest,
    events: [parseConversationEvent({
      version: 1,
      event_id: `approval-created:${id}`,
      conversation_id: conversationId,
      revision: (latest ?? 0) + 1,
      occurred_at: proposal.created_at,
      actor: systemAttribution.actor,
      source: systemAttribution.source,
      payload: {
        type: "approval.proposal_created",
        proposal_id: proposalId,
        turn_id: turnId,
        tool_call_id: toolCallId,
        tool_name: "sensitive.lookup",
        status: "pending",
        proposal_version: 1,
        expires_at: proposal.expires_at,
        reviewed_arguments: proposal.reviewed_arguments,
      },
    })],
  });
  return proposalId;
}

async function confirm(f: Fixture, proposalId: ConversationApprovalProposalId) {
  const coordinator = createApprovalCoordinator({
    proposalStore: f.proposals,
    eventStore: f.events,
    authorize: () => "allow",
  });
  const result = await coordinator.decide({
    permissionContext: "allowed",
    conversationId,
    proposalId,
    expectedVersion: 1,
    decision: "confirm",
    attribution: userAttribution,
    idempotencyKey: `confirm-${proposalId}`,
    idempotencyFingerprint: `confirm-${proposalId}`,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ outcome: "accepted", proposalVersion: 2 });
}

function resume(proposalId: ConversationApprovalProposalId): ApprovalExecutionResume<string> & {
  conversationId: ConversationId;
  turnId: typeof turnId;
} {
  return {
    permissionContext: "allowed",
    conversationId,
    turnId,
    proposalId,
    expectedProposalVersion: 2,
    executionId: `execute-${proposalId}`,
    argumentBinding: { type: "reviewed_arguments_digest", digest: "digest-weather" },
    attribution: systemAttribution,
  };
}

function executor(f: Fixture, ledger = f.ledger) {
  return new BoundedToolExecutor({
    registry: f.registry,
    policy: () => ({ outcome: "external_approval_required" }),
    approvalCoordinator: f.approval,
    ledger,
  });
}

function execute(
  f: Fixture,
  bounded: ReturnType<typeof executor>,
  approval?: ReturnType<typeof resume>,
  signal?: AbortSignal,
) {
  return bounded.executeDetailed({
    call: {
      tool_call_id: toolCallId,
      name: "sensitive.lookup",
      arguments: { query: "weather" },
    },
    discoveredTools: f.discoveredTools,
    applicationContext: undefined,
    ...(approval === undefined ? {} : { approval }),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("approval execution", () => {
  it("admits approval retries before claims and receipt reuse without granting confirmation", async () => {
    const f = await fixture();
    let allowed = true;
    const bounded = new BoundedToolExecutor({ registry: f.registry, ledger: f.ledger,
      policy: () => ({ outcome: "external_approval_required" }), approvalCoordinator: f.approval,
      admission: () => ({ outcome: allowed ? "allow" : "deny" }) });
    expect(await execute(f, bounded)).toMatchObject({ status: "external_approval_required" });
    expect(f.invoke).not.toHaveBeenCalled();
    const proposalId = await createProposal(f);
    await confirm(f, proposalId);
    const before = await f.proposals.get({ permissionContext: "allowed", proposalId });
    allowed = false;
    expect(await execute(f, bounded, resume(proposalId))).toMatchObject({ result: { is_error: true } });
    expect(await f.proposals.get({ permissionContext: "allowed", proposalId })).toEqual(before);
    expect(f.invoke).not.toHaveBeenCalled();
    allowed = true;
    const original = await execute(f, bounded, resume(proposalId));
    expect(original).toMatchObject({ result: { is_error: false } });
    const executed = await f.proposals.get({ permissionContext: "allowed", proposalId });
    allowed = false;
    expect(await execute(f, bounded, resume(proposalId))).toMatchObject({ result: { is_error: true } });
    expect(await f.proposals.get({ permissionContext: "allowed", proposalId })).toEqual(executed);
    allowed = true;
    expect(await execute(f, bounded, resume(proposalId))).toEqual(original);
    expect(f.invoke).toHaveBeenCalledOnce();
  });

  it("never executes pending, rejected, attempted expiry, tampered, or unauthorized proposals", async () => {
    const cases = [
      "pending",
      "rejected",
      "expired",
      "tampered",
      "tampered-version",
      "tampered-identity",
      "unauthorized",
    ] as const;
    for (const state of cases) {
      const f = await fixture({
        authorizeExecution: state === "unauthorized" ? () => "deny" : () => "allow",
      });
      const proposalId = await createProposal(f, `proposal-${state}`);
      if (state === "rejected" || state === "expired") {
        if (state === "expired") f.clock.set("2026-08-29T13:00:00.000Z");
        const coordinator = createApprovalCoordinator({
          proposalStore: f.proposals,
          eventStore: f.events,
          authorize: () => "allow",
        });
        await coordinator.decide({
          permissionContext: "allowed",
          conversationId,
          proposalId,
          expectedVersion: 1,
          decision: state === "rejected" ? "reject" : "expire",
          attribution: state === "rejected" ? userAttribution : systemAttribution,
          idempotencyKey: `${state}-${proposalId}`,
          idempotencyFingerprint: `${state}-${proposalId}`,
          signal: new AbortController().signal,
        });
      } else if (
        state === "tampered" || state === "tampered-version" ||
        state === "tampered-identity" || state === "unauthorized"
      ) {
        await confirm(f, proposalId);
      }
      const approval = resume(proposalId);
      const suppliedApproval = state === "tampered"
        ? { ...approval, argumentBinding: {
            type: "reviewed_arguments_digest" as const,
            digest: "digest-tampered",
          } }
        : state === "tampered-version"
          ? { ...approval, expectedProposalVersion: 99 }
          : state === "tampered-identity"
            ? { ...approval, turnId: "other-turn" as typeof turnId }
            : approval;
      const outcome = await execute(
        f,
        executor(f),
        suppliedApproval,
      );
      expect(f.invoke, state).not.toHaveBeenCalled();
      expect(outcome.status, state).toBe(
        (state === "pending" || state === "expired") ? "external_approval_required" : "completed",
      );
    }
  });

  it("executes one exact confirmed proposal once across concurrent retries and executor restart", async () => {
    const f = await fixture();
    const proposalId = await createProposal(f);
    await confirm(f, proposalId);
    const approval = resume(proposalId);
    const first = executor(f);
    const concurrent = executor(f);

    const [left, right] = await Promise.all([
      execute(f, first, approval),
      execute(f, concurrent, approval),
    ]);
    const restarted = await execute(f, executor(f), approval);

    expect(left).toMatchObject({ status: "completed", result: { is_error: false } });
    expect(right).toEqual(left);
    expect(restarted).toEqual(left);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect((await f.proposals.get({ permissionContext: "allowed", proposalId }))).toMatchObject({
      status: "executed",
      proposal_version: 4,
    });
    const audit = await f.events.read({ conversationId });
    expect(audit.entries.map(({ event }) => event.payload).filter((payload) =>
      payload.type === "approval.proposal_status_changed").map((payload) => payload.status))
      .toEqual(["confirmed", "executing", "executed"]);
  });

  it("reuses a host ledger result without invoking the registered tool", async () => {
    const f = await fixture();
    const proposalId = await createProposal(f, "proposal-ledger-reuse");
    await confirm(f, proposalId);
    const approval = resume(proposalId);
    const first = await execute(f, executor(f), approval);

    f.registry.unregister("sensitive.lookup");
    const replacement = vi.fn<ApplicationToolExecutor>(async () => {
      throw new Error("must not execute");
    });
    f.registry.register({ definition: toolDefinition(), executor: replacement });
    const currentDiscovery = f.registry.discover({ context: undefined });
    const restarted = new BoundedToolExecutor({
      registry: f.registry,
      policy: () => ({ outcome: "external_approval_required" }),
      approvalCoordinator: f.approval,
      ledger: f.ledger,
    });
    const reused = await restarted.executeDetailed({
      call: { tool_call_id: toolCallId, name: "sensitive.lookup", arguments: { query: "weather" } },
      discoveredTools: currentDiscovery,
      applicationContext: undefined,
      approval,
    });

    expect(reused).toEqual(first);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("performs no side effect when cancelled before a successful claim", async () => {
    const f = await fixture();
    const proposalId = await createProposal(f, "proposal-cancelled");
    await confirm(f, proposalId);
    const controller = new AbortController();
    controller.abort();

    const outcome = await execute(f, executor(f), resume(proposalId), controller.signal);

    expect(outcome).toMatchObject({ status: "completed", result: { is_error: true } });
    expect(f.invoke).not.toHaveBeenCalled();
    expect(await f.proposals.get({ permissionContext: "allowed", proposalId }))
      .toMatchObject({ status: "confirmed", proposal_version: 2 });
  });

  it("records a bounded failed lifecycle without sensitive host error details", async () => {
    const f = await fixture({ invoke: async () => {
      throw new Error("secret prompt credential provider-native detail");
    } });
    const proposalId = await createProposal(f, "proposal-failed");
    await confirm(f, proposalId);

    const outcome = await execute(f, executor(f), resume(proposalId));
    const proposal = await f.proposals.get({ permissionContext: "allowed", proposalId });
    const audit = await f.events.read({ conversationId });
    const serialized = JSON.stringify({ outcome, proposal, audit });

    expect(outcome).toMatchObject({
      status: "completed",
      result: { is_error: true, content: [{ text: "Tool execution failed." }] },
    });
    expect(proposal).toMatchObject({
      status: "failed",
      failure_reason: "tool_execution_failed",
    });
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("credential provider-native");
  });

  it("preserves allow and deny behavior when no external approval is requested", async () => {
    const f = await fixture();
    const allow = new BoundedToolExecutor({ registry: f.registry, policy: () => ({ outcome: "allow" }) });
    const deniedInvoke = vi.fn<ApplicationToolExecutor>(async () => "unused");
    const deniedRegistry = new ToolRegistry<ApplicationToolExecutor, undefined>();
    deniedRegistry.register({ definition: toolDefinition(), executor: deniedInvoke });
    const deny = new BoundedToolExecutor({ registry: deniedRegistry, policy: () => ({ outcome: "deny" }) });

    const allowed = await execute(f, allow);
    const denied = await deny.executeDetailed({
      call: { tool_call_id: "call-denied", name: "sensitive.lookup", arguments: { query: "weather" } },
      discoveredTools: deniedRegistry.discover({ context: undefined }),
      applicationContext: undefined,
    });

    expect(allowed).toMatchObject({ status: "completed", result: { is_error: false } });
    expect(denied).toMatchObject({ status: "completed", result: { is_error: true } });
    expect(deniedInvoke).not.toHaveBeenCalled();
  });
});

function mutableClock() {
  let value = "2026-08-29T12:00:00.000Z" as ConversationTimestamp;
  return {
    now: () => value,
    set: (next: string) => {
      value = next as ConversationTimestamp;
    },
  };
}
