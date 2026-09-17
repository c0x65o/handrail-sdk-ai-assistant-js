import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { postgresFromClient, PostgresApprovalRecoveryQueue, type PostgresSqlClient } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext, type HandrailAssistantProvider } from "../src/server/assistant.js";
import { createApplicationTurnTransport } from "../src/transports/application-turn.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import type { ApplicationToolExecutor } from "../src/tools/executor.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { replayConversation } from "../src/conversation/replay.js";
import { createApprovalCoordinator } from "../src/conversation/approval-coordinator.js";
import { repairApprovalDecisionPage } from "../src/server/approval-recovery.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";

const database = new PGlite();
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    const result = await db.query<T>(sql, [...values]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) }; return client;
};
const sql: PostgresSqlClient = { query: adapt(database).query, transaction: operation =>
  database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const storage = postgresFromClient(sql);
beforeAll(() => storage.persistence.migrate(), 20_000);
afterAll(() => database.close());
const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const contextFor = (tenant: string): HandrailAssistantAuthorizationContext => ({ principalId: "owner", tenantId: tenant, scopeId: "owner",
  attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"), known_user: fact("owner"),
    session: fact("session"), automation: fact(null) } });
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };

it("commits wake-ups atomically, coalesces decisions, fences old claims and resumes expired leases", async () => {
  const queue = new PostgresApprovalRecoveryQueue(sql, "claims");
  await expect(sql.transaction(async tx => {
    await tx.query("SELECT handrail_ai_wake_approval_recovery('claims','chat')"); throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect((await queue.scan(25)).candidates).toEqual([]);
  await sql.query("SELECT handrail_ai_wake_approval_recovery('claims','chat')");
  const candidate = (await queue.scan(25)).candidates[0]!;
  const claim = (await queue.claim(candidate))!;
  expect(await new PostgresApprovalRecoveryQueue(sql, "claims").claim(candidate)).toBeNull();
  // An additional decision committed while this claim runs must survive its ack.
  await sql.query("SELECT handrail_ai_wake_approval_recovery('claims','chat')");
  await queue.finish(claim, true);
  const next = (await queue.scan(25)).candidates[0]!; expect(next.wakeId).not.toBe(candidate.wakeId);
  const abandoned = (await queue.claim(next))!;
  await sql.query("UPDATE handrail_ai_approval_recovery SET lease_until=now()-interval '1 second' WHERE tenant_id='claims'");
  const replacement = (await queue.claim((await queue.scan(25)).candidates[0]!))!;
  expect(await queue.renew(abandoned)).toBe(false);
  await queue.finish(abandoned, true);
  expect(await queue.renew(replacement)).toBe(true);
  await queue.finish(replacement, true);
  expect((await queue.scan(25)).candidates).toEqual([]);
  expect((await new PostgresApprovalRecoveryQueue(sql, "foreign").scan(25)).candidates).toEqual([]);
});

it("prepares legacy decision identities in bounded restartable pages without rewriting the saved proposals", async () => {
  await sql.query("ALTER TABLE handrail_ai_approvals DISABLE TRIGGER handrail_ai_approval_recovery_proposal_trigger");
  try {
    for (let i = 0; i < 28; i++) await sql.query(`INSERT INTO handrail_ai_approvals VALUES
      ('legacy','owner',$1,$2,2,$3::jsonb,now())`, [`p-${String(i).padStart(2, "0")}`, `chat-${i}`,
      JSON.stringify({ status: i % 2 ? "confirmed" : "pending", retained: "private-body".repeat(500) })]);
  } finally { await sql.query("ALTER TABLE handrail_ai_approvals ENABLE TRIGGER handrail_ai_approval_recovery_proposal_trigger"); }
  const before = await sql.query("SELECT proposal_id,version,payload,updated_at FROM handrail_ai_approvals WHERE tenant_id='legacy' ORDER BY proposal_id");
  await storage.persistence.migrate(); // Existing decisions + repeated DDL.
  await new PostgresApprovalRecoveryQueue(sql, "legacy").prepare(5);
  expect((await sql.query("SELECT conversation_id FROM handrail_ai_approval_recovery WHERE tenant_id='legacy'")).rows).toHaveLength(2);
  await new PostgresApprovalRecoveryQueue(sql, "legacy").prepare(5);
  expect((await sql.query("SELECT after_proposal FROM handrail_ai_approval_recovery_backfill WHERE tenant_id='legacy'")).rows[0])
    .toMatchObject({ after_proposal: "p-09" });
  for (let i = 0; i < 5; i++) await new PostgresApprovalRecoveryQueue(sql, "legacy").prepare(5);
  expect((await sql.query("SELECT conversation_id FROM handrail_ai_approval_recovery WHERE tenant_id='legacy'")).rows).toHaveLength(14);
  const page = await new PostgresApprovalRecoveryQueue(sql, "legacy").scan(25);
  expect(JSON.stringify(page)).not.toContain("private-body");
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4_096);
  expect(await sql.query("SELECT proposal_id,version,payload,updated_at FROM handrail_ai_approvals WHERE tenant_id='legacy' ORDER BY proposal_id")).toEqual(before);
});

it.each(["confirmed", "rejected"] as const)("recovers a %s decision saved before its audit event, without a browser or duplicate effect", async status => {
  const context = contextFor(`restart-${status}`), conversationId = "chat", turnId = "turn";
  const bundle = storage.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => conversationId as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
  const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Make the reviewed change" }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
  let revision = 0;
  const append = async (payload: unknown, mutation?: string) => {
    revision = (await bundle.events.getLatestRevision(conversationId as never) ?? 0) + 1;
    await bundle.events.append({ conversationId: conversationId as never, expectedRevision: revision === 1 ? null : revision - 1 as never,
      events: [parseConversationEvent({ version: 1, event_id: `seed-${revision}`, conversation_id: conversationId, revision,
        occurred_at: new Date().toISOString(), actor: { type: "system" }, source: { type: "runtime" },
        ...(mutation ? { mutation_id: mutation } : {}), payload })] });
  };
  await append({ type: "message.created", message_id: "input", role: "user", content: request.messages[0]!.content }, "admission");
  await append({ type: "turn.started", turn_id: turnId, input_message_ids: ["input"] });
  const effect = vi.fn(async () => ({ changed: true })), providerCalls = vi.fn();
  const call = { name: "change_record", tool_call_id: "call", arguments: { value: "reviewed" } };
  let runtime!: Parameters<HandrailAssistantProvider<HandrailAssistantAuthorizationContext>["createTransport"]>[0]["tools"];
  const make = (boot: boolean, authorized = context) => createHandrailAssistant({ id: "approval-restart", persistence: storage, authorize: () => authorized,
    ...(boot ? { recoveryContexts: () => [authorized] } : { recoverPendingOnContext: false }), attachmentCleanup: false,
    approvalPolicy: () => "require_approval",
    tools: [createToolPlugin<ApplicationToolExecutor<HandrailAssistantAuthorizationContext>, HandrailAssistantAuthorizationContext,
      HandrailAssistantAuthorizationContext, HandrailAssistantAuthorizationContext>({ pluginId: "restart", version: "1.0.0", displayName: "Restart",
      registrations: [{ definition: { name: call.name, description: "Change a record", input_schema: { type: "object" } }, executor: effect }],
      approvals: [{ toolName: call.name, mode: "policy", summarize: () => "Review the change" }] })],
    provider: { metadata: { provider_id: "fixture", model_id: "fixture", capabilities: { streaming: true, text: true, tool_calls: true,
      parallel_tool_calls: false, reasoning: false, document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null } }, createTransport(input) {
      runtime = input.tools;
      return createApplicationTurnTransport<StreamEvent, ChatRequest>({ async execute(_request, execution) {
        providerCalls();
        const result = await input.tools.awaitApproval({ conversationId, turnId, call, signal: execution.signal });
        expect(result).toMatchObject({ status: "completed", result: { is_error: status === "rejected" } });
        return { status: "completed", checkpoint };
      } });
    } },
  });
  const initial = await make(false);
  await initial.handle(new Request("https://assistant.test/capabilities"));
  const signal = new AbortController().signal;
  expect((await runtime.execute(call, signal, { conversationId, turnId })).status).toBe("external_approval_required");
  expect((await runtime.awaitApproval({ conversationId, turnId, call, signal })).status).toBe("external_approval_required");
  const proposal = (await bundle.approvals.listGroup({ permissionContext: context, groupId: conversationId as never }))[0]!;
  await append({ type: "turn.status_changed", turn_id: turnId, status: "waiting_for_approval" });
  await bundle.durableTurns.create({ schemaVersion: 1, conversationId, turnId, mutationId: "admission", idempotencyKey: "start",
    requestFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"), request, delegateTurnId: null,
    status: "waiting_for_approval", attempt: 1, events: [], terminal: { status: "waiting_for_approval", checkpoint, pendingToolCallIds: ["call"] },
    cancellation: null, lease: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await initial.stopBackgroundWorkers();
  const transition = { permissionContext: context, proposalId: proposal.proposal_id, expectedVersion: 1, status,
    idempotencyKey: "original-decision", idempotencyFingerprint: "original-decision", attribution: {
      actor: { type: "user" as const, id: "owner" as never }, source: { type: "runtime" as const } } };
  const receipt = await bundle.approvals.transition(transition); // Simulated crash before coordinator audit append.
  expect((await bundle.events.read({ conversationId: conversationId as never })).entries.some(entry =>
    entry.event.payload.type === "approval.proposal_status_changed")).toBe(false);
  const intruder = await make(true, { ...context, principalId: "intruder", scopeId: "intruder" });
  await intruder.recoverPending(); await intruder.stopBackgroundWorkers();
  expect(providerCalls).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled();
  expect((await bundle.durableTurns.load(conversationId, turnId))?.record).toMatchObject({ status: "waiting_for_approval", attempt: 1 });
  const restarted = await make(true), peer = await make(true);
  try {
    await vi.waitFor(async () => expect((await bundle.durableTurns.load(conversationId, turnId))?.record.status).toBe("completed"), { timeout: 10_000 });
    await Promise.all([restarted.recoverPending(), peer.recoverPending()]);
    expect(providerCalls).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledTimes(status === "confirmed" ? 1 : 0);
    expect(await bundle.approvals.transition(transition)).toEqual(receipt);
    const retry = await createApprovalCoordinator({ proposalStore: bundle.approvals, eventStore: bundle.events, authorize: () => "allow" })
      .decide({ ...transition, conversationId: conversationId as never, decision: status === "confirmed" ? "confirm" : "reject", signal });
    expect(retry).toMatchObject({ outcome: "accepted", eventStatus: "reconciled", eventId: "approval-decision:original-decision" });
    const canonical = await replayConversation({ conversationId: conversationId as never, eventStore: bundle.events });
    expect(canonical.state.replay_error).toBeNull(); canonical.store.destroy();
    const audit = (await bundle.events.read({ conversationId: conversationId as never })).entries.map(entry => entry.event);
    expect(audit.filter(event => event.event_id === "approval-decision:original-decision")).toHaveLength(1);
    expect(audit.find(event => event.event_id === "approval-decision:original-decision"))
      .toMatchObject({ actor: { type: "user", id: "owner" }, payload: { status, proposal_version: 2 } });
  } finally { await Promise.all([restarted.stopBackgroundWorkers(), peer.stopBackgroundWorkers()]); }
}, 20_000);

it("resumes a partially repaired audit after recreation, using a durable 25-proposal cursor", async () => {
  const context = contextFor("repair-pages"), conversationId = "chat";
  const bundle = storage.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => conversationId as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
  for (let i = 0; i < 28; i++) {
    const proposalId = `p-${String(i).padStart(3, "0")}` as never;
    const created = await bundle.approvals.create({ permissionContext: context, proposalId, groupId: conversationId as never,
      turnId: "turn" as never, toolCallId: `call-${i}` as never, toolName: "tool" as never,
      reviewedArguments: { type: "opaque_reference", argument_ref: `reference-${i}` as never },
      attribution: { actor: { type: "system" }, source: { type: "runtime" } },
      idempotencyKey: `create-${i}`, idempotencyFingerprint: `create-${i}` });
    await bundle.events.append({ conversationId: conversationId as never, expectedRevision: i ? i * 2 as never : null,
      events: [parseConversationEvent({ version: 1, event_id: `requested-${i}`, conversation_id: conversationId, revision: i * 2 + 1,
        occurred_at: created.created_at, actor: { type: "tool", id: "tool" }, source: { type: "runtime" },
        payload: { type: "tool_call.requested", turn_id: "turn", tool_call_id: `call-${i}`, name: "tool", arguments: {} } }),
      parseConversationEvent({ version: 1, event_id: `created-${i}`, conversation_id: conversationId, revision: i * 2 + 2,
        occurred_at: created.created_at, ...created.created_attribution, payload: { type: "approval.proposal_created",
          proposal_id: proposalId, group_id: conversationId, turn_id: "turn", tool_call_id: `call-${i}`, tool_name: "tool",
          reviewed_arguments: created.reviewed_arguments, proposal_version: 1, status: "pending", expires_at: null } })] });
    await bundle.approvals.transition({ permissionContext: context, proposalId, expectedVersion: 1, status: "confirmed",
      attribution: { actor: { type: "user", id: "owner" as never }, source: { type: "runtime" } },
      idempotencyKey: `decide-${i}`, idempotencyFingerprint: `decide-${i}` });
  }
  const queue = new PostgresApprovalRecoveryQueue(sql, context.tenantId);
  await queue.prepare(100);
  const first = (await queue.claim((await queue.scan(1)).candidates[0]!))!;
  const inputs = { context, events: bundle.events, proposals: bundle.approvals, signal: new AbortController().signal,
    authorize: async () => { await bundle.catalog.get({ authorizationContext: context, conversationId: conversationId as never }); } };
  const progress = await repairApprovalDecisionPage({ ...inputs, queue, claim: first });
  expect(progress).toEqual({ hasMore: true, afterProposal: "p-024" });
  await queue.finish(first, false, progress.afterProposal);
  await sql.query("UPDATE handrail_ai_approval_recovery SET available_at=now() WHERE tenant_id='repair-pages'");
  const recreated = new PostgresApprovalRecoveryQueue(sql, context.tenantId);
  const second = (await recreated.claim((await recreated.scan(1)).candidates[0]!))!;
  expect(second.afterProposal).toBe("p-024");
  expect(await repairApprovalDecisionPage({ ...inputs, queue: recreated, claim: second }))
    .toEqual({ hasMore: false, afterProposal: "p-027" });
  await recreated.finish(second, true);
  const canonical = await replayConversation({ eventStore: bundle.events, conversationId: conversationId as never });
  expect(canonical.state.approval_proposals).toHaveLength(28);
  expect(canonical.state.approval_proposals.every(proposal => proposal.status === "confirmed" && proposal.proposal_version === 2)).toBe(true);
  canonical.store.destroy();
  expect((await recreated.scan(1)).candidates).toEqual([]);
}, 20_000);
