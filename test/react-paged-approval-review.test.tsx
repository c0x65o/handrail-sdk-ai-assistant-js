// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPagedApprovalReview } from "../src/react/paged-approval-review.js";
import type { ConversationApprovalDisplayReviewInput, ConversationApprovalDisplayReview } from "../src/conversation/approval-display-review.js";
afterEach(cleanup);
const binding = "a".repeat(64), proposalBinding = "b".repeat(64);
const input = { conversationId: "chat", generation: 0, proposalId: "proposal" };
function fixture() {
  const read = vi.fn(async (request: ConversationApprovalDisplayReviewInput, _signal: AbortSignal): Promise<ConversationApprovalDisplayReview> => { void _signal; return ({
    schemaVersion: 1, ...input, status: "ready", review: { binding, proposalBinding, proposalVersion: 1, groupId: "chat", turnId: "turn",
      toolCallId: "tool", toolName: "send", argumentReference: `args-sha256-${binding}`, text: request.offset ? "<script>literal last section</script>" : "🙂".repeat(8192),
      offset: request.offset ?? 0, nextOffset: request.offset ? null : 8192 },
  }); });
  const decide = vi.fn(async (_input: unknown, _signal: AbortSignal) => { void _input; void _signal; }), onRefresh = vi.fn();
  const props = { ...input, read, decide, onRefresh };
  return { ...props, props };
}
it("reviews one literal section at a time in StrictMode and requires acknowledgement before confirming", async () => {
  const f = fixture(); render(<StrictMode><ConversationPagedApprovalReview {...f.props}/></StrictMode>);
  const content = await screen.findByLabelText("Action arguments part");
  expect(content.textContent).toHaveLength(16384);
  expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next part" }));
  await waitFor(() => expect(screen.getByLabelText("Action arguments part").textContent).toBe("<script>literal last section</script>"));
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await screen.findByText("Approval saved.");
  expect(f.decide).toHaveBeenCalledTimes(1);
  expect(f.decide.mock.calls[0]?.[0]).toMatchObject({ expectedVersion: 1, proposalBinding, status: "confirmed" });
  expect(screen.queryByLabelText("Action arguments part")).toBeNull();
});
it("hides account-reused identities immediately and cancels the previous held section", async () => {
  const f = fixture(), next = fixture();
  let resolve!: (response: ConversationApprovalDisplayReview) => void;
  const held = new Promise<ConversationApprovalDisplayReview>(accept => { resolve = accept; });
  const response = await f.read({ ...input, offset: 0 }, new AbortController().signal); f.read.mockClear();
  f.read.mockReturnValue(held);
  const view = render(<ConversationPagedApprovalReview {...f.props}/>);
  await waitFor(() => expect(f.read).toHaveBeenCalledOnce());
  view.rerender(<ConversationPagedApprovalReview {...next.props}/>);
  expect(f.read.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => resolve(response));
  await screen.findByLabelText("Action arguments part");
  expect(f.decide).not.toHaveBeenCalled(); expect(next.read).toHaveBeenCalledOnce();
});
it("invalidates changed reviews and preserves the decision action on uncertain receipt retries", async () => {
  const f = fixture(); render(<ConversationPagedApprovalReview {...f.props}/>);
  await screen.findByLabelText("Action arguments part");
  f.decide.mockRejectedValueOnce(new Error("lost response"));
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry decision" }));
  await screen.findByText("Rejection saved.");
  expect(f.decide.mock.calls[0]?.[0]).toBe(f.decide.mock.calls[1]?.[0]);
  expect(f.read).toHaveBeenCalledTimes(2);
});
