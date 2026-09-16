import { expect, it, vi } from "vitest";
import { createLiveConversationProjection } from "../src/server/live-conversation-projection.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { replayConversation } from "../src/conversation/replay.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type AuthoritativeAttribution, type StreamEvent } from "../src/protocol.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};
const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: "request", trace_id: "trace" };
const frames: StreamEvent[] = [
  { ...envelope, type: "response.started", sequence: 0, attribution },
  { ...envelope, type: "response.text.delta", sequence: 1, delta: "Visible while running" },
  { ...envelope, type: "response.completed", sequence: 2, outcome: "stop" },
];
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
async function fixture() {
  const events = new InMemoryConversationEventStore();
  let revoked = false;
  const authorize = vi.fn(async () => { if (revoked) throw new Error("Access revoked"); });
  await events.append({ conversationId: "chat" as never, expectedRevision: null, events: [
    { type: "message.created", message_id: "input", role: "user", content: [{ type: "text", text: "Question" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["input"] },
  ].map((payload, index) => parseConversationEvent({ version: 1, event_id: `seed-${index}`, conversation_id: "chat",
    revision: index + 1, occurred_at: "2026-09-16T00:00:00Z", actor: { type: "system" }, source: { type: "runtime" }, payload })) });
  const input = { conversationId: "chat", turnId: "turn", events, authorize };
  const state = async () => { const replay = await replayConversation({ conversationId: "chat" as never, eventStore: events });
    replay.store.destroy(); return replay.state; };
  return { input, state, revoke: () => { revoked = true; } };
}

it("saves incremental text before completion and verifies duplicate frames without appending them twice", async () => {
  const f = await fixture(), projection = (await createLiveConversationProjection(f.input))!;
  try {
    await projection.push(frames[0]!); await projection.push(frames[1]!);
    const running = await f.state();
    expect(running.active_turn_id).toBe("turn"); expect(running.turns[0]!.status).toBe("running");
    expect(running.messages.at(-1)?.content).toEqual([{ type: "text", text: "Visible while running" }]);
    await projection.push(frames[1]!); expect((await f.state()).revision).toBe(running.revision);
    await projection.push(frames[2]!);
    expect((await f.state()).active_turn_id).toBe("turn"); // terminal transport result is still authoritative
    expect(await projection.finish({ status: "completed", checkpoint })).toMatchObject({ status: "completed" });
    expect((await f.state()).turns[0]!.status).toBe("completed");
  } finally { await projection.disconnect(); }
});

it("restarts from retained frames after disconnect without duplicating canonical text", async () => {
  const f = await fixture(), first = (await createLiveConversationProjection(f.input))!;
  await first.push(frames[0]!); await first.push(frames[1]!); await first.disconnect();
  const restarted = (await createLiveConversationProjection(f.input))!;
  try {
    for (const frame of frames) await restarted.push(frame);
    await restarted.finish({ status: "completed", checkpoint });
    const state = await f.state();
    expect(state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
    expect(state.messages.at(-1)?.content).toEqual([{ type: "text", text: "Visible while running" }]);
  } finally { await restarted.disconnect(); }
});

it("shares canonical frame idempotency with another simultaneous projector", async () => {
  const f = await fixture();
  const first = (await createLiveConversationProjection(f.input))!, second = (await createLiveConversationProjection(f.input))!;
  try {
    for (const frame of frames) await Promise.all([first.push(frame), second.push(frame)]);
    await Promise.all([first.finish({ status: "completed", checkpoint }), second.finish({ status: "completed", checkpoint })]);
    const state = await f.state();
    expect(state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
    expect(state.messages.at(-1)?.content).toEqual([{ type: "text", text: "Visible while running" }]);
  } finally { await first.disconnect(); await second.disconnect(); }
});

it("reauthorizes writes and refuses to resurrect a turn after clear", async () => {
  const f = await fixture(), projection = (await createLiveConversationProjection(f.input))!;
  try {
    await projection.push(frames[0]!); f.revoke();
    await expect(projection.push(frames[1]!)).rejects.toThrow("Access revoked");
    expect((await f.state()).messages).toHaveLength(1);
  } finally { await projection.disconnect(); }
  const clear = await fixture(), old = (await createLiveConversationProjection(clear.input))!;
  try {
    await old.push(frames[0]!);
    const state = await clear.state();
    await clear.input.events.append({ conversationId: "chat" as never, expectedRevision: state.revision, events: [parseConversationEvent({
      version: 1, event_id: "clear", conversation_id: "chat", revision: state.revision! + 1,
      occurred_at: "2026-09-16T00:00:02Z", actor: { type: "system" }, source: { type: "runtime" },
      payload: { type: "conversation.cleared" },
    })] });
    await expect(old.push(frames[1]!)).rejects.toThrow();
    expect((await clear.state()).messages).toEqual([]);
  } finally { await old.disconnect(); }
});

it("rejects changed duplicate frames and never fabricates a provider execution", async () => {
  const f = await fixture(), projection = (await createLiveConversationProjection(f.input))!;
  try {
    await projection.push(frames[0]!); await projection.push(frames[1]!);
    await expect(projection.push({ ...envelope, type: "response.text.delta", sequence: 1, delta: "Changed" })).rejects.toThrow();
    expect((await f.state()).messages.at(-1)?.content).toEqual([{ type: "text", text: "Visible while running" }]);
    expect((await f.state()).active_turn_id).toBe("turn");
  } finally { await projection.disconnect(); }
});
