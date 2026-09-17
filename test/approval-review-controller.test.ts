import { expect, it, vi } from "vitest";
import { ConversationApprovalReview } from "../src/client/approval-review.js";
import type { ConversationApprovalDisplayReviewInput, ConversationApprovalDisplayReview } from "../src/conversation/approval-display-review.js";
const binding = "a".repeat(64);
const input = { conversationId: "chat", generation: 0, proposalId: "proposal" };
function fixture() {
  const read = vi.fn(async (request: ConversationApprovalDisplayReviewInput): Promise<ConversationApprovalDisplayReview> => ({
    schemaVersion: 1, ...input, status: "ready", review: { binding, proposalBinding: "d".repeat(64), proposalVersion: 3, groupId: "chat", turnId: "turn",
      toolCallId: "tool", toolName: "send", argumentReference: `args-sha256-${"b".repeat(64)}`,
      text: request.offset ? "last" : "🙂".repeat(8192), offset: request.offset ?? 0, nextOffset: request.offset ? null : 8192 },
  }));
  const controller = new ConversationApprovalReview(input, read);
  const commit = vi.fn(async (_input: unknown, _signal: AbortSignal) => { void _input; void _signal; });
  return { controller, read, commit };
}
it("requires contiguous bounded sections and acknowledgement; revalidates binding before deciding", async () => {
  const f = fixture(); await f.controller.load(8192); expect(f.read).not.toHaveBeenCalled();
  await f.controller.load(); f.controller.acknowledge(true);
  await f.controller.decide("confirmed", f.commit); expect(f.commit).not.toHaveBeenCalled();
  await f.controller.next(); expect(f.controller.getSnapshot()).toMatchObject({ complete: true, section: { text: "last" } });
  expect(f.read.mock.calls.at(-1)?.[0]).toEqual({ ...input, binding, offset: 8192 });
  await f.controller.previous(); expect(f.controller.getSnapshot().section?.text).toHaveLength(16384);
  f.controller.acknowledge(true); await f.controller.decide("confirmed", f.commit);
  expect(f.read).toHaveBeenCalledTimes(4); expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.commit.mock.calls[0]?.[0]).toMatchObject({ proposalId: "proposal", expectedVersion: 3, status: "confirmed",
    idempotencyKey: "assistant:proposal:3:confirmed" });
  expect(f.controller.getSnapshot()).toMatchObject({ status: "decided", section: null });
  await f.controller.decide("confirmed", f.commit); expect(f.commit).toHaveBeenCalledTimes(1); f.controller.dispose();
});
it("fails closed on changed bindings and rejects malformed sections without retaining them", async () => {
  const f = fixture(); await f.controller.load(); await f.controller.next(); f.controller.acknowledge(true);
  f.read.mockRejectedValueOnce({ resourceCode: "content_changed" });
  await f.controller.decide("confirmed", f.commit);
  expect(f.controller.getSnapshot()).toMatchObject({ status: "error", error: "changed", section: null, acknowledged: false });
  expect(f.commit).not.toHaveBeenCalled();
  const normal = f.read.getMockImplementation()!;
  f.read.mockImplementationOnce(async request => {
    const response = await normal(request);
    return response.status === "ready" ? { ...response, review: { ...response.review, binding: "c".repeat(64) } } : response;
  });
  await f.controller.load(); expect(f.controller.getSnapshot()).toMatchObject({ status: "error", section: null });
  expect(f.read.mock.calls.at(-1)?.[0].binding).toBe(binding); f.controller.dispose();
});
it("retries an uncertain decision using the exact intent, without rereading an already decided proposal", async () => {
  const f = fixture(); await f.controller.load();
  f.commit.mockRejectedValueOnce(new Error("lost receipt"));
  await f.controller.decide("rejected", f.commit);
  expect(f.controller.getSnapshot()).toMatchObject({ error: "decision", decision: "rejected" });
  const count = f.read.mock.calls.length;
  await f.controller.decide("confirmed", f.commit); expect(f.commit).toHaveBeenCalledTimes(1);
  await f.controller.decide("rejected", f.commit);
  expect(f.commit.mock.calls[1]?.[0]).toBe(f.commit.mock.calls[0]?.[0]);
  expect(f.read).toHaveBeenCalledTimes(count); expect(f.controller.getSnapshot().status).toBe("decided"); f.controller.dispose();
});
it("deduplicates reads and prevents a late preflight from submitting after disposal", async () => {
  const f = fixture(); await f.controller.load();
  let release!: (value: ConversationApprovalDisplayReview) => void;
  const original = await f.read({ ...input, offset: 0 });
  f.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const decision = f.controller.decide("rejected", f.commit);
  expect(f.controller.decide("rejected", f.commit)).toBe(decision);
  await Promise.resolve(); f.controller.dispose(); release(original); await decision;
  expect(f.commit).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().section).toBeNull();
});
