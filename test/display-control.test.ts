import { expect, it } from "vitest";
import { parseConversationDisplayControl } from "../src/conversation/display-control.js";

it("rejects missing, contradictory, future and oversized turn controls", () => {
  const turn = { turnId: "turn", status: "running", revision: 8, remoteMayStillBeRunning: true, error: null };
  const valid = { schemaVersion: 1, conversationId: "chat", status: "ready", generation: 0,
    revision: 8, canonicalRevision: 8, activeTurnId: "turn", activeTurn: turn, latestTurn: turn, requestedTurn: null };
  const input = { conversationId: "chat" };
  expect(parseConversationDisplayControl(valid, input)).toEqual(valid);
  for (const invalid of [
    { ...valid, hasPendingApprovals: "yes" },
    { ...valid, activeTurn: undefined }, { ...valid, activeTurn: null },
    { ...valid, activeTurn: { ...turn, revision: 9 } },
    { ...valid, activeTurn: { ...turn, status: "completed" } },
    { ...valid, status: "preparing" },
    { ...valid, activeTurn: { ...turn, error: { code: "err", message: "a".repeat(257), retryable: true, messageTruncated: true } } },
  ]) expect(() => parseConversationDisplayControl(invalid, input)).toThrow();
  expect(parseConversationDisplayControl({ ...valid, status: "preparing", activeTurn: null,
    latestTurn: null, requestedTurn: null }, input).status).toBe("preparing");
});

it("retains the optional bounded pending-approval indicator without inventing support on older servers", () => {
  const header = { schemaVersion: 1, conversationId: "chat", status: "ready", generation: 0,
    revision: 0, canonicalRevision: 0, activeTurnId: null, activeTurn: null, latestTurn: null, requestedTurn: null };
  expect(parseConversationDisplayControl(header, { conversationId: "chat" }).hasPendingApprovals).toBeUndefined();
  expect(parseConversationDisplayControl({ ...header, hasPendingApprovals: true }, { conversationId: "chat" }).hasPendingApprovals).toBe(true);
  expect(() => parseConversationDisplayControl({ ...header, status: "preparing", hasPendingApprovals: true }, { conversationId: "chat" })).toThrow();
});
