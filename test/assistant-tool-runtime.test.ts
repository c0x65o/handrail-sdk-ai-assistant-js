import { PGlite } from "@electric-sql/pglite";
import { PostgresAiPersistence, PostgresToolExecutionLedger, type PostgresSqlClient } from "../src/postgres/index.js";
import { expect, it, vi } from "vitest";
import { createAiApplication } from "../src/server/application.js";
import { createAssistantToolRuntime, assistantToolArgumentReference } from "../src/server/assistant.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import { InMemoryToolExecutionLedger, type ApplicationToolExecutor, type BoundedToolExecutorLimits, type ToolExecutionLedger } from "../src/tools/executor.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { createApprovalExecutionCoordinator } from "../src/tools/approval-execution.js";
import { createApprovalCoordinator } from "../src/conversation/approval-coordinator.js";

type Context = { scopeId: string; userId: string };
const context: Context = { scopeId: "household:user", userId: "user" };
const location = { conversationId: "conversation", turnId: "live-call-or-text-turn" };
const call = { name: "save", tool_call_id: "call", arguments: { value: "reviewed" } };
async function setup(required = false, limits?: Partial<BoundedToolExecutorLimits>, ledgerFactory?: () => ToolExecutionLedger) {
  const events = new InMemoryConversationEventStore();
  const proposals = new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" });
  const ledger = new InMemoryToolExecutionLedger();
  const effect = vi.fn<ApplicationToolExecutor<Context>>(async () => ({ type: "text" as const, text: "Saved backend result" }));
  const authorizeLocation = vi.fn(async (value: typeof location, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (value.conversationId !== location.conversationId || value.turnId !== location.turnId) throw new Error("Not owned or stale");
  });
  const create = async () => {
    const application = await createAiApplication({
      plugins: [createToolPlugin({ pluginId: "host", version: "1.0.0", displayName: "Host", registrations: [{
        definition: { name: "save", description: "Save", input_schema: { type: "object", properties: { value: { type: "string" } },
          required: ["value"], additionalProperties: false } }, executor: effect,
      }], approvals: [{ toolName: "save", mode: "policy", summarize: () => "Save reviewed change" }] })], installContext: context,
      policy: () => ({ outcome: "allow" }), approvalPolicy: () => required ? "require_approval" : "allow_without_approval",
      toolExecutionLedger: ledgerFactory?.() ?? ledger, ...(limits ? { executorLimits: limits } : {}),
      approvalCoordinator: createApprovalExecutionCoordinator<Context>({ proposalStore: proposals, eventStore: events,
        authorize: () => "allow", verifyArguments: ({ binding, reviewedArguments, arguments: args }) =>
          binding.type === "opaque_reference" && reviewedArguments.type === "opaque_reference" &&
          binding.argumentReference === reviewedArguments.argument_ref &&
          binding.argumentReference === assistantToolArgumentReference(args) ? "match" : "mismatch" }),
    });
    return createAssistantToolRuntime({ context, application, events, proposalStore: proposals, authorizeLocation });
  };
  const pendingProposal = async () => {
    let id: string | undefined;
    await vi.waitFor(async () => {
      const page = await events.read({ conversationId: location.conversationId as never });
      const event = page.entries.find(entry => entry.event.payload.type === "approval.proposal_created")?.event;
      if (event?.payload.type === "approval.proposal_created") id = event.payload.proposal_id;
      expect(id).toBeDefined();
    });
    return (await proposals.get({ permissionContext: context, proposalId: id as never }))!;
  };
  const decide = async (decision: "confirm" | "reject") => {
    const proposal = await pendingProposal();
    return createApprovalCoordinator({ proposalStore: proposals, eventStore: events, authorize: () => "allow" }).decide({
      permissionContext: context, conversationId: location.conversationId as never, proposalId: proposal.proposal_id,
      expectedVersion: proposal.proposal_version, decision, attribution: { actor: { type: "user", id: "user" as never }, source: { type: "runtime" } },
      idempotencyKey: `decide-${decision}`, idempotencyFingerprint: `decide-${decision}`, signal: new AbortController().signal,
    });
  };
  return { runtime: await create(), create, events, proposals, effect, authorizeLocation, pendingProposal, decide };
}

it("uses one native ledger identity across recreated runtime instances and rejects changed arguments", async () => {
  const h = await setup(); const signal = new AbortController().signal;
  const first = await h.runtime.execute(call, signal, location);
  expect(first).toMatchObject({ status: "completed", result: { is_error: false } });
  expect(await (await h.create()).execute({ ...call, arguments: { value: "reviewed" } }, signal, location)).toEqual(first);
  expect(h.effect).toHaveBeenCalledOnce();
  await expect(h.runtime.execute({ ...call, arguments: { value: "different" } }, signal, location)).rejects.toThrow(/identity conflicts/);
  expect(h.effect).toHaveBeenCalledOnce();
  const events = (await h.events.read({ conversationId: location.conversationId as never })).entries;
  expect(events.filter(entry => entry.event.payload.type === "tool_call.result_recorded")).toHaveLength(1);
  expect(events.some(entry => ["turn.started", "turn.completed", "message.created"].includes(entry.event.payload.type))).toBe(false);
});

