import { describe, expect, it } from "vitest";
import { createApplicationTurnTransport } from "../src/transports/application-turn.js";
import type { ConversationTurnId } from "../src/conversation/events.js";

describe("createApplicationTurnTransport", () => {
  it("adapts application execution and cancels without owning replay", async () => {
    const transport = createApplicationTurnTransport<{ text: string }, { text: string }>({
      async execute(request, context) {
        expect(context.durableExecution).toBeUndefined();
        await context.emit({ text: request.text });
        return { status: "completed", checkpoint: { lastAppliedEventId: "event-1",
          lastAppliedCursor: "event-1", lastAppliedRevision: null } };
      },
    });
    const started = await transport.startTurn({ conversationId: "conversation-1",
      conversationTurnId: "turn-1" as ConversationTurnId, mutationId: "mutation-1",
      idempotencyKey: "start-1", request: { text: "hello" } });
    expect(started.ok).toBe(true); if (!started.ok) return;
    const events = []; for await (const event of started.value.observation.events) events.push(event);
    expect(events).toEqual([{ text: "hello" }]);
    await expect(started.value.observation.result).resolves.toMatchObject({ status: "completed" });
    await expect(transport.resumeTurn({ conversationId: "conversation-1", turnId: "turn-1",
      resumeFrom: { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null } }))
      .resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
