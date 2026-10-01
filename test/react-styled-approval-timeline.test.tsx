/** @vitest-environment jsdom */
import { parseConversationEvent } from "../src/conversation/events.js";
import { reduceConversationEvent } from "../src/conversation/reducer.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("shows bound action details in chronological context before a versioned decision", async () => {
  const f = fixture();
  render(<StyledChatPreset state={f.state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  const card = await screen.findByRole("listitem", { name: "Assistant action" });
  expect(card.querySelector('dt')?.textContent).toBe('Amount');
  expect(card.querySelector('dd')?.textContent).toBe('212');
  expect(card.querySelector('pre')).toBeNull();
  const transcript = screen.getByRole("region", { name: "Conversation transcript" });
  expect(transcript.textContent?.indexOf("Correct this expense")).toBeLessThan(transcript.textContent!.indexOf("Reclassify expense"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(f.resources.transitionApproval).toHaveBeenCalledWith(expect.objectContaining({
    conversationId: "conversation", proposalId: "proposal", expectedVersion: 1, status: "confirmed",
  })));
});
it("disables confirmation for mismatched arguments while retaining rejection", async () => {
  const f = fixture(false);
  render(<StyledChatPreset state={f.state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  expect((await screen.findByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("300")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(f.resources.transitionApproval).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" })));
});
it("retains saved decided cards and failures and prevents decisions for archived conversations", async () => {
  const f = fixture();
  f.resources.listApprovalGroup.mockResolvedValue([{ ...f.proposal, status: "rejected" }]);
  const view = render(<StyledChatPreset state={f.state} approvalResources={f.resources} readOnly includeStyles={false} transcription={false}/>);
  const history = (await screen.findByText("Action history (1)")).closest("details")!;
  fireEvent.click(history.querySelector("summary")!);
  expect(await screen.findByText("Rejected")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  view.rerender(<StyledChatPreset state={f.state} proposals={[f.proposal]} approvalResources={f.resources} readOnly includeStyles={false} transcription={false}/>);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  expect(f.resources.transitionApproval).not.toHaveBeenCalled();
});

it("keeps a large pending approval compact without losing its exact review or decisions", async () => {
  const f = fixture();
  const value = { fields: Array.from({ length: 12 }, (_, i) => ({ label: `Field ${i}`, amount: "0012.3400" })) };
  f.resources.listApprovalGroup.mockResolvedValue([{ ...f.proposal, reviewed_arguments: { type: "redacted_json", value } }]);
  render(<StyledChatPreset state={f.state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  const card = await screen.findByRole("listitem", { name: "Assistant action" });
  expect(card.querySelector("details")?.open).toBe(false);
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByText("Action details"));
  expect(card.querySelector("details")?.open).toBe(true);
  expect(screen.getByText("Field 11")).toBeTruthy();
  expect(screen.getAllByText("0012.3400")).toHaveLength(12);
});

it("requires a successful refresh before another decision after an uncertain response", async () => {
  const f = fixture();
  f.resources.transitionApproval.mockRejectedValueOnce(new Error("uncertain"));
  render(<StyledChatPreset state={f.state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await screen.findByRole("button", { name: "Retry approvals" });
  for (const name of ["Confirm", "Reject"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(f.resources.transitionApproval).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry approvals" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false));
});


it("rests at a pending approval with no Stop button or decision from typing a comment", async () => {
  const f = fixture();
  let state = f.state;
  for (const [index, payload] of [
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
    { type: "turn.status_changed", turn_id: "turn", status: "waiting_for_approval" },
  ].entries()) state = reduceConversationEvent(state, parseConversationEvent({ version: 1,
    conversation_id: "conversation", event_id: `pause-${index}`, revision: index + 1, occurred_at: stamp,
    actor: { type: "system" }, source: { type: "runtime" }, payload }));
  f.resources.listApprovalGroup.mockResolvedValue([{ ...f.proposal, expires_at: null }]);
  const view = render(<StyledChatPreset state={state} approvalResources={f.resources} includeStyles={false} transcription={false}/>);
  await screen.findByRole("button", { name: "Confirm" });
  // The current preset uses one persistent activity heading.
  expect(screen.getAllByText("Waiting for approval", { selector: "strong" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(view.container.querySelector('[data-busy="true"]')).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "I need more time." } });
  expect(f.resources.transitionApproval).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
});

it("collapses settled vehicle/review and invoice cards while preserving canonical history and unresolved work", async () => {
  const f = fixture();
  const settled = ["Review proposed change", "Update a vehicle or boat", "Send invoice"].map((tool_name, i) =>
    ({ ...f.proposal, proposal_id: `settled-${i}`, tool_name, status: "executed" }) as ConversationApprovalProposalRecord);
  const active = ["pending", "confirmed", "executing", "failed"].map((status, i) =>
    ({ ...f.proposal, proposal_id: `active-${i}`, tool_name: `Unresolved ${i}`, status }) as ConversationApprovalProposalRecord);
  const props = { state: f.state, includeStyles: false, transcription: false as const, readOnly: true };
  const view = render(<StyledChatPreset {...props} proposals={[...settled, ...active]}/>);
  expect(screen.getAllByRole("listitem", { name: "Assistant action" })).toHaveLength(4);
  expect(screen.queryByText("Update a vehicle or boat")).toBeNull();
  const history = screen.getByText("Action history (3)").closest("details")!;
  fireEvent.click(history.querySelector("summary")!);
  await waitFor(() => expect(screen.getByText("Update a vehicle or boat")).toBeTruthy());
  expect(screen.getAllByRole("listitem", { name: "Assistant action" })).toHaveLength(7);
  for (const button of screen.queryAllByRole("button", { name: "Confirm" })) expect((button as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<StyledChatPreset {...props} state={{ ...f.state, conversation_id: "other" as never }} proposals={settled}/>);
  expect(screen.queryByText("Update a vehicle or boat")).toBeNull();
  view.unmount();
  render(<StyledChatPreset {...props} proposals={settled}/>);
  expect(screen.queryByText("Update a vehicle or boat")).toBeNull();
  expect(settled.every(p => p.status === "executed")).toBe(true);
  expect(f.resources.transitionApproval).not.toHaveBeenCalled();
});

it.each(["executed", "rejected", "expired"] as const)("moves canonical %s to history on repeated delivery while retaining uncertain failure evidence", async status => {
  const f = fixture();
  const props = { state: f.state, includeStyles: false, transcription: false as const, readOnly: true };
  const view = render(<StyledChatPreset {...props} proposals={[f.proposal]}/>);
  expect(screen.getByRole("listitem", { name: "Assistant action" })).toBeTruthy();
  const settled = { ...f.proposal, status };
  for (let delivery = 0; delivery < 2; delivery++) {
    view.rerender(<StyledChatPreset {...props} proposals={[{ ...settled }]}/>);
    expect(screen.queryByRole("listitem", { name: "Assistant action" })).toBeNull();
    expect(screen.getByText("Action history (1)")).toBeTruthy();
  }
  view.rerender(<StyledChatPreset {...props} proposals={[{ ...settled, failure_reason: "Outcome needs reconciliation" }]}/>);
  expect(screen.getByRole("listitem", { name: "Assistant action" })).toBeTruthy();
  expect(f.resources.transitionApproval).not.toHaveBeenCalled();
});
