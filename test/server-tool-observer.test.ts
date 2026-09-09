import { describe, expect, it, vi } from "vitest";
import { createToolActivityObserver } from "../src/server/tool-observer.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { replayConversation } from "../src/conversation/replay.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { projectToolActivity } from "../src/conversation/tool-activity.js";

describe("host tool execution observation", () => {
  it("replays explicit recovery receipts without clearing an unrelated failed lookup", async () => {
    const events = new InMemoryConversationEventStore();
    const observer = createToolActivityObserver({ events, report: async () => undefined });
    const input = { conversationId: "conversation", turnId: "turn", signal: new AbortController().signal,
      call: { tool_call_id: "recovered", name: "invoice.lookup", arguments: { private: "secret" } } };
    await observer.observe(input, async () => ({ value: "private invoice data", recovery: {
      type: "handrail.tool_recovery.v1", status: "recovered", attempts: 2, failedAttempts: 1,
      category: "not_found", code: "invoice_not_found", reason: "completed",
    } }));
    await observer.observe({ ...input, call: { ...input.call, tool_call_id: "failed" } }, async () => ({ value: "private error", isError: true }));
    await observer.observe({ ...input, call: { ...input.call, tool_call_id: "later" } }, async () => ({ value: "other invoice" }));
    const saved = await replayConversation({ conversationId: "conversation" as never, eventStore: events, checkpointPolicy: false });
    expect(projectToolActivity(saved.state)).toMatchObject({ total: 3, completed: 2, recovered: 1, failed: 1, failedAttempts: 1 });
    expect(JSON.stringify(saved.state)).not.toContain("private invoice data");
    expect(JSON.stringify(projectToolActivity(saved.state))).not.toContain("secret");
    saved.store.destroy();
  });
  it("records pending work before dispatch and stable results without storing private output", async () => {
    const events = new InMemoryConversationEventStore();
    const report = vi.fn(async () => undefined);
    const observer = createToolActivityObserver({ events, report });
    const input = { conversationId: "conversation", turnId: "turn", signal: new AbortController().signal,
      call: { tool_call_id: "call", name: "invoice.lookup", arguments: {} } };
    const value = { private: "invoice data" };
    const execute = vi.fn(async (progress: (update: { summary: string }) => Promise<void>) => {
      const saved = await replayConversation({ conversationId: "conversation" as never, eventStore: events, checkpointPolicy: false });
      expect(projectToolActivity(saved.state)).toMatchObject({ total: 1, running: 1 });
      saved.store.destroy();
      await progress({ summary: "Tracing previous invoices" });
      return { value };
    });
    await expect(observer.observe(input, execute)).resolves.toBe(value);
    // The host owns idempotent return values. Re-observation does not add tool rows.
    await observer.observe(input, async () => ({ value }));
    const saved = await replayConversation({ conversationId: "conversation" as never, eventStore: events, checkpointPolicy: false });
    expect(projectToolActivity(saved.state)).toMatchObject({ total: 1, completed: 1 });
    expect(JSON.stringify(saved.state)).not.toContain("invoice data");
    expect(report).toHaveBeenCalledWith("conversation", "turn", { summary: "Tracing previous invoices" });
    saved.store.destroy();
  });

  it("leaves a cancelled dispatch for authoritative cancellation instead of labelling it a failed tool", async () => {
    const events = new InMemoryConversationEventStore();
    const conversationId = "conversation" as never;
    const append = async (payload: object) => {
      const revision = await events.getLatestRevision(conversationId);
      await events.append({ conversationId, expectedRevision: revision, events: [parseConversationEvent({
        version: 1, conversation_id: conversationId, event_id: `event-${revision ?? 0}`, revision: (revision ?? 0) + 1,
        occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "system" }, source: { type: "runtime" }, payload,
      })] });
    };
    await append({ type: "turn.started", turn_id: "turn", input_message_ids: ["input"] });
    const controller = new AbortController();
    const observer = createToolActivityObserver({ events, report: async () => undefined });
    await expect(observer.observe({ conversationId, turnId: "turn", signal: controller.signal,
      call: { tool_call_id: "call", name: "lookup", arguments: {} } }, async () => {
        controller.abort(); throw new Error("Cancelled upstream");
      })).rejects.toThrow("Cancelled upstream");
    await append({ type: "turn.cancelled", turn_id: "turn", reason: "user" });
    const saved = await replayConversation({ conversationId, eventStore: events, checkpointPolicy: false });
    expect(projectToolActivity(saved.state)).toMatchObject({ total: 1, cancelled: 1, failed: 0 });
    saved.store.destroy();
  });

  it("records returned failures and blocks dispatch when cancelled or lifecycle persistence fails", async () => {
    const events = new InMemoryConversationEventStore();
    const observer = createToolActivityObserver({ events, report: async () => undefined });
    const input = { conversationId: "conversation", turnId: "turn", signal: new AbortController().signal,
      call: { tool_call_id: "call", name: "invoice.lookup", arguments: {} } };
    await observer.observe(input, async () => ({ value: "safe error", isError: true }));
    const saved = await replayConversation({ conversationId: "conversation" as never, eventStore: events, checkpointPolicy: false });
    expect(projectToolActivity(saved.state)).toMatchObject({ total: 1, failed: 1 });
    saved.store.destroy();
    const execute = vi.fn();
    await expect(observer.observe({ ...input, signal: AbortSignal.abort() }, execute)).rejects.toThrow();
    vi.spyOn(events, "append").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(observer.observe({ ...input, call: { ...input.call, tool_call_id: "next" } }, execute)).rejects.toThrow("storage unavailable");
    expect(execute).not.toHaveBeenCalled();
  });
});
