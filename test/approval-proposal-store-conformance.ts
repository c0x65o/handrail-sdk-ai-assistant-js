import {
  CONVERSATION_EVENT_LIMITS,
  type ApprovalProposalPermissionCheck,
  type ApprovalProposalStore,
  type ApprovalProposalStoreLimits,
  type ConversationApprovalGroupId,
  type ConversationApprovalProposalId,
  type ConversationApprovalReviewedArguments,
  type ConversationEventAttribution,
  type ConversationTimestamp,
  type ConversationToolCallId,
  type ConversationTurnId,
  type CreateApprovalProposalInput,
} from "../src/index.js";

export interface ApprovalProposalStoreConformanceOptions {
  readonly now: () => ConversationTimestamp;
  readonly authorize: ApprovalProposalPermissionCheck<string>;
  readonly limits?: Partial<ApprovalProposalStoreLimits>;
}

export type ApprovalProposalStoreConformanceFactory = (
  options: ApprovalProposalStoreConformanceOptions,
) => ApprovalProposalStore<string>;

export interface ApprovalProposalStoreConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** Framework-neutral behavior shared by host ApprovalProposalStore adapters. */
export function approvalProposalStoreConformanceCases(
  createStore: ApprovalProposalStoreConformanceFactory,
): readonly ApprovalProposalStoreConformanceCase[] {
  return [
    {
      name: "creates, loads, and deterministically lists immutable group proposals",
      run: async () => {
        const clock = mutableClock();
        const store = allowedStore(createStore, clock);
        const mutableArguments = {
          nested: { approved: true as boolean },
          items: [1, 2],
        };
        const suppliedArguments = {
          type: "redacted_json",
          value: mutableArguments,
        } satisfies ConversationApprovalReviewedArguments;
        const suppliedAttribution = systemAttribution();

        await store.create(createInput("proposal-b", "create-b", {
          reviewedArguments: suppliedArguments,
          attribution: suppliedAttribution,
        }));
        await store.create(createInput("proposal-a", "create-a"));
        await store.create(createInput("proposal-c", "create-c", {
          groupId: groupId("another-group"),
        }));

        mutableArguments.nested.approved = false;
        mutableArguments.items.push(3);
        (suppliedAttribution.actor as { id?: string }).id = "mutated";

        const loaded = await store.get({
          permissionContext: "allow",
          proposalId: proposalId("proposal-b"),
        });
        assert(loaded !== null, "Created proposal must load.");
        deepEqual(loaded.reviewed_arguments, {
          type: "redacted_json",
          value: { nested: { approved: true }, items: [1, 2] },
        });
        equal(loaded.created_attribution.actor.id, "approval-host");
        assert(Object.isFrozen(loaded), "Returned proposal must be frozen.");
        assert(
          Object.isFrozen(loaded.reviewed_arguments),
          "Returned reviewed arguments must be frozen.",
        );
        if (loaded.reviewed_arguments.type === "redacted_json") {
          assert(
            Object.isFrozen(loaded.reviewed_arguments.value.nested),
            "Returned nested values must be frozen.",
          );
          let mutationRejected = false;
          try {
            Object.defineProperty(loaded.reviewed_arguments.value.nested, "approved", {
              value: false,
            });
          } catch {
            mutationRejected = true;
          }
          assert(mutationRejected, "Returned nested mutation must be rejected.");
        }

        const loadedAgain = await store.get({
          permissionContext: "allow",
          proposalId: proposalId("proposal-b"),
        });
        assert(loadedAgain !== null, "Created proposal must remain loadable.");
        deepEqual(loadedAgain.reviewed_arguments, {
          type: "redacted_json",
          value: { nested: { approved: true }, items: [1, 2] },
        });

        const listed = await store.listGroup({
          permissionContext: "allow",
          groupId: groupId("approval-group"),
        });
        deepEqual(
          listed.map((proposal) => proposal.proposal_id),
          ["proposal-a", "proposal-b"],
        );
        assert(Object.isFrozen(listed), "Group result must be frozen.");
      },
    },
    {
      name: "returns original immutable results for identical retries",
      run: async () => {
        const clock = mutableClock();
        const store = allowedStore(createStore, clock);
        const input = createInput("proposal-retry", "create-retry");
        const original = await store.create(input);
        await store.transition({
          ...transitionInput("proposal-retry", 1, "confirmed", "confirm-retry"),
          decisionReason: "Reviewed by the host.",
        });

        const createRetry = await store.create(input);
        equal(createRetry.status, "pending");
        equal(createRetry.proposal_version, 1);

        const transition = transitionInput(
          "proposal-retry",
          2,
          "executing",
          "execute-retry",
        );
        const firstTransition = await store.transition(transition);
        const transitionRetry = await store.transition(transition);
        deepEqual(transitionRetry, firstTransition);
        equal(transitionRetry.proposal_version, 3);
        assert(Object.isFrozen(transitionRetry), "Retry result must be frozen.");
        equal(original.status, "pending");
      },
    },
    {
      name: "snapshots nested input before awaiting host permission",
      run: async () => {
        let releaseAuthorization!: () => void;
        let markAuthorizationEntered!: () => void;
        const authorizationEntered = new Promise<void>((resolve) => {
          markAuthorizationEntered = resolve;
        });
        const authorizationGate = new Promise<void>((resolve) => {
          releaseAuthorization = resolve;
        });
        const store = createStore({
          now: mutableClock().now,
          authorize: async () => {
            markAuthorizationEntered();
            await authorizationGate;
            return "allow" as const;
          },
        });
        const mutableArguments = { nested: { value: "original" } };
        const mutableAttribution = systemAttribution();
        const pending = store.create(
          createInput("proposal-async-copy", "async-copy", {
            reviewedArguments: {
              type: "redacted_json",
              value: mutableArguments,
            },
            attribution: mutableAttribution,
          }),
        );

        await authorizationEntered;
        mutableArguments.nested.value = "mutated";
        (mutableAttribution.actor as { id?: string }).id = "mutated-host";
        releaseAuthorization();

        const created = await pending;
        deepEqual(created.reviewed_arguments, {
          type: "redacted_json",
          value: { nested: { value: "original" } },
        });
        equal(created.created_attribution.actor.id, "approval-host");
      },
    },
    {
      name: "rejects conflicting idempotency key reuse",
      run: async () => {
        const store = allowedStore(createStore, mutableClock());
        await store.create(createInput("proposal-key-first", "shared-key"));
        await rejectsWithCode(
          store.create(
            createInput("proposal-key-second", "shared-key", {
              fingerprint: "different-fingerprint",
            }),
          ),
          "idempotency_conflict",
        );
        equal(
          await store.get({
            permissionContext: "allow",
            proposalId: proposalId("proposal-key-second"),
          }),
          null,
        );
      },
    },
    {
      name: "rejects stale versions without mutation",
      run: async () => {
        const store = allowedStore(createStore, mutableClock());
        await store.create(createInput("proposal-stale", "create-stale"));
        await rejectsWithCode(
          store.transition(
            transitionInput("proposal-stale", 2, "confirmed", "stale-transition"),
          ),
          "version_conflict",
        );
        const loaded = await getRequired(store, "proposal-stale");
        equal(loaded.status, "pending");
        equal(loaded.proposal_version, 1);
      },
    },
    {
      name: "enforces confirm, reject, expire, and illegal lifecycle edges",
      run: async () => {
        const clock = mutableClock();
        const store = allowedStore(createStore, clock);
        await Promise.all([
          store.create(createInput("proposal-confirm", "create-confirm")),
          store.create(createInput("proposal-reject", "create-reject")),
          store.create(createInput("proposal-expire", "create-expire")),
        ]);

        const confirmed = await store.transition({
          ...transitionInput("proposal-confirm", 1, "confirmed", "confirm"),
          decisionReason: "Approved.",
        });
        equal(confirmed.status, "confirmed");
        equal(confirmed.proposal_version, 2);
        const executing = await store.transition(
          transitionInput("proposal-confirm", 2, "executing", "execute"),
        );
        equal(executing.status, "executing");
        const failed = await store.transition(
          transitionInput("proposal-confirm", 3, "failed", "fail"),
        );
        equal(failed.failure_reason, "Execution failed safely.");
        await store.transition(
          transitionInput("proposal-confirm", 4, "executing", "retry-execute"),
        );
        const executed = await store.transition(
          transitionInput("proposal-confirm", 5, "executed", "executed"),
        );
        equal(executed.status, "executed");

        const rejected = await store.transition({
          ...transitionInput("proposal-reject", 1, "rejected", "reject"),
          decisionReason: "Declined.",
        });
        equal(rejected.status, "rejected");

        await rejectsWithCode(
          store.transition(
            transitionInput("proposal-expire", 1, "expired", "expire-early"),
          ),
          "invalid_transition",
        );
        clock.set("2026-08-29T13:00:00.000Z");
        await rejectsWithCode(store.transition(
          transitionInput("proposal-expire", 1, "expired", "expire-due")), "invalid_transition");

        await rejectsWithCode(
          store.transition(
            transitionInput("proposal-reject", 2, "confirmed", "illegal-edge"),
          ),
          "invalid_transition",
        );
      },
    },
    {
      name: "checks permission before disclosure or mutation without existence leakage",
      run: async () => {
        let allow = true;
        const checked: string[] = [];
        const clock = mutableClock();
        const store = createStore({
          now: clock.now,
          authorize: ({ operation, permissionContext }) => {
            checked.push(`${operation}:${permissionContext}`);
            return allow ? "allow" : "deny";
          },
        });
        await store.create(createInput("proposal-private", "create-private"));
        allow = false;

        const existingError = await capturedError(
          store.get({
            permissionContext: "denied",
            proposalId: proposalId("proposal-private"),
          }),
        );
        const missingError = await capturedError(
          store.get({
            permissionContext: "denied",
            proposalId: proposalId("proposal-missing"),
          }),
        );
        deepEqual(errorShape(existingError), errorShape(missingError));
        deepEqual(errorShape(existingError), {
          name: "ApprovalProposalStoreError",
          code: "permission_denied",
          message: "Approval proposal access is not permitted.",
        });

        await rejectsWithCode(
          store.transition(
            transitionInput("proposal-private", 1, "confirmed", "denied-transition", {
              permissionContext: "denied",
            }),
          ),
          "permission_denied",
        );
        allow = true;
        equal((await getRequired(store, "proposal-private")).status, "pending");
        assert(checked.includes("get:denied"), "Denied reads must call authorization.");
        assert(
          checked.includes("transition:denied"),
          "Denied transitions must call authorization.",
        );
      },
    },
    {
      name: "enforces proposal capacity while allowing retained retries",
      run: async () => {
        const store = allowedStore(createStore, mutableClock(), {
          maxProposals: 2,
        });
        const first = createInput("proposal-capacity-1", "capacity-1");
        await store.create(first);
        await store.create(createInput("proposal-capacity-2", "capacity-2"));
        equal((await store.create(first)).proposal_id, "proposal-capacity-1");
        await rejectsWithCode(
          store.create(createInput("proposal-capacity-3", "capacity-3")),
          "capacity_exceeded",
        );
      },
    },
    {
      name: "bounds retained idempotency records with deterministic oldest eviction",
      run: async () => {
        const store = allowedStore(createStore, mutableClock(), {
          maxProposals: 4,
          maxIdempotencyRecords: 2,
        });
        await store.create(createInput("proposal-retain-1", "retained-key"));
        await store.create(createInput("proposal-retain-2", "second-key"));
        await store.transition(
          transitionInput("proposal-retain-1", 1, "confirmed", "third-key"),
        );

        const reused = await store.create(
          createInput("proposal-retain-3", "retained-key", {
            fingerprint: "new-request-after-eviction",
          }),
        );
        equal(reused.proposal_id, "proposal-retain-3");
      },
    },
    {
      name: "rejects reviewed arguments outside durable event bounds",
      run: async () => {
        const store = allowedStore(createStore, mutableClock());
        await rejectsWithCode(
          store.create(
            createInput("proposal-large-json", "large-json", {
              reviewedArguments: {
                type: "redacted_json",
                value: {
                  oversized: "x".repeat(
                    CONVERSATION_EVENT_LIMITS.approvalSnapshotStringLength + 1,
                  ),
                },
              },
            }),
          ),
          "invalid_input",
        );
        await rejectsWithCode(
          store.create(
            createInput("proposal-large-ref", "large-ref", {
              reviewedArguments: {
                type: "opaque_reference",
                argument_ref: "a".repeat(
                  CONVERSATION_EVENT_LIMITS.approvalArgumentReferenceLength + 1,
                ) as never,
              },
            }),
          ),
          "invalid_input",
        );
      },
    },
    {
      name: "serializes concurrent transitions so exactly one version winner mutates",
      run: async () => {
        const store = allowedStore(createStore, mutableClock());
        await store.create(createInput("proposal-race", "create-race"));
        const outcomes = await Promise.allSettled([
          store.transition(
            transitionInput("proposal-race", 1, "confirmed", "race-confirm"),
          ),
          store.transition(
            transitionInput("proposal-race", 1, "rejected", "race-reject"),
          ),
        ]);
        equal(
          outcomes.filter((outcome) => outcome.status === "fulfilled").length,
          1,
        );
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        assert(rejected?.status === "rejected", "One transition must be rejected.");
        equal(errorCode(rejected.reason), "version_conflict");
        equal((await getRequired(store, "proposal-race")).proposal_version, 2);
      },
    },
    {
      name: "retains pending proposals indefinitely and accepts a later decision",
      run: async () => {
        const clock = mutableClock();
        const store = allowedStore(createStore, clock);
        await store.create(createInput("proposal-clock", "create-clock"));
        clock.set("2026-08-29T13:00:00.000Z");

        const pending = await getRequired(store, "proposal-clock");
        equal(pending.status, "pending");
        equal(pending.expires_at, null);
        equal(pending.proposal_version, 1);
        equal(pending.decision_at, null);
        clock.set("2036-08-29T13:00:00.000Z");
        const confirmed = await store.transition(transitionInput("proposal-clock", 1, "confirmed", "late-decision"));
        equal(confirmed.status, "confirmed");
        const executed = await store.transition(transitionInput("proposal-clock", 2, "executing", "late-execution"));
        equal(executed.status, "executing");
      },
    },
  ];
}

