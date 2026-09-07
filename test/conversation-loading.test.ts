import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConversationRuntime, InMemoryConversationEventStore, parseConversationEvent,
  replayConversation, type ConversationEventStore, type ConversationId,
  type ConversationTransport, type ReadConversationEventsInput,
} from "../src/index.js";

const conversationId = "loading-history" as ConversationId;
const transport = {} as ConversationTransport<unknown, unknown>;
const event = (revision: number, payload: unknown) => parseConversationEvent({
  version: 1, event_id: `loading-${revision}`, conversation_id: conversationId, revision,
  occurred_at: "2026-09-07T12:00:00.000Z", actor: { type: "assistant" }, source: { type: "runtime" }, payload,
});
function remoteStore(backing: InMemoryConversationEventStore) {
  const read = vi.fn((input: ReadConversationEventsInput) => backing.read(input));
  const getLatestRevision = vi.fn((id: ConversationId) => backing.getLatestRevision(id));
  const store: ConversationEventStore = { read, getLatestRevision, append: (input) => backing.append(input) };
  return { store, read, getLatestRevision };
}

afterEach(() => vi.useRealTimers());

describe("conversation history loading", () => {
  it("loads a 1166-event conversation once and subsequently fetches only its tail", async () => {
    const backing = new InMemoryConversationEventStore();
    const events = Array.from({ length: 1166 }, (_, index) => event(index + 1, index < 3 || index === 1165
      ? { type: "message.created", message_id: `message-${index === 1165 ? 3 : index}`, role: "assistant", content: [{ type: "text", text: "" }] }
      : { type: "message.text_appended", turn_id: "turn", message_id: "message-3", text: "x" }));
    await backing.append({ conversationId, expectedRevision: null, events });
    const remote = remoteStore(backing);
    const runtime = await createConversationRuntime({ conversationId, clientId: "test" as never,
      eventStore: remote.store, transport, replayBatchSize: 500 });
    try {
      expect(runtime.getSnapshot().messages).toHaveLength(4);
      expect(runtime.getSnapshot().messages[3]?.content).toEqual([{ type: "text", text: "x".repeat(1162) }]);
      expect(remote.getLatestRevision).not.toHaveBeenCalled();
      expect(remote.read).toHaveBeenCalledTimes(3);
      expect(remote.read.mock.calls.filter(([input]) => input.after === undefined)).toHaveLength(1);
      await backing.append({ conversationId, expectedRevision: events.at(-1)!.revision,
        events: [event(1167, { type: "message.text_appended", turn_id: "turn", message_id: "message-3", text: "new" })] });
      await runtime.synchronize!();
      expect(remote.read).toHaveBeenCalledTimes(4);
      expect(remote.read).toHaveBeenLastCalledWith(expect.objectContaining({ after: { revision: 1166 } }));
      expect(runtime.getSnapshot().revision).toBe(1167);
      expect(runtime.getSnapshot().messages[3]?.content).toEqual([{ type: "text", text: `${"x".repeat(1162)}new` }]);
    } finally { runtime.destroy(); }
  });

  it("continues validating the authoritative head without a preliminary revision request", async () => {
    const remote = remoteStore(new InMemoryConversationEventStore());
    remote.read.mockImplementation(async () => ({ entries: [], nextCursor: null, hasMore: false, latestRevision: 2 as never }));
    await expect(replayConversation({ conversationId, eventStore: remote.store })).rejects.toMatchObject({ code: "revision_gap" });
    expect(remote.getLatestRevision).not.toHaveBeenCalled();
  });

  it("backs off idle reads, resumes fast polling on activity, and stops after disposal", async () => {
    vi.useFakeTimers();
    const remote = remoteStore(new InMemoryConversationEventStore());
    const runtime = await createConversationRuntime({ conversationId, clientId: "test" as never,
      eventStore: remote.store, transport, synchronizationIntervalMilliseconds: 1000,
      idleSynchronizationIntervalMilliseconds: 15000 });
    try {
      remote.read.mockClear();
      await vi.advanceTimersByTimeAsync(15000);
      expect(remote.read).toHaveBeenCalledTimes(4); // 1s, 3s, 7s, 15s
      runtime.setSynchronizationActive!(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(remote.read).toHaveBeenCalledTimes(7); // Visible idle threads stay fresh.
      runtime.setSynchronizationActive!(false);
      await runtime.store.applyEvent(event(1, { type: "turn.started", turn_id: "active", input_message_ids: ["input"] }));
      remote.read.mockImplementation(async () => ({ entries: [], nextCursor: null, hasMore: false, latestRevision: 1 as never }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(remote.read).toHaveBeenCalledTimes(10);
    } finally { runtime.destroy(); }
    await vi.advanceTimersByTimeAsync(60000);
    expect(remote.read).toHaveBeenCalledTimes(10);
  });
});
