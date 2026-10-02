// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolActivity } from "../src/react/tool-activity.js";
import { StyledChatPreset } from "../src/react-styled/index.js";
import { projectToolActivity } from "../src/conversation/tool-activity.js";
import { createInitialConversationState, type ConversationState } from "../src/conversation/state.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { reduceConversationEvent } from "../src/conversation/reducer.js";

afterEach(cleanup);

function history(payloads: object[]): ConversationState {
  return payloads.reduce<ConversationState>((state, payload, index) => reduceConversationEvent(state, parseConversationEvent({
    version: 1, event_id: `event-${index}`, revision: index + 1, conversation_id: "conversation",
    occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "system" }, source: { type: "runtime" }, payload,
  })), createInitialConversationState("conversation" as never));
}
const call = (id: string, turnId = "turn") => ({ type: "tool_call.requested", turn_id: turnId,
  tool_call_id: id, name: id, arguments: { privateField: "not-visible-in-activity" } });
const started = (id: string, turnId = "turn") => ({ type: "tool_call.started", turn_id: turnId, tool_call_id: id });
const result = (id: string, isError = false, turnId = "turn") => ({ type: "tool_call.result_recorded", turn_id: turnId,
  tool_call_id: id, content: [{ type: "text", text: "private-result" }], is_error: isError });