function allowedStore(
  createStore: ApprovalProposalStoreConformanceFactory,
  clock: ReturnType<typeof mutableClock>,
  limits?: Partial<ApprovalProposalStoreLimits>,
): ApprovalProposalStore<string> {
  return createStore({
    now: clock.now,
    authorize: () => "allow",
    ...(limits === undefined ? {} : { limits }),
  });
}

function mutableClock(initial = "2026-08-29T12:00:00.000Z") {
  let current = timestamp(initial);
  return {
    now: () => current,
    set(value: string) {
      current = timestamp(value);
    },
  };
}

interface CreateOverrides {
  readonly groupId?: ConversationApprovalGroupId;
  readonly reviewedArguments?: ConversationApprovalReviewedArguments;
  readonly attribution?: ConversationEventAttribution;
  readonly fingerprint?: string;
}

function createInput(
  proposal: string,
  key: string,
  overrides: CreateOverrides = {},
): CreateApprovalProposalInput<string> {
  return {
    permissionContext: "allow",
    proposalId: proposalId(proposal),
    groupId: overrides.groupId ?? groupId("approval-group"),
    turnId: "turn-approval" as ConversationTurnId,
    toolCallId: `tool-call-${proposal}` as ConversationToolCallId,
    toolName: "update_order",
    reviewedArguments: overrides.reviewedArguments ?? {
      type: "redacted_json",
      value: { order_id: "order-123", changes: { delivery: "Friday" } },
    },
    expiresAt: timestamp("2026-08-29T13:00:00.000Z"),
    attribution: overrides.attribution ?? systemAttribution(),
    idempotencyKey: key,
    idempotencyFingerprint: overrides.fingerprint ?? `fingerprint-${key}`,
  };
}

