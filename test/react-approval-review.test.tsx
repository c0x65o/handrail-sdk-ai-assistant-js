/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApprovalDecisionResult,
  ConversationApprovalArgumentReference,
  ConversationApprovalGroupId,
  ConversationApprovalProposalId,
  ConversationApprovalProposalRecord,
  ConversationEventAttribution,
  ConversationId,
  ConversationTimestamp,
  ConversationToolCallId,
  ConversationTurnId,
  DecideApprovalInput,
} from "../src/index.js";
import {
  ApprovalReviewGroup,
  ApprovalReviewItem,
  ApprovalReviewList,
  ApprovalReviewRoot,
  useApprovalReview,
  type ApprovalReviewController,
  type ApprovalReviewDecisionHandler,
  type ApprovalReviewDecisionIdentityFactory,
  type ApprovalReviewProposalLoader,
  type ApprovalReviewProposalSubscription,
  type UseApprovalReviewOptions,
} from "../src/react/index.js";

afterEach(() => cleanup());

interface PermissionContext {
  readonly subject: string;
}

const conversationId = "conversation-review" as ConversationId;
const permissionContext = Object.freeze({ subject: "reviewer" });
const attribution = Object.freeze({
  actor: { type: "user", id: "reviewer" },
  source: { type: "client", client_id: "review-client" },
}) as unknown as ConversationEventAttribution;
const stableNow = () => "2026-08-29T12:00:00.000Z" as ConversationTimestamp;

function proposal(
  id: string,
  options: {
    readonly groupId?: string | null;
    readonly status?: ConversationApprovalProposalRecord["status"];
    readonly version?: number;
    readonly expiresAt?: string;
    readonly reviewedArguments?: ConversationApprovalProposalRecord["reviewed_arguments"];
  } = {},
): ConversationApprovalProposalRecord {
  return Object.freeze({
    proposal_id: id as ConversationApprovalProposalId,
    group_id: options.groupId === undefined || options.groupId === null
      ? null
      : options.groupId as ConversationApprovalGroupId,
    turn_id: `turn-${id}` as ConversationTurnId,
    tool_call_id: `call-${id}` as ConversationToolCallId,
    tool_name: `tool_${id}`,
    reviewed_arguments: options.reviewedArguments ?? Object.freeze({
      type: "redacted_json" as const,
      value: Object.freeze({ visible: `[redacted-${id}]` }),
    }),
    status: options.status ?? "pending",
    proposal_version: options.version ?? 1,
    expires_at: (options.expiresAt ?? "2099-08-29T13:00:00.000Z") as
      ConversationTimestamp,
    created_at: "2026-08-29T10:00:00.000Z" as ConversationTimestamp,
    updated_at: "2026-08-29T11:00:00.000Z" as ConversationTimestamp,
    created_attribution: attribution,
    latest_attribution: attribution,
    decision_at: null,
    decision_attribution: null,
    decision_reason: null,
    failure_reason: null,
  });
}

