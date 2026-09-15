import { createHash } from "node:crypto";
import { assistantToolArgumentReference } from "../src/conversation/approval-arguments.js";
import { describe, expect, it } from "vitest";
import { conversationTimeline } from "../src/conversation/timeline.js";
import { createInitialConversationState, type ConversationState, type ConversationApprovalProposalRecord,
  type ConversationMessageRecord, type ConversationToolCallRecord } from "../src/conversation/state.js";

const at = (second: number) => `2026-09-12T12:00:${String(second).padStart(2, "0")}.000Z`;
function message(id: string, role: "user" | "assistant", second: number, turn = "turn-1"): ConversationMessageRecord {
  return { message_id: id as never, role, content: [{ type: "text", text: id }], attachments: [],
    turn_id: turn as never, created_at: at(second) as never, attribution: null };
}
function proposal(id = "proposal", second = 2): ConversationApprovalProposalRecord {
  return { proposal_id: id, group_id: "independent-group", turn_id: "turn-1", tool_call_id: "call", tool_name: "update",
    created_at: at(second), updated_at: at(second), status: "pending" } as ConversationApprovalProposalRecord;
}
function result(id = "call", turn = "turn-1"): ConversationToolCallRecord {
  return { tool_call_id: id, turn_id: turn, name: "update", requested_at: at(2), approval_required_at: null,
    result: { recorded_at: at(4) } } as ConversationToolCallRecord;
}
function state(): ConversationState {
  return { ...createInitialConversationState("conversation" as never), messages: [message("question", "user", 1),
    message("answer", "assistant", 3), message("next-question", "user", 5, "turn-2"), message("next-answer", "assistant", 8, "turn-2")] };
}
const labels = (value: ReturnType<typeof conversationTimeline>) => value.map(entry => entry.type === "message" ? entry.message.message_id
  : entry.type === "activity" ? `activity:${entry.group.id}` : entry.type === "approval" ? entry.proposal.proposal_id : entry.type === "failure" ? `failed:${entry.turn.turn_id}` : entry.call.tool_call_id);

describe("conversation timeline", () => {
  it("renders saved approvals for independent group identities in canonical chronology", () => {
    expect(labels(conversationTimeline({ ...state(), approval_proposals: [proposal()] })))
      .toEqual(["question", "proposal", "answer", "next-question", "next-answer"]);
  });
  it("retains placement when decisions settle after another question", () => {
    const pending = proposal();
    const finished = { ...pending, status: "executed" as const, updated_at: at(30) as never };
    expect(labels(conversationTimeline(state(), { proposals: [finished] })))
      .toEqual(labels(conversationTimeline(state(), { proposals: [pending] })));
  });
  it("binds clock skew and delayed actions to their original question", () => {
    expect(labels(conversationTimeline(state(), { proposals: [proposal("late", 20), proposal("early", 0)] })))
      .toEqual(["question", "early", "answer", "late", "next-question", "next-answer"]);
  });
  it("shows opted-in automatic results without duplicating approval cards", () => {
    const value = { ...state(), tool_calls: [result()] };
    expect(labels(conversationTimeline(value))).not.toContain("call");
    expect(labels(conversationTimeline(value, { includeToolResult: () => true }))).toContain("call");
    expect(labels(conversationTimeline(value, { includeToolResult: () => true, proposals: [proposal()] })))
      .toEqual(["question", "proposal", "answer", "next-question", "next-answer"]);
  });
  it("does not suppress a result when a different turn reused a provider call ID", () => {
    const value = { ...state(), tool_calls: [result("call", "turn-2")] };
    expect(labels(conversationTimeline(value, { includeToolResult: () => true, proposals: [proposal()] })))
      .toEqual(["question", "proposal", "answer", "next-question", "call", "next-answer"]);
  });
  it("places failures after the failed turn's last message and retains orphan failures", () => {
    const failure = { turn_id: "turn-1", status: "failed", input_message_ids: [], output_message_ids: [] } as unknown as ConversationState["turns"][number];
    expect(labels(conversationTimeline({ ...state(), turns: [failure, { ...failure, turn_id: "missing" as never }] })))
      .toEqual(["question", "answer", "failed:turn-1", "next-question", "next-answer", "failed:missing"]);
  });
});

it("uses the same portable canonical argument digest as the authorized server", () => {
  const arguments_ = { amount: 212, category: "Software", nested: { z: false, a: ["é", 1] } };
  const canonical = '{"amount":212,"category":"Software","nested":{"a":["é",1],"z":false}}';
  expect(assistantToolArgumentReference(arguments_)).toBe(`args-sha256-${createHash("sha256").update(canonical).digest("hex")}`);
});