function transitionInput(
  proposal: string,
  expectedVersion: number,
  status: "confirmed" | "rejected" | "expired" | "executing" | "executed" | "failed",
  key: string,
  overrides: { readonly permissionContext?: string } = {},
) {
  return {
    permissionContext: overrides.permissionContext ?? "allow",
    proposalId: proposalId(proposal),
    expectedVersion,
    status,
    attribution: ["confirmed", "rejected"].includes(status)
      ? userAttribution()
      : systemAttribution(),
    idempotencyKey: key,
    idempotencyFingerprint: `fingerprint-${key}`,
    ...(status === "failed" ? { failureReason: "Execution failed safely." } : {}),
  } as const;
}

function systemAttribution(): ConversationEventAttribution {
  return {
    actor: { type: "system", id: "approval-host" as never },
    source: { type: "runtime" },
  };
}

function userAttribution(): ConversationEventAttribution {
  return {
    actor: { type: "user", id: "reviewer" as never },
    source: { type: "client", client_id: "approval-client" as never },
  };
}

async function getRequired(
  store: ApprovalProposalStore<string>,
  proposal: string,
) {
  const value = await store.get({
    permissionContext: "allow",
    proposalId: proposalId(proposal),
  });
  assert(value !== null, "Expected proposal to exist.");
  return value;
}

function timestamp(value: string): ConversationTimestamp {
  return value as ConversationTimestamp;
}

function proposalId(value: string): ConversationApprovalProposalId {
  return value as ConversationApprovalProposalId;
}

function groupId(value: string): ConversationApprovalGroupId {
  return value as ConversationApprovalGroupId;
}

async function capturedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await capturedError(promise);
  equal(errorCode(error), code);
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
}

function errorShape(error: unknown) {
  if (!(error instanceof Error)) return null;
  return {
    name: error.name,
    code: errorCode(error),
    message: error.message,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function deepEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}