it.each(["confirm", "reject"] as const)("waits on native %s and reuses retained decisions on recreation", async decision => {
  const h = await setup(true); const signal = new AbortController().signal;
  expect(await h.runtime.execute(call, signal, location)).toMatchObject({ status: "external_approval_required" });
  const waiting = h.runtime.awaitApproval({ ...location, call, signal });
  await h.pendingProposal(); expect(h.effect).not.toHaveBeenCalled();
  expect(await h.decide(decision)).toMatchObject({ outcome: "accepted" });
  const result = await waiting;
  expect(result).toMatchObject({ status: "completed", result: { is_error: decision === "reject" } });
  expect(h.effect).toHaveBeenCalledTimes(decision === "confirm" ? 1 : 0);
  expect(await (await h.create()).awaitApproval({ ...location, call, signal })).toEqual(result);
  expect(h.effect).toHaveBeenCalledTimes(decision === "confirm" ? 1 : 0);
});

it.each(["conversationId", "turnId"] as const)("refuses a foreign or stale %s before events or execution", async key => {
  const h = await setup(); const signal = new AbortController().signal;
  await expect(h.runtime.execute(call, signal, { ...location, [key]: "other" })).rejects.toThrow("Not owned or stale");
  expect(h.effect).not.toHaveBeenCalled();
  expect(await h.events.getLatestRevision(location.conversationId as never)).toBeNull();
});

