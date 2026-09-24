import { expect, it } from "vitest";
import { changeTurnApprovalMode } from "../src/server/turn-approval-mode.js";
import { InMemoryDurableApplicationTurnStore, type DurableApplicationTurnRecord } from "../src/transports/durable.js";
const record = (): DurableApplicationTurnRecord => ({ schemaVersion: 1, conversationId: "chat", turnId: "turn",
  mutationId: "start", idempotencyKey: "start", requestFingerprint: "original", request: { metadata: { handrail_approval_mode: "required" } },
  delegateTurnId: null, status: "running", attempt: 1, events: [], terminal: null, cancellation: null, lease: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
it("serializes conflicting changes, supports turning off, and cannot replay an old enable over it", async () => {
  const store = new InMemoryDurableApplicationTurnStore(); await store.create(record());
  const target = { conversationId: "chat", turnId: "turn" };
  const enable = { ...target, mode: "automatic" as const, expectedRevision: 0, mutationId: "enable" };
  expect(await changeTurnApprovalMode(enable, "alice", store)).toMatchObject({ mode: "automatic", revision: 1 });
  expect(await changeTurnApprovalMode(enable, "alice", store)).toMatchObject({ revision: 1 });
  await expect(changeTurnApprovalMode(enable, "bob", store)).rejects.toMatchObject({ code: "idempotency_conflict" });
  const results = await Promise.allSettled([
    changeTurnApprovalMode({ ...target, mode: "required", expectedRevision: 1, mutationId: "off" }, "alice", store),
    changeTurnApprovalMode({ ...target, mode: "automatic", expectedRevision: 1, mutationId: "on" }, "alice", store),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const current = await changeTurnApprovalMode(target, "alice", store);
  await changeTurnApprovalMode({ ...target, mode: "required", expectedRevision: current.revision, mutationId: "off-final" }, "alice", store);
  await expect(changeTurnApprovalMode(enable, "alice", store)).rejects.toMatchObject({ code: "version_conflict" });
  expect(await changeTurnApprovalMode(target, "alice", store)).toMatchObject({ mode: "required" });
  expect((await store.load("chat", "turn"))?.record.requestFingerprint).toBe("original");
  await expect(changeTurnApprovalMode({ ...enable, turnId: "other" }, "alice", store)).rejects.toMatchObject({ code: "not_found" });
});
it("does not change cancelled or completed work and rejects malformed writes", async () => {
  const store = new InMemoryDurableApplicationTurnStore(); await store.create({ ...record(), status: "completed" });
  expect(await changeTurnApprovalMode({ conversationId: "chat", turnId: "turn", mode: "automatic", expectedRevision: 0, mutationId: "late" }, "alice", store))
    .toEqual({ mode: "required", revision: 0, active: false });
  await expect(changeTurnApprovalMode({ conversationId: "chat", turnId: "turn", mode: "automatic" }, "alice", store))
    .rejects.toMatchObject({ code: "invalid_input" });
});
