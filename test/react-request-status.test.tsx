/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createInitialConversationState, type ConversationApprovalProposalRecord, type ConversationState } from "../src/conversation/state.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { reduceConversationEvent } from "../src/conversation/reducer.js";
import { InMemoryConversationActivityStore } from "../src/conversation/activity.js";
import { StyledChatPreset } from "../src/react-styled/index.js";
import { ConversationRequestStatus } from "../src/react-styled/request-status.js";

afterEach(cleanup);
const stamp = "2026-09-22T12:00:00.000Z";
function advance(state: ConversationState, ...payloads: object[]) {
  return payloads.reduce<ConversationState>((value, payload) => reduceConversationEvent(value, parseConversationEvent({
    version: 1, conversation_id: "conversation", event_id: `event-${(value.revision ?? 0) + 1}`, revision: (value.revision ?? 0) + 1,
    occurred_at: stamp, actor: { type: "system" }, source: { type: "runtime" }, payload,
  })), state);
}
function proposal(id: string, status: ConversationApprovalProposalRecord["status"] = "pending", turn = "turn") {
  return { proposal_id: id, group_id: "conversation", turn_id: turn, tool_call_id: id,
    tool_name: "update_device", proposal_version: 1, status, expires_at: null, created_at: stamp, updated_at: stamp,
    reviewed_arguments: { type: "redacted_json", value: { name: id } } } as unknown as ConversationApprovalProposalRecord;
}
function waiting() {
  return advance(createInitialConversationState("conversation" as never),
    { type: "message.created", message_id: "question", role: "user", content: [{ type: "text", text: "Update my devices" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
    { type: "turn.status_changed", turn_id: "turn", status: "waiting_for_approval" });
}
const current = () => screen.getByRole("region", { name: "Current request" });

it("keeps successive approvals and continuation visible outside the transcript until actual completion", () => {
  let state = waiting();
  const props = { includeStyles: false, transcription: false as const };
  const view = render(<StyledChatPreset {...props} state={state} proposals={[proposal("one"), proposal("two")]}/>);
  expect(current().textContent).toContain("2 actions need your review");
  expect(screen.getByRole("region", { name: "Conversation transcript" }).contains(current())).toBe(false);
  const first = view.container.querySelector<HTMLElement>('[data-pending-approval="true"]')!;
  first.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole("button", { name: "Review next" }));
  expect(first.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(document.activeElement).toBe(first);
  view.rerender(<StyledChatPreset {...props} state={state} proposals={[proposal("one", "executed"), proposal("two")]}/>);
  expect(current().textContent).toContain("1 action needs your review");
  view.rerender(<StyledChatPreset {...props} state={state} proposals={[proposal("one", "executed"), proposal("two", "confirmed")]}/>);
  expect(current().textContent).toContain("Running approved changes…");
  expect(within(current()).queryByRole("button")).toBeNull();
  view.rerender(<StyledChatPreset {...props} state={state} proposals={[proposal("one", "executed"), proposal("two", "executed")]}/>);
  expect(current().textContent).toContain("Continuing…");
  state = advance(state,
    { type: "turn.completed", turn_id: "turn", outcome: "tool_calls", output_message_ids: [] },
    { type: "turn.started", turn_id: "next", continuation_of_turn_id: "turn", input_message_ids: ["question"] },
    { type: "turn.status_changed", turn_id: "next", status: "waiting_for_approval" });
  view.rerender(<StyledChatPreset {...props} state={state} proposals={[proposal("three", "pending", "next")]}/>);
  expect(current().textContent).toContain("Waiting for approval");
  state = advance(state, { type: "turn.completed", turn_id: "next", outcome: "stop", output_message_ids: [] });
  view.rerender(<StyledChatPreset {...props} state={state} proposals={[proposal("three", "executed", "next")]}/>);
  expect(current().textContent).toContain("Request complete");
  expect(current().getAttribute("data-phase")).toBe("complete");
  view.rerender(<StyledChatPreset {...props} state={createInitialConversationState("other" as never)}/>);
  expect(screen.queryByRole("region", { name: "Current request" })).toBeNull();
});

it("uses approval records when the loaded tool activity still looks like a running response", () => {
  const state = advance(createInitialConversationState("conversation" as never),
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] });
  render(<StyledChatPreset state={state} proposals={[proposal("one")]} includeStyles={false} transcription={false}/>);
  expect(current().textContent).toContain("Waiting for approval");
  expect(document.querySelector(".hr-activity")?.getAttribute("data-active")).toBe("false");
});

it("shows an admitted running turn as working while its remote execution is active", () => {
  const state = advance(waiting(), { type: "turn.status_changed", turn_id: "turn", status: "running" });
  render(<StyledChatPreset state={state} proposals={[proposal("one", "executed")]} includeStyles={false} transcription={false}/>);
  expect(current().textContent).toContain("Working…");
});

it("reports approvals outside a loaded window without presenting its partial count as the total", () => {
  const state = { ...waiting(), partial: true as const };
  const props = { state, activity: undefined, hasPendingApprovals: true, savingDecision: false };
  const view = render(<ConversationRequestStatus {...props} proposals={[]} onReview={vi.fn()}/>);
  expect(current().textContent).toContain("Waiting for approval");
  expect(screen.getByRole("button", { name: "Review next" })).toBeTruthy();
  view.rerender(<ConversationRequestStatus {...props} proposals={[proposal("loaded")]}/>);
  expect(current().textContent).not.toContain("1 action");
});

it("shows saving separately and never treats a saved decision as a finished request", () => {
  render(<ConversationRequestStatus state={waiting()} proposals={[proposal("one")]} activity={undefined}
    hasPendingApprovals savingDecision onReview={vi.fn()}/>);
  expect(current().textContent).toContain("Saving approval decision…");
  expect(screen.queryByRole("button", { name: "Review next" })).toBeNull();
});

it.each(["failed", "cancelled", "completed"] as const)("honors %s over a stale running index and approved receipt", status => {
  const initial = waiting();
  const state = { ...initial, turns: initial.turns.map(turn => ({ ...turn, status, outcome: "stop" as const })) };
  const activity = new InMemoryConversationActivityStore();
  activity.upsert({ conversationId: "conversation", turnId: "turn", turnStatus: "running", unread: false });
  render(<StyledChatPreset state={state} proposals={[proposal("one", "confirmed")]} activity={activity} includeStyles={false} transcription={false}/>);
  expect(current().textContent).toContain(status === "failed" ? "Request failed" : status === "cancelled" ? "Request stopped" : "Request complete");
  expect(current().getAttribute("data-phase")).not.toBe("working");
});