describe("canonical tool activity", () => {
  it("renders a recovered operation separately from unresolved failures using its durable receipt", () => {
    const receipt = { type: "handrail.tool_recovery.v1", status: "recovered", attempts: 3, failedAttempts: 2,
      category: "transient", code: "service_busy", reason: "completed" };
    const state = history([call("lookup"), { ...result("lookup"), content: [{ type: "json", value: receipt }] },
      call("failed"), result("failed", true)]);
    const view = render(<ToolActivity state={state} display="expanded"/>);
    expect(view.container.textContent).toContain("1 completed, 1 recovered after retry, 1 failed");
    expect(view.container.textContent).toContain("Recovered after 2 failed attempts");
    const invalid = history([call("lookup"), { ...result("lookup", true), content: [{ type: "json", value: receipt }] }]);
    expect(projectToolActivity(invalid)).toMatchObject({ failed: 1 });
    expect(projectToolActivity(invalid).recovered).toBeUndefined();
    view.unmount();
  });
  it("shows accurate counts in a collapsed panel without disclosing arguments or results", () => {
    const state = history([call("lookup"), started("lookup"), result("lookup"), call("update"), started("update"),
      call("review"), { type: "tool_call.approval_required", turn_id: "turn", tool_call_id: "review" },
      call("queued"), call("failed"), result("failed", true)]);
    const view = render(<ToolActivity state={state}/>);
    expect(screen.getByText("5 tool calls: 1 completed, 1 running, 1 pending, 1 waiting for approval, 1 failed")).toBeTruthy();
    expect(view.container.querySelector("details")?.open).toBe(false);
    expect(view.container.textContent).not.toContain("not-visible-in-activity");
    expect(view.container.textContent).not.toContain("private-result");
    view.rerender(<ToolActivity state={state} display="expanded"/>);
    expect(view.container.querySelector("details")?.open).toBe(true);
    view.rerender(<ToolActivity state={state} display="hidden"/>);
    expect(view.container.textContent).toBe("");
    view.rerender(<ToolActivity state={state}>{(activity) => <p>Custom: {activity.running} running</p>}</ToolActivity>);
    expect(screen.getByText("Custom: 1 running")).toBeTruthy();
  });

  it("includes continuation ancestors and never describes an unfinished call as running after terminal state", () => {
    const state = history([
      { type: "turn.status_changed", turn_id: "turn", status: "running" },
      call("lookup"), started("lookup"), result("lookup"), call("unfinished"), started("unfinished"),
      { type: "turn.completed", turn_id: "turn", outcome: "tool_calls", output_message_ids: [] },
      { type: "turn.started", turn_id: "continuation", continuation_of_turn_id: "turn", input_message_ids: ["user-message"] },
      call("update", "continuation"), started("update", "continuation"), result("update", false, "continuation"),
      { type: "turn.completed", turn_id: "continuation", outcome: "stop", output_message_ids: [] },
    ]);
    expect(projectToolActivity(state)).toMatchObject({ total: 3, completed: 2, running: 0, incomplete: 1 });
    const cancelled = history([{ type: "turn.status_changed", turn_id: "turn", status: "running" },
      call("update"), started("update"), { type: "turn.cancelled", turn_id: "turn", reason: "user" }]);
    expect(projectToolActivity(cancelled)).toMatchObject({ total: 1, running: 0, cancelled: 1 });
  });

  it("resets activity for a new user turn and supports hiding technical details in the standard UI", () => {
    const state = history([{ type: "turn.status_changed", turn_id: "turn", status: "running" },
      { type: "message.created", message_id: "message", role: "assistant",
        content: [{ type: "text", text: "Checking" }] }, call("lookup"), started("lookup")]);
    const view = render(<StyledChatPreset state={state}/>);
    expect(screen.getByText("1 action")).toBeTruthy();
    expect(view.container.textContent).not.toContain("not-visible-in-activity");
    view.rerender(<StyledChatPreset state={state} toolActivity="hidden"/>);
    expect(screen.queryByText("1 action")).toBeNull();
    expect(screen.queryByText("lookup")).toBeNull();
    const next = history([{ type: "turn.status_changed", turn_id: "old", status: "running" }, call("lookup", "old"),
      result("lookup", false, "old"), { type: "turn.completed", turn_id: "old", outcome: "stop", output_message_ids: [] },
      { type: "turn.status_changed", turn_id: "new", status: "running" }]);
    expect(projectToolActivity(next).total).toBe(0);
    view.rerender(<StyledChatPreset state={next}/>);
    expect(screen.getByText("Activity complete")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });
});


it("keeps one expanded group with its original question across tool continuations and new requests", () => {
  const payloads: object[] = [
    { type: "message.created", message_id: "question", role: "user", content: [{ type: "text", text: "First question" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
    call("read_ledger"), started("read_ledger"),
  ];
  const view = render(<StyledChatPreset state={history(payloads)}/>);
  const group = view.container.querySelector("details.hr-activity")! as HTMLDetailsElement;
  expect(group.open).toBe(false);
  group.open = true;
  fireEvent(group, new Event("toggle"));
  payloads.push(result("read_ledger"), { type: "turn.completed", turn_id: "turn", outcome: "tool_calls", output_message_ids: [] },
    { type: "turn.started", turn_id: "continued", continuation_of_turn_id: "turn", input_message_ids: ["question"] },
    call("summarize_income", "continued"), started("summarize_income", "continued"));
  view.rerender(<StyledChatPreset state={history(payloads)}/>);
  expect(view.container.querySelectorAll("details.hr-activity")).toHaveLength(1);
  expect(view.container.querySelector("details.hr-activity")).toBe(group);
  expect(group.open).toBe(true);
  expect(group.textContent).toContain("2 actions");
  expect(group.textContent).toContain("Read ledger");
  expect(group.textContent).not.toContain("private-result");
  payloads.push(result("summarize_income", false, "continued"),
    { type: "message.text_appended", message_id: "answer", turn_id: "continued", text: "Here is the answer" },
    { type: "turn.completed", turn_id: "continued", outcome: "stop", output_message_ids: ["answer"] },
    { type: "message.created", message_id: "question2", role: "user", content: [{ type: "text", text: "Second question" }] },
    { type: "turn.started", turn_id: "second", input_message_ids: ["question2"] });
  const completed = history(payloads);
  view.rerender(<StyledChatPreset state={completed}/>);
  const text = view.container.querySelector(".hr-chat__transcript")!.textContent!;
  expect(text.indexOf("Activity complete")).toBeLessThan(text.indexOf("Here is the answer"));
  expect(text.indexOf("Here is the answer")).toBeLessThan(text.indexOf("Second question"));
  expect(text).not.toContain("Thinking…");
  expect(screen.getByRole("region", { name: "Current request" }).textContent).toContain("Queued…");
  expect(group.open).toBe(true);
  view.unmount();
  const restored = render(<StyledChatPreset state={completed}/>);
  expect(restored.container.querySelectorAll("details.hr-activity")).toHaveLength(1);
  expect(restored.container.querySelector("details.hr-activity")?.textContent).toContain("2 actions");
});


it.each([false, true])("distinguishes a declined B from executed A and real failures after replay (partial=%s)", partial => {
  const proposal = (id: string) => ({ type: "approval.proposal_created", proposal_id: `proposal-${id}`,
    turn_id: "turn", tool_call_id: id, tool_name: id, status: "pending", proposal_version: 1, expires_at: null,
    reviewed_arguments: { type: "redacted_json", value: { record: id } } });
  const payloads = [
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
    call("update_asset"), proposal("update_asset"),
    { type: "approval.proposal_status_changed", proposal_id: "proposal-update_asset", proposal_version: 2, status: "confirmed" },
    { type: "approval.proposal_status_changed", proposal_id: "proposal-update_asset", proposal_version: 3, status: "executing" },
    started("update_asset"), result("update_asset"),
    { type: "approval.proposal_status_changed", proposal_id: "proposal-update_asset", proposal_version: 4, status: "executed" },
    call("send_invoice"), proposal("send_invoice"),
    { type: "approval.proposal_status_changed", proposal_id: "proposal-send_invoice", proposal_version: 2, status: "rejected" },
    result("send_invoice", true),
    { type: "turn.completed", turn_id: "turn", outcome: "stop", output_message_ids: [] },
  ];
  const state = { ...history(payloads), ...(partial ? { partial: true as const } : {}) };
  expect(projectToolActivity(state)).toMatchObject({ completed: 1, rejected: 1, failed: 0, incomplete: 0 });
  const view = render(<StyledChatPreset state={state} includeStyles={false} transcription={false}/>);
  expect(screen.getByText("Activity complete")).toBeTruthy();
  expect(screen.getByText("Request complete")).toBeTruthy();
  expect(view.container.textContent).not.toContain("Failed");
  view.unmount();
  // A reload projects the same canonical facts, without modifying the saved error result.
  expect(projectToolActivity(history(payloads))).toEqual(projectToolActivity(state));
  expect(state.tool_calls[1]?.result?.is_error).toBe(true);
  const failed = history([...payloads.slice(0, -1), call("read_ledger"), result("read_ledger", true), payloads.at(-1)!]);
  expect(projectToolActivity(failed)).toMatchObject({ rejected: 1, failed: 1 });
  render(<StyledChatPreset state={failed} includeStyles={false} transcription={false}/>);
  expect(screen.getByText("Activity needs attention")).toBeTruthy();
  expect(screen.getByText("Finished · some actions need attention")).toBeTruthy();
});

it("does not hide failures using an unrelated, ambiguous, or execution-conflicted rejection", () => {
  const state = history([call("write"), result("write", true)]);
  const rejected = { proposal_id: "p", turn_id: "turn", tool_call_id: "write", tool_name: "write",
    status: "rejected", failure_reason: null } as unknown as ConversationState["approval_proposals"][number];
  for (const proposals of [[{ ...rejected, turn_id: "other" as never }], [{ ...rejected, tool_name: "other" }],
    [rejected, { ...rejected, proposal_id: "other" as never }], [{ ...rejected, failure_reason: "Uncertain execution" }]]) {
    expect(projectToolActivity({ ...state, approval_proposals: proposals }).failed).toBe(1);
  }
  expect(projectToolActivity({ ...state, approval_proposals: [rejected], tool_calls: [{ ...state.tool_calls[0]!,
    started_at: "2026-09-04T00:00:00.000Z" as never }] }).failed).toBe(1);
});
