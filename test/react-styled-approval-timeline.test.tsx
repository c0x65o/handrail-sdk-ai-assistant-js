/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createInitialConversationState, type ConversationApprovalProposalRecord, type ConversationState,
  type ConversationToolCallRecord } from "../src/conversation/state.js";
import { assistantToolArgumentReference } from "../src/conversation/approval-arguments.js";
import { StyledChatPreset } from "../src/react-styled/index.js";

afterEach(cleanup);
const stamp = "2026-09-12T12:00:00.000Z";
const arguments_ = { amount: 212, category: "Software", nested: { z: false, a: ["é", 1] } };
function fixture(matching = true) {
  const proposal = { proposal_id: "proposal", group_id: "conversation", turn_id: "turn", tool_call_id: "call",
    tool_name: "reclassify_expense", proposal_version: 1, status: "pending", expires_at: "2099-01-01T00:00:00.000Z",
    created_at: stamp, updated_at: stamp, reviewed_arguments: { type: "opaque_reference",
      argument_ref: assistantToolArgumentReference(arguments_) } } as ConversationApprovalProposalRecord;
  const call = { turn_id: "turn", tool_call_id: "call", name: "reclassify_expense", requested_at: stamp,
    approval_required_at: stamp, discovered_at: null, started_at: null, attribution: null, arguments: matching ? arguments_ : { ...arguments_, amount: 300 }, result: null } as unknown as ConversationToolCallRecord;
  const state: ConversationState = { ...createInitialConversationState("conversation" as never), tool_calls: [call], messages: [{
    message_id: "question" as never, turn_id: "turn" as never, role: "user", content: [{ type: "text", text: "Correct this expense" }],
    created_at: stamp as never, attachments: [], attribution: null,
  }] };
  const transitionApproval = vi.fn(async () => ({ ...proposal, status: "confirmed" as const, proposal_version: 2 }));
  const resources = { listApprovalGroup: vi.fn(async () => [proposal]), transitionApproval };
  return { proposal, state, resources };
}
it("uses the same portable canonical argument digest as the authorized server", () => {
  const canonical = '{"amount":212,"category":"Software","nested":{"a":["é",1],"z":false}}';
  expect(assistantToolArgumentReference(arguments_)).toBe(`args-sha256-${createHash("sha256").update(canonical).digest("hex")}`);
});
it("shows bound action details in chronological context before a versioned decision", async () => {
  const f = fixture();
  render(<StyledChatPreset state={f.state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  const card = await screen.findByRole("listitem", { name: "Assistant action" });
  expect(card.textContent).toContain('"amount": 212');
  const transcript = screen.getByRole("region", { name: "Conversation transcript" });
  expect(transcript.textContent?.indexOf("Correct this expense")).toBeLessThan(transcript.textContent!.indexOf("reclassify expense"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(f.resources.transitionApproval).toHaveBeenCalledWith(expect.objectContaining({
    conversationId: "conversation", proposalId: "proposal", expectedVersion: 1, status: "confirmed",
  })));
});
it("disables confirmation for mismatched arguments while retaining rejection", async () => {
  const f = fixture(false);
  render(<StyledChatPreset state={f.state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  expect((await screen.findByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/"amount": 300/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(f.resources.transitionApproval).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" })));
});
it("retains saved decided cards and failures and prevents decisions for archived conversations", async () => {
  const f = fixture();
  f.resources.listApprovalGroup.mockResolvedValue([{ ...f.proposal, status: "rejected" }]);
  const view = render(<StyledChatPreset state={f.state} approvalResources={f.resources} readOnly includeStyles={false} transcription={false}/>);
  expect(await screen.findByText("rejected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  view.rerender(<StyledChatPreset state={f.state} proposals={[f.proposal]} approvalResources={f.resources} readOnly includeStyles={false} transcription={false}/>);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  expect(f.resources.transitionApproval).not.toHaveBeenCalled();
});
