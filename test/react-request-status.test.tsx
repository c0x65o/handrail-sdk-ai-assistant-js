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
  expect(current().textContent).toContain("Continuing…");
  view.rerender(<StyledChatPreset {...props} state={state} proposals={[proposal("one", "executed"), proposal("two", "executing")]}/>);
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
  expect(document.querySelector(".hr-activity")).toBeNull();
});

it("shows thinking after approved actions finish while the response is still running", () => {
  const state = advance(waiting(), { type: "turn.status_changed", turn_id: "turn", status: "running" });
  render(<StyledChatPreset state={state} proposals={[proposal("one", "executed")]} includeStyles={false} transcription={false}/>);
  expect(current().textContent).toContain("Thinking…");
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

it("uses one fixed status for queued, thinking, tool execution, writing and completion", () => {
  let state = advance(createInitialConversationState("conversation" as never),
    { type: "message.created", message_id: "question", role: "user", content: [{ type: "text", text: "Check the devices" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] });
  const props = { includeStyles: false, transcription: false as const };
  const view = render(<StyledChatPreset {...props} state={state}/>);
  const transcript = screen.getByRole("region", { name: "Conversation transcript" });
  expect(current().textContent).toContain("Queued…");
  expect(transcript.contains(current())).toBe(false);
  expect(transcript.querySelector(".hr-activity")).toBeNull();
  state = advance(state, { type: "turn.status_changed", turn_id: "turn", status: "running" });
  view.rerender(<StyledChatPreset {...props} state={state}/>);
  expect(screen.getAllByText("Thinking…")).toHaveLength(1);
  expect(within(current()).getByText("Thinking…")).toBeTruthy();
  expect(within(transcript).queryByText("Thinking…")).toBeNull();
  expect(screen.queryByText("Working…")).toBeNull();
  state = advance(state,
    { type: "tool_call.requested", turn_id: "turn", tool_call_id: "read", name: "read_devices", arguments: {} },
    { type: "tool_call.started", turn_id: "turn", tool_call_id: "read" });
  view.rerender(<StyledChatPreset {...props} state={state}/>);
  expect(screen.getAllByText("Working…")).toHaveLength(1);
  expect(within(current()).getByText("Working…")).toBeTruthy();
  expect(within(transcript).getByText("Actions")).toBeTruthy();
  expect(transcript.querySelector(".hr-activity__dots")).toBeNull();
  state = advance(state,
    { type: "tool_call.result_recorded", turn_id: "turn", tool_call_id: "read", content: [{ type: "text", text: "Ready" }], is_error: false },
    { type: "message.text_appended", message_id: "answer", turn_id: "turn", text: "The devices are ready." });
  view.rerender(<StyledChatPreset {...props} state={state}/>);
  expect(screen.getAllByText("Writing response…")).toHaveLength(1);
  expect(within(current()).getByText("Writing response…")).toBeTruthy();
  expect(within(transcript).queryByText("Writing response…")).toBeNull();
  state = advance(state, { type: "turn.completed", turn_id: "turn", outcome: "stop", output_message_ids: ["answer"] });
  view.rerender(<StyledChatPreset {...props} state={state}/>);
  expect(current().getAttribute("data-phase")).toBe("complete");
  expect(current().textContent).not.toContain("•••");
  expect(within(transcript).getByText("Activity complete")).toBeTruthy();
});

it("does not mistake earlier commentary for a response being written on the continuation", () => {
  const state = advance(createInitialConversationState("conversation" as never),
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
    { type: "message.text_appended", message_id: "commentary", turn_id: "turn", text: "I will check." },
    { type: "turn.completed", turn_id: "turn", outcome: "tool_calls", output_message_ids: ["commentary"] },
    { type: "turn.started", turn_id: "next", continuation_of_turn_id: "turn", input_message_ids: ["question"] },
    { type: "turn.status_changed", turn_id: "next", status: "running" });
  render(<StyledChatPreset state={state} includeStyles={false} transcription={false}/>);
  expect(within(current()).getByText("Thinking…")).toBeTruthy();
  expect(screen.queryByText("Writing response…")).toBeNull();
});

it("requires execution evidence before describing a confirmed approval as running", () => {
  let state = advance(waiting(),
    { type: "tool_call.requested", turn_id: "turn", tool_call_id: "one", name: "update_device", arguments: {} },
    { type: "tool_call.approval_required", turn_id: "turn", tool_call_id: "one" });
  const props = { proposals: [proposal("one", "confirmed")], includeStyles: false, transcription: false as const };
  const view = render(<StyledChatPreset {...props} state={state}/>);
  expect(current().textContent).toContain("Continuing…");
  state = advance(state, { type: "tool_call.started", turn_id: "turn", tool_call_id: "one" });
  view.rerender(<StyledChatPreset {...props} state={state}/>);
  expect(current().textContent).toContain("Running approved changes…");
  expect(screen.getAllByText("Running approved changes…")).toHaveLength(1);
});

it("keeps unknown remote activity in the fixed status without inserting a transcript card", () => {
  const activity = new InMemoryConversationActivityStore();
  activity.upsert({ conversationId: "conversation", turnId: "remote", turnStatus: "running", unread: false,
    summary: "Checking device connections", progress: { completed: 2, total: 7, unit: "devices" } });
  const view = render(<StyledChatPreset state={createInitialConversationState("conversation" as never)}
    activity={activity} includeStyles={false} transcription={false}/>);
  expect(current().textContent).toContain("Checking device connections (2/7 devices)");
  expect(screen.getAllByText("Working…")).toHaveLength(1);
  expect(view.container.querySelector(".hr-activity")).toBeNull();
});

it("keeps uncertain disconnected work visible without claiming it is executing", () => {
  const started = advance(createInitialConversationState("conversation" as never),
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] });
  const state = { ...started, active_turn_id: null };
  render(<StyledChatPreset state={state} includeStyles={false} transcription={false}/>);
  expect(current().textContent).toContain("Checking request status…");
  expect(screen.queryByText("Working…")).toBeNull();
});