it("refuses missing location and cancellation before producing activity or approval records", async () => {
  const h = await setup(true); const controller = new AbortController();
  await expect(h.runtime.execute(call, controller.signal)).rejects.toThrow("Saved tool execution location");
  controller.abort();
  await expect(h.runtime.awaitApproval({ ...location, call, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(h.effect).not.toHaveBeenCalled();
  expect(await h.events.getLatestRevision(location.conversationId as never)).toBeNull();
});

it("rechecks host access while waiting and refuses dispatch after access is revoked", async () => {
  const h = await setup(true); const signal = new AbortController().signal;
  expect(await h.runtime.execute(call, signal, location)).toMatchObject({ status: "external_approval_required" });
  const waiting = h.runtime.awaitApproval({ ...location, call, signal }).then(value => ({ value }), error => ({ error }));
  await h.pendingProposal(); h.authorizeLocation.mockRejectedValue(new Error("Revoked"));
  expect(await waiting).toMatchObject({ error: { message: "Revoked" } });
  expect(h.effect).not.toHaveBeenCalled();
  expect((await h.pendingProposal()).status).toBe("pending");
});

it("retains a backend receipt when cancellation arrives after mutation dispatch", async () => {
  const h = await setup(); const controller = new AbortController();
  h.effect.mockImplementation(async () => { controller.abort(); return { type: "text", text: "Saved backend result" }; });
  const result = await h.runtime.execute(call, controller.signal, location);
  expect(result).toMatchObject({ status: "completed", result: { is_error: false } });
  expect(await (await h.create()).execute(call, new AbortController().signal, location)).toEqual(result);
  expect(h.effect).toHaveBeenCalledOnce();
});

it("keeps an approved backend result and executed approval after caller cancellation", async () => {
  const h = await setup(true); const controller = new AbortController();
  expect(await h.runtime.execute(call, controller.signal, location)).toMatchObject({ status: "external_approval_required" });
  h.effect.mockImplementation(async (_args, execution) => {
    controller.abort(); expect(execution.signal.aborted).toBe(true);
    return { type: "text", text: "Saved backend result" };
  });
  const pending = h.runtime.awaitApproval({ ...location, call, signal: controller.signal });
  await h.decide("confirm");
  expect(await pending).toMatchObject({ status: "completed", result: { is_error: false } });
  expect((await h.pendingProposal()).status).toBe("executed");
  expect(await (await h.create()).awaitApproval({ ...location, call, signal: new AbortController().signal }))
    .toMatchObject({ status: "completed", result: { is_error: false } });
  expect(h.effect).toHaveBeenCalledOnce();
});

it("does not start queued work after caller cancellation when retaining dispatched results", async () => {
  const h = await setup(false, { maxConcurrency: 1 });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.effect.mockImplementationOnce(async () => { await hold; return { type: "text", text: "First result" }; });
  const first = h.runtime.execute(call, new AbortController().signal, location);
  await vi.waitFor(() => expect(h.effect).toHaveBeenCalledOnce());
  const controller = new AbortController();
  const second = h.runtime.execute({ ...call, tool_call_id: "queued" }, controller.signal, location);
  await vi.waitFor(async () => {
    const entries = (await h.events.read({ conversationId: location.conversationId as never })).entries;
    expect(entries.some(entry => entry.event.payload.type === "tool_call.started" && entry.event.payload.tool_call_id === "queued")).toBe(true);
  });
  controller.abort();
  expect(await second).toMatchObject({ status: "completed", result: { is_error: true } });
  release(); await first;
  expect(h.effect).toHaveBeenCalledOnce();
});

it("keeps a retained terminal approval result readable after its original expiry", async () => {
  const h = await setup(true); const signal = new AbortController().signal;
  await h.runtime.execute(call, signal, location);
  const waiting = h.runtime.awaitApproval({ ...location, call, signal });
  await h.decide("confirm"); const result = await waiting;
  const saved = await h.pendingProposal();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(saved.expires_at) + 1);
  try { expect(await (await h.create()).awaitApproval({ ...location, call, signal })).toEqual(result); }
  finally { clock.mockRestore(); }
  expect(h.effect).toHaveBeenCalledOnce();
  expect((await h.pendingProposal()).expires_at).toBe(saved.expires_at);
});

it("retains the existing deadline for an executor that ignores caller cancellation", async () => {
  vi.useFakeTimers();
  try {
    const h = await setup(false, { timeoutMs: 100 }); const controller = new AbortController();
    h.effect.mockImplementation(async () => { controller.abort(); return new Promise(() => {}); });
    const pending = h.runtime.execute(call, controller.signal, location);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: "completed", result: { is_error: true,
      content: [{ type: "text", text: "Tool execution timed out." }] } });
    expect(h.effect).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("reattaches an interrupted approval wait without inventing a terminal tool result", async () => {
  const h = await setup(true); const controller = new AbortController();
  await h.runtime.execute(call, controller.signal, location);
  const waiting = h.runtime.awaitApproval({ ...location, call, signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  const saved = await h.pendingProposal();
  controller.abort();
  expect(await waiting).toMatchObject({ error: { name: "AbortError" } });
  expect((await h.pendingProposal()).status).toBe("pending");
  expect((await h.events.read({ conversationId: location.conversationId as never })).entries
    .some(entry => entry.event.payload.type === "tool_call.result_recorded")).toBe(false);
  await h.decide("confirm");
  expect(await (await h.create()).awaitApproval({ ...location, call, signal: new AbortController().signal }))
    .toMatchObject({ status: "completed", result: { is_error: false } });
  expect((await h.pendingProposal()).expires_at).toBe(saved.expires_at);
  expect(h.effect).toHaveBeenCalledOnce();
});

it("concurrent approval observers share the original proposal, event and backend execution", async () => {
  const h = await setup(true); const signal = new AbortController().signal;
  await h.runtime.execute(call, signal, location);
  const second = await h.create();
  const waits = [h.runtime.awaitApproval({ ...location, call, signal }), second.awaitApproval({ ...location, call, signal })];
  await h.decide("confirm");
  const results = await Promise.all(waits);
  expect(results[0]).toMatchObject({ status: "completed", result: { is_error: false } });
  expect(results[1]).toEqual(results[0]);
  expect(h.effect).toHaveBeenCalledOnce();
  const entries = (await h.events.read({ conversationId: location.conversationId as never })).entries;
  expect(entries.filter(entry => entry.event.payload.type === "approval.proposal_created")).toHaveLength(1);
  expect(entries.filter(entry => entry.event.payload.type === "tool_call.result_recorded")).toHaveLength(1);
});


it("reuses an approved PostgreSQL receipt after recreating the application, ledger and runtime", async () => {
  const database = new PGlite();
  const adapt = (queryable: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await queryable.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      }, transaction: operation => operation(client),
    };
    return client;
  };
  const client: PostgresSqlClient = { query: adapt(database).query,
    transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
  try {
    await new PostgresAiPersistence(client).migrate();
    const h = await setup(true, undefined, () => new PostgresToolExecutionLedger(new PostgresAiPersistence(client), "tenant", context.scopeId));
    const signal = new AbortController().signal;
    expect(await h.runtime.execute(call, signal, location)).toMatchObject({ status: "external_approval_required" });
    const waiting = h.runtime.awaitApproval({ ...location, call, signal });
    await h.pendingProposal();
    expect(await h.decide("confirm")).toMatchObject({ outcome: "accepted" });
    const result = await waiting;
    expect(result).toMatchObject({ status: "completed", result: { is_error: false } });
    const restarted = await h.create();
    expect(await restarted.execute(call, signal, location)).toMatchObject({ status: "external_approval_required" });
    expect(await restarted.awaitApproval({ ...location, call, signal })).toEqual(result);
    expect(h.effect).toHaveBeenCalledOnce();
    const events = (await h.events.read({ conversationId: location.conversationId as never })).entries;
    expect(events.filter(entry => entry.event.payload.type === "tool_call.result_recorded")).toHaveLength(1);
    expect(await h.pendingProposal()).toMatchObject({ status: "executed", proposal_version: 4 });
  } finally { await database.close(); }
}, 30_000);
