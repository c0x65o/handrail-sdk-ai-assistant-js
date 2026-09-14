// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StandardGatewayApprovals } from "../src/react-styled/index.js";
import type { ConversationApprovalProposalRecord } from "../src/conversation/state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function proposal(id: string): ConversationApprovalProposalRecord {
  return { proposal_id: id, group_id: "a", tool_name: id, status: "pending", proposal_version: 1,
    reviewed_arguments: { type: "redacted_json", value: {} }, expires_at: "2099-01-01T00:00:00.000Z" } as never;
}
function setup(resources: {
  listApprovalGroup: (input: { groupId: string }) => Promise<readonly ConversationApprovalProposalRecord[]>;
  transitionApproval?: (input: unknown) => Promise<unknown>;
}) {
  let snapshot = { selectedConversationId: "a" as string | null, runningCount: 1, errorCount: 0,
    unreadCount: 0, threads: [] };
  const listeners = new Set<() => void>();
  const workspace = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => listeners.delete(listener);
  } };
  const client = { workspace, resources };
  return { client, select(selectedConversationId: string | null) {
    act(() => { snapshot = { ...snapshot, selectedConversationId }; listeners.forEach((listener) => listener()); });
  } };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("standard approval navigation and polling", () => {
  it.each(["success", "failure"])("ignores a delayed %s from the previous thread", async (outcome) => {
    const first = deferred<readonly ConversationApprovalProposalRecord[]>();
    const second = deferred<readonly ConversationApprovalProposalRecord[]>();
    const { client, select } = setup({ listApprovalGroup: ({ groupId }) => groupId === "a" ? first.promise : second.promise });
    render(<StandardGatewayApprovals client={client as never}/>);
    select("b");
    await act(async () => { second.resolve([proposal("new action")]); });
    expect(screen.getByText("New action")).toBeTruthy();
    await act(async () => {
      if (outcome === "success") first.resolve([proposal("old action")]);
      else first.reject(new Error("Old thread unavailable"));
    });
    expect(screen.queryByText("Old action")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("New action")).toBeTruthy();
    select(null);
    expect(screen.queryByRole("region", { name: "Assistant approvals" })).toBeNull();
  });

  it.each(["success", "failure"])("keeps a previous thread's delayed decision %s out of the current thread", async (outcome) => {
    const decision = deferred<unknown>();
    const transitionApproval = vi.fn(() => decision.promise);
    const { client, select } = setup({
      listApprovalGroup: async ({ groupId }) => [proposal(groupId === "a" ? "old action" : "new action")],
      transitionApproval,
    });
    render(<StandardGatewayApprovals client={client as never}/>);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    select("b");
    expect(screen.queryByText("Old action")).toBeNull();
    await act(async () => {});
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      if (outcome === "success") decision.resolve({}); else decision.reject(new Error("Old decision failed"));
    });
    expect(screen.getByText("New action")).toBeTruthy();
    expect(screen.queryByText("Old action")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(transitionApproval).toHaveBeenCalledOnce();
    expect(transitionApproval).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "a", proposalId: "old action" }));
  });

  it("serializes slow reads and discards a pending snapshot that predates confirmation", async () => {
    vi.useFakeTimers();
    const stale = deferred<readonly ConversationApprovalProposalRecord[]>();
    const refreshed = deferred<readonly ConversationApprovalProposalRecord[]>();
    const decision = deferred<unknown>();
    const listApprovalGroup = vi.fn()
      .mockResolvedValueOnce([proposal("update account")])
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => refreshed.promise);
    const transitionApproval = vi.fn(() => decision.promise);
    const { client } = setup({ listApprovalGroup, transitionApproval });
    const view = render(<StandardGatewayApprovals client={client as never}/>);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listApprovalGroup).toHaveBeenCalledTimes(2);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(transitionApproval).toHaveBeenCalledOnce();
    await act(async () => { decision.resolve({}); });
    expect(screen.queryByText("Update account")).toBeNull();
    expect(listApprovalGroup).toHaveBeenCalledTimes(2);
    await act(async () => { stale.resolve([proposal("update account")]); });
    expect(screen.queryByText("Update account")).toBeNull();
    expect(listApprovalGroup).toHaveBeenCalledTimes(3);
    await act(async () => { refreshed.resolve([]); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listApprovalGroup).toHaveBeenCalledTimes(3);
  });

  it("clears approvals when resources change even if the selected conversation ID is unchanged", async () => {
    const oldRead = deferred<readonly ConversationApprovalProposalRecord[]>();
    const nextRead = deferred<readonly ConversationApprovalProposalRecord[]>();
    const { client } = setup({ listApprovalGroup: () => oldRead.promise });
    const view = render(<StandardGatewayApprovals client={client as never}/>);
    view.rerender(<StandardGatewayApprovals client={{ ...client,
      resources: { listApprovalGroup: () => nextRead.promise } } as never}/>);
    await act(async () => { nextRead.resolve([proposal("authorized action")]); });
    await act(async () => { oldRead.resolve([proposal("previous account action")]); });
    expect(screen.getByText("Authorized action")).toBeTruthy();
    expect(screen.queryByText("Previous account action")).toBeNull();
  });
});
