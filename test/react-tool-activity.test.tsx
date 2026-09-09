// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolActivity } from "../src/react/tool-activity.js";
import { StyledChatPreset } from "../src/react-styled/index.js";
import { projectToolActivity } from "../src/conversation/tool-activity.js";
import { createInitialConversationState, type ConversationState } from "../src/conversation/state.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { reduceConversationEvent } from "../src/conversation/reducer.js";

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
    expect(screen.getByText("1 tool call: 0 completed, 1 running")).toBeTruthy();
    expect(view.container.textContent).not.toContain("not-visible-in-activity");
    view.rerender(<StyledChatPreset state={state} toolActivity="hidden"/>);
    expect(screen.queryByText(/tool call:/)).toBeNull();
    expect(screen.queryByText("lookup")).toBeNull();
    const next = history([{ type: "turn.status_changed", turn_id: "old", status: "running" }, call("lookup", "old"),
      result("lookup", false, "old"), { type: "turn.completed", turn_id: "old", outcome: "stop", output_message_ids: [] },
      { type: "turn.status_changed", turn_id: "new", status: "running" }]);
    expect(projectToolActivity(next).total).toBe(0);
    view.rerender(<StyledChatPreset state={next}/>);
    expect(screen.queryByText(/tool call:/)).toBeNull();
  });
});