function accepted(
  row: ConversationApprovalProposalRecord,
  decision: "confirmed" | "rejected" = "confirmed",
): ApprovalDecisionResult {
  return {
    outcome: "accepted",
    decision,
    proposalId: row.proposal_id,
    authorizedVersion: row.proposal_version,
    proposalVersion: row.proposal_version + 1,
    eventId: `event-${row.proposal_id}` as never,
    eventRevision: 1 as never,
    eventStatus: "appended",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let latestController: ApprovalReviewController;

function Harness(
  props: UseApprovalReviewOptions<PermissionContext> & {
    readonly children?: (controller: ApprovalReviewController) => ReactNode;
  },
) {
  const { children, ...options } = props;
  const controller = useApprovalReview(options);
  latestController = controller;
  return (
    <ApprovalReviewRoot controller={controller} aria-label="Approval review">
      {children?.(controller) ?? <ApprovalReviewList />}
    </ApprovalReviewRoot>
  );
}

function identities(): ApprovalReviewDecisionIdentityFactory {
  return vi.fn((request) => ({
    idempotencyKey:
      `key:${request.proposalId}:${request.proposalVersion}:${request.decision}`,
    idempotencyFingerprint:
      `fingerprint:${request.proposalId}:${request.proposalVersion}:${request.decision}`,
  }));
}

function options(
  rows: readonly ConversationApprovalProposalRecord[],
  decisionHandler: ApprovalReviewDecisionHandler<PermissionContext> =
    vi.fn(async (input) => accepted(
      rows.find((row) => row.proposal_id === input.proposalId) ?? rows[0]!,
      input.decision === "confirm" ? "confirmed" : "rejected",
    )),
  overrides: Partial<UseApprovalReviewOptions<PermissionContext>> = {},
): UseApprovalReviewOptions<PermissionContext> {
  return {
    attribution,
    conversationId,
    createDecisionIdentity: identities(),
    decisionHandler,
    initialProposals: rows,
    loadProposals: vi.fn(async () => rows),
    now: stableNow,
    permissionContext,
    ...overrides,
  };
}

describe("ApprovalReview primitives", () => {
  it("renders deterministic grouped order, persisted safe review data, and accessible semantics", async () => {
    const opaque = proposal("z-single", {
      reviewedArguments: {
        type: "opaque_reference",
        argument_ref: "opaque:arguments:z" as ConversationApprovalArgumentReference,
      },
    });
    const safe = proposal("b-item", { groupId: "group-b" });
    const first = proposal("a-item", { groupId: "group-a" });
    const second = proposal("c-item", { groupId: "group-a" });
    const unsafeRuntimeRow = {
      ...safe,
      raw_arguments: { secret: "DO-NOT-RENDER" },
      provider_payload: "PROVIDER-INTERNAL",
    } as ConversationApprovalProposalRecord;
    const decisionHandler = vi.fn(async () => accepted(first));

    render(<Harness {...options([opaque, unsafeRuntimeRow, second, first], decisionHandler)} />);
    const list = screen.getByRole("list", { name: "Approval proposals" });
    await waitFor(() => expect(within(list).getAllByRole("group")).toHaveLength(3));
    expect(within(list).getAllByRole("group").map((group) =>
      group.getAttribute("aria-label"))).toEqual([
      "Approval group group-a",
      "Approval group group-b",
      "Approval z-single",
    ]);
    expect(within(screen.getByRole("group", { name: "Approval group group-a" }))
      .getAllByRole("listitem").map((item) =>
        item.getAttribute("data-approval-proposal-id"))).toEqual(["a-item", "c-item"]);
    expect(screen.getByLabelText("Reviewed arguments for tool_b-item").textContent)
      .toBe('Visible[redacted-b-item]');
    expect(screen.getByText("opaque:arguments:z")).toBeTruthy();
    expect(document.body.textContent).not.toContain("DO-NOT-RENDER");
    expect(document.body.textContent).not.toContain("PROVIDER-INTERNAL");
    expect(screen.getByRole("button", { name: "Confirm tool_a-item" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject tool_a-item" })).toBeTruthy();
    expect(screen.getByRole("status", {
      name: "Approval status for tool_a-item: pending",
    })).toBeTruthy();
    expect(decisionHandler).not.toHaveBeenCalled();
  });

  it("submits exact confirm and reject inputs only after explicit activation", async () => {
    const confirmRow = proposal("confirm-me");
    const rejectRow = proposal("reject-me");
    const handler = vi.fn<ApprovalReviewDecisionHandler<PermissionContext>>(async (input) =>
      accepted(input.proposalId === confirmRow.proposal_id ? confirmRow : rejectRow,
        input.decision === "confirm" ? "confirmed" : "rejected"));
    const createDecisionIdentity = identities();
    render(<Harness {...options([rejectRow, confirmRow], handler, { createDecisionIdentity })} />);
    await waitFor(() => expect(screen.queryByText("Loading approval proposals…")).toBeNull());
    expect(handler).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole("button", { name: "Confirm tool_confirm-me" });
    expect(confirmButton.tagName).toBe("BUTTON");
    expect(confirmButton.getAttribute("type")).toBe("button");
    confirmButton.focus();
    fireEvent.keyDown(confirmButton, { key: "Enter" });
    fireEvent.click(confirmButton, { detail: 0 });
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirm tool_reject-me" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Reject tool_reject-me" }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    const confirmInput = handler.mock.calls[0]?.[0];
    expect(confirmInput).toEqual({
      permissionContext,
      conversationId,
      proposalId: confirmRow.proposal_id,
      expectedVersion: 1,
      decision: "confirm",
      attribution,
      idempotencyKey: "key:confirm-me:1:confirm",
      idempotencyFingerprint: "fingerprint:confirm-me:1:confirm",
      signal: expect.any(AbortSignal),
    });
    expect(handler.mock.calls[1]?.[0]).toMatchObject({
      permissionContext,
      conversationId,
      proposalId: rejectRow.proposal_id,
      expectedVersion: 1,
      decision: "reject",
      attribution,
      idempotencyKey: "key:reject-me:1:reject",
      idempotencyFingerprint: "fingerprint:reject-me:1:reject",
    });
    expect(createDecisionIdentity).toHaveBeenCalledTimes(2);
  });

  it("suppresses duplicate clicks while busy and reuses stable identity on retry", async () => {
    const row = proposal("busy");
    const pending = deferred<ApprovalDecisionResult>();
    const handler = vi.fn<ApprovalReviewDecisionHandler<PermissionContext>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        outcome: "persistence_failure",
        proposalId: row.proposal_id,
        retryable: true,
      })
      .mockResolvedValueOnce(accepted(row));
    const createDecisionIdentity = identities();
    render(<Harness {...options([row], handler, { createDecisionIdentity })} />);
    const button = screen.getByRole("button", { name: "Confirm tool_busy" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    pending.resolve({
      outcome: "persistence_failure",
      proposalId: row.proposal_id,
      retryable: true,
    });
    await screen.findByRole("status", {
      name: "Approval status for tool_busy: Decision could not be persisted; retry available",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(createDecisionIdentity).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0]?.[0] as DecideApprovalInput<PermissionContext>)
      .idempotencyKey).toBe((handler.mock.calls[1]?.[0] as
        DecideApprovalInput<PermissionContext>).idempotencyKey);
  });

  it.each([
    ["version stale", { outcome: "conflict", conflict: "version" }, "Proposal version is stale"],
    ["idempotency conflict", { outcome: "conflict", conflict: "idempotency" },
      "Decision identity conflict"],
    ["event conflict", { outcome: "conflict", conflict: "event_identity" },
      "Decision conflict"],
    ["forbidden", { outcome: "forbidden" }, "Decision forbidden"],
    ["expired", { outcome: "expired", proposalVersion: 2 }, "Expired"],
    ["already decided", {
      outcome: "already_decided", proposalVersion: 2, currentStatus: "confirmed",
    }, "Already decided: confirmed"],
    ["invalid input", { outcome: "invalid_input", reason: "request" },
      "Invalid decision input"],
    ["not found", { outcome: "not_found" }, "Proposal not found"],
  ] as const)("maps %s coordinator results into bounded terminal UI state", async (
    _name,
    partial,
    message,
  ) => {
    const row = proposal("mapped");
    const handler = vi.fn(async () => ({
      ...partial,
      proposalId: row.proposal_id,
    } as ApprovalDecisionResult));
    const view = render(<Harness {...options([row], handler)} />);
    const button = screen.getByRole("button", { name: "Confirm tool_mapped" });
    fireEvent.click(button);
    await screen.findByRole("status", {
      name: `Approval status for tool_mapped: ${message}`,
    });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reject tool_mapped" })
      .hasAttribute("disabled")).toBe(true);
    view.unmount();
  });

  it("maps cancellation into an explicitly retryable UI state", async () => {
    const row = proposal("cancelled");
    const handler = vi.fn(async () => ({
      outcome: "cancelled" as const,
      proposalId: row.proposal_id,
    }));
    render(<Harness {...options([row], handler)} />);
    const button = screen.getByRole("button", { name: "Confirm tool_cancelled" });
    fireEvent.click(button);
    await screen.findByRole("status", {
      name: "Approval status for tool_cancelled: Decision cancelled",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("disables expired and non-pending restart-loaded proposals", () => {
    render(<Harness {...options([
      proposal("expired-local", { expiresAt: "2026-08-29T11:59:59.000Z" }),
      proposal("confirmed", { status: "confirmed", version: 2 }),
      proposal("executed", { status: "executed", version: 4 }),
    ])} />);
    for (const name of [
      "Confirm tool_expired-local",
      "Reject tool_expired-local",
      "Confirm tool_confirmed",
      "Reject tool_confirmed",
      "Confirm tool_executed",
      "Reject tool_executed",
    ]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("aborts pending decisions on unmount and ignores stale completions after refresh", async () => {
    const first = proposal("changing", { version: 1 });
    const next = proposal("changing", { version: 2 });
    const pending = deferred<ApprovalDecisionResult>();
    const pendingAfterRefresh = deferred<ApprovalDecisionResult>();
    let decisionSignal: AbortSignal | undefined;
    const handler = vi.fn<ApprovalReviewDecisionHandler<PermissionContext>>()
      .mockImplementationOnce((input) => {
        decisionSignal = input.signal;
        return pending.promise;
      })
      .mockImplementationOnce(() => pendingAfterRefresh.promise);
    const load = vi.fn<ApprovalReviewProposalLoader<PermissionContext>>()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([next]);
    const onDecisionResult = vi.fn();
    const view = render(<Harness {...options([first], handler, {
      loadProposals: load,
      onDecisionResult,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm tool_changing" }));
    await waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await act(async () => latestController.refresh());
    expect(decisionSignal?.aborted).toBe(true);
    pending.resolve(accepted(first));
    await act(async () => undefined);
    expect(onDecisionResult).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm tool_changing" })
      .hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Confirm tool_changing" }));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(handler.mock.calls[1]?.[0].signal.aborted).toBe(true);
  });

  it("loads restart-persisted rows and refreshes from a host subscription without decisions", async () => {
    const restarted = proposal("restart", { groupId: "durable" });
    const updated = proposal("subscription", { groupId: "durable" });
    const load = vi.fn<ApprovalReviewProposalLoader<PermissionContext>>()
      .mockResolvedValueOnce([restarted])
      .mockResolvedValueOnce([restarted, updated]);
    const handler = vi.fn(async () => accepted(restarted));
    let notify: (() => void) | undefined;
    let subscriptionSignal: AbortSignal | undefined;
    const subscribe = vi.fn<ApprovalReviewProposalSubscription<PermissionContext>>((input) => {
      notify = input.refresh;
      subscriptionSignal = input.signal;
      return vi.fn();
    });
    const view = render(<Harness {...options([restarted], handler, {
      loadProposals: load,
      subscribe,
    })} />);
    expect(screen.getByText("Tool restart")).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    act(() => notify?.());
    await screen.findByText("Tool subscription");
    expect(load).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    view.unmount();
    expect(subscriptionSignal?.aborted).toBe(true);
  });

  it("supports render overrides and server rendering without loading or deciding", () => {
    const row = proposal("server");
    const load = vi.fn(async () => [row]);
    const handler = vi.fn(async () => accepted(row));
    const markup = renderToString(
      <Harness {...options([row], handler, { loadProposals: load })}>
        {(controller) => (
          <ApprovalReviewList
            controller={controller}
            render={(props, ref) => <main {...props} ref={ref}>
              {props.children}
              <span>custom list</span>
            </main>}
          />
        )}
      </Harness>,
    );
    expect(markup).toContain("custom list");
    expect(markup).toContain("tool_server");
    expect(markup).toContain("[redacted-server]");
    expect(markup).toContain("data-approval-review-root");
    expect(load).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    render(<Harness {...options([row], handler)}>
      {() => (
        <ApprovalReviewGroup
          group={{ key: "custom", groupId: null, proposals: [row] }}
          render={(props, ref) => <article {...props} ref={ref} />}
          renderItem={(item) => (
            <ApprovalReviewItem
              proposal={item}
              render={(props, ref) => <li {...props} ref={ref}>custom item</li>}
            />
          )}
        />
      )}
    </Harness>);
    expect(screen.getByRole("group", { name: "Approval server" }).tagName).toBe("ARTICLE");
    expect(screen.getByText("custom item")).toBeTruthy();
  });
});
