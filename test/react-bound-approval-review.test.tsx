/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBoundApprovalReview } from "../src/react/use-bound-approval-review.js";
import type { ConversationApprovalProposalRecord } from "../src/conversation/state.js";

afterEach(cleanup);
const proposal = { proposal_id: "proposal", group_id: "group", proposal_version: 1,
  turn_id: "turn", tool_call_id: "call", tool_name: "write",
  reviewed_arguments: { type: "opaque_reference", argument_ref: "args-sha256-original" },
} as ConversationApprovalProposalRecord;

it("does not reload on polling object replacements and retries an explicit failed review", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ amount: 25 });
  const view = renderHook(({ version }) => useBoundApprovalReview({ scope: "alice", conversationId: "conversation", proposal: version, load }),
    { initialProps: { version: proposal } });
  await waitFor(() => expect(view.result.current.status).toBe("error"));
  view.rerender({ version: { ...proposal } });
  expect(load).toHaveBeenCalledTimes(1);
  act(() => view.result.current.retry());
  expect(view.result.current.review).toBeNull();
  await waitFor(() => expect(view.result.current.review).toEqual({ amount: 25 }));
  expect(load).toHaveBeenCalledTimes(2);
});

it.each(["account", "version", "reference"])("drops late review data and errors when %s changes", async change => {
  const pending: { signal: AbortSignal; resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const load = vi.fn((signal: AbortSignal) => new Promise<string>((resolve, reject) => pending.push({ signal, resolve, reject })));
  const onError = vi.fn();
  const view = renderHook(({ scope, version }) => useBoundApprovalReview({ scope, conversationId: "conversation", proposal: version, load, onError }),
    { initialProps: { scope: "alice", version: proposal } });
  view.rerender({ scope: change === "account" ? "bob" : "alice", version: change === "version" ? { ...proposal, proposal_version: 2 }
    : change === "reference" ? { ...proposal, reviewed_arguments: { type: "opaque_reference", argument_ref: "replacement" as never } } : proposal });
  expect(pending[0]!.signal.aborted).toBe(true);
  await act(async () => pending[1]!.resolve("current"));
  await act(async () => pending[0]!.resolve("old"));
  expect(view.result.current.review).toBe("current");
  view.unmount();
  expect(pending[1]!.signal.aborted).toBe(true);
  expect(onError).not.toHaveBeenCalled();
});

it("immediately hides disabled reviews and ignores errors after unmount", async () => {
  const onError = vi.fn();
  let reject!: (error: Error) => void;
  const load = vi.fn().mockResolvedValueOnce("first").mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const view = renderHook(({ enabled }) => useBoundApprovalReview({ scope: "alice", conversationId: "conversation", proposal, load, enabled, onError }),
    { initialProps: { enabled: true } });
  await waitFor(() => expect(view.result.current.review).toBe("first"));
  view.rerender({ enabled: false });
  expect(view.result.current.review).toBeNull();
  expect(view.result.current.status).toBe("unavailable");
  view.rerender({ enabled: true });
  expect(view.result.current.review).toBeNull();
  view.unmount();
  await act(async () => reject(new Error("late failure")));
  expect(onError).not.toHaveBeenCalled();
});
