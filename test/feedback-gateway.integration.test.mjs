import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { postgresFromClient } from "../dist/postgres/index.js";
import { createFeedbackTools, createAiApplication, FEEDBACK_SUBMIT_TOOLS } from "../dist/server/application.js";
import { parseConversationEvent } from "../dist/conversation/events.js";
import { openaiResponses } from "../dist/server/assistant.js";
import { createFeedbackGateway, openFeedbackSession } from "../examples/trusted-server-feedback.mjs";
import { qualificationFixture } from "../examples/feedback-contract-qualification.mjs";

const fact = id => ({ id, source: "server_derived", trust: "authoritative" });
const context = { principalId: "alice", tenantId: "tenant", scopeId: "alice", attribution: {
  organization: fact("org"), project: fact("project"), service_environment: fact("dev"),
  known_user: fact("alice"), session: fact(null), automation: fact(null),
} };
const location = { conversationId: "conversation", turnId: "turn" };
const secretPattern = /synthetic-session|synthetic-bug-token|synthetic-enhancement-token|raw-session-sentinel/;
const waitFor = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error("Fixture condition did not settle"); };

async function fixture() {
  const database = new PGlite();
  const adapt = db => ({ query: async (sql, values) => { const result = await db.query(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; }, transaction: fn => fn(adapt(db)) });
  const persistence = postgresFromClient({ query: adapt(database).query, transaction: fn => database.transaction(tx => fn(adapt(tx))) });
  await persistence.persistence.migrate();
  const http = qualificationFixture();
  const controls = { allowed: true, principal: "alice", session: true, bug: true, enhancement: true, intent: "durable-user-message" };
  const observed = { opened: 0, closed: 0, contexts: [], diagnostics: [] };
  const host = {
    resolveCurrent: async caller => {
      if (!controls.allowed || !controls.session || controls.principal !== caller.principalId) return null;
      return { principalId: controls.principal, tenantId: caller.tenantId, scopeId: caller.scopeId,
        sessionToken: `synthetic-session-${controls.principal}`, feedbackConfig: { fetch: (...args) => http.fetch(...args),
          bug: { enabled: controls.bug, apiBaseUrl: "https://feedback.invalid/api", projectId: "fixture-project",
            environment: "dev", serviceEnvId: "fixture-runtime", reportToken: "synthetic-bug-token", transport: "server" },
          enhancement: { enabled: controls.enhancement, apiUrl: "https://feedback.invalid/api/enhancement-reporting/v1",
            projectId: "fixture-project", capabilityId: "fixture-capability", serviceEnvId: "fixture-runtime",
            token: "synthetic-enhancement-token", contractVersion: "v1" },
        } };
    },
  };
  const options = { persistence: persistence.persistence, binding: "fixture-project/dev/fixture-runtime",
    enabled: kind => controls[kind], authorize: async caller => controls.allowed && caller.principalId === controls.principal,
    resolveIntent: async () => controls.intent,
    openSession: async (caller, signal) => {
      observed.contexts.push(caller);
      const session = await openFeedbackSession(host, caller, signal); observed.opened++;
      let closed = false;
      return { ...session, close: async () => { if (!closed) { closed = true; observed.closed++; } await session.close(); } };
    },
  };
  const create = async (caller = context) => {
    const support = createFeedbackTools(options);
    const registrations = await support.plugin.registrations(caller);
    return { ...support, registrations, invoke: async (kind, args = { title: `DEV QA fixture ${kind}`, description: "Offline only" }, signal = new AbortController().signal) => {
      const registration = registrations.find(r => r.definition.name === FEEDBACK_SUBMIT_TOOLS[kind]);
      assert.ok(registration);
      return registration.executor(args, { applicationContext: caller, location, definition: registration.definition,
        signal, toolCallId: "provider-local-call" });
    } };
  };
  const dump = async () => JSON.stringify({ documents: (await database.query("SELECT * FROM handrail_ai_documents")).rows,
    ledger: (await database.query("SELECT * FROM handrail_ai_tool_ledger")).rows,
    events: (await database.query("SELECT * FROM handrail_ai_events")).rows });
  return { database, persistence, http, controls, observed, host, options, create, dump };
}

for (const kind of ["bug", "enhancement"]) {
  test(`${kind}: durable stable intent, changed payload conflict, isolation, admission and cleanup`, async () => {
    const f = await fixture();
    try {
      const support = await f.create();
      const app = await createAiApplication({ plugins: [support.plugin], installContext: context,
        policy: () => ({ outcome: "allow" }), toolAdmission: support.admission });
      const call = { name: FEEDBACK_SUBMIT_TOOLS[kind], tool_call_id: "provider-call", arguments: { title: "DEV QA", description: "Offline" } };
      const input = { call, applicationContext: context, location, discovery: { context } };
      assert.equal((await app.executeTool(input)).status, "external_approval_required");
      assert.equal(f.http.observations.posts.length, 0);
      const beforeCancellation = new AbortController(); beforeCancellation.abort();
      await assert.rejects(support.invoke(kind, undefined, beforeCancellation.signal));
      assert.equal(f.http.observations.posts.length, 0);
      const first = await support.invoke(kind);
      if (kind === "enhancement") {
        assert.deepEqual(await support.reconcile(context, location, kind, new AbortController().signal), first);
        f.http.controls.unversionedLookup = true;
        await assert.rejects(support.reconcile(context, location, kind, new AbortController().signal), /did not verify/);
        f.http.controls.unversionedLookup = false;
      } else await assert.rejects(support.reconcile(context, location, kind, new AbortController().signal), /bug lookup receipt schema/);
      assert.deepEqual(await (await f.create()).invoke(kind), first, "new process-local plugin reuses SQL receipt");
      assert.equal(f.http.observations.posts.length, 1);
      await assert.rejects((await f.create()).invoke(kind, { title: "Changed", description: "Offline" }), /already bound/);
      f.controls.allowed = false;
      assert.equal((await app.executeTool(input)).result.is_error, true);
      await assert.rejects(support.invoke(kind), /Current access/);
      f.controls.allowed = true;
      f.controls[kind] = false;
      assert.equal((await app.executeTool(input)).result.is_error, true);
      assert.ok(!(await f.create()).registrations.some(r => r.definition.name === call.name));
      const other = kind === "bug" ? "enhancement" : "bug";
      f.controls[other] = false;
      assert.deepEqual((await f.create()).registrations, []);
      f.controls[other] = true;
      f.controls[kind] = true;
      f.controls.session = false;
      assert.deepEqual((await f.create()).registrations, []);
      assert.equal((await app.executeTool(input)).result.is_error, true);
      f.controls.session = true;
      f.controls[kind] = true;
      const bob = { ...context, principalId: "bob", scopeId: "bob" };
      assert.deepEqual(app.discover({ context: bob }), []);
      f.controls.principal = "bob";
      await (await f.create(bob)).invoke(kind);
      assert.equal(f.http.observations.posts.length, 2);
      const identity = kind === "bug" ? "event_id" : "idempotency_key";
      assert.notEqual(f.http.observations.posts[0][identity], f.http.observations.posts[1][identity]);
      assert.doesNotMatch(await f.dump(), secretPattern);
      assert.doesNotMatch(JSON.stringify(f.observed.contexts), secretPattern);
      assert.equal(f.observed.opened, f.observed.closed);
    } finally { await f.database.close(); }
  });

  for (const mode of ["invalid", "lost", "cancel", "timeout"]) test(`${kind}: ${mode} preserves uncertain SQL admission and never redispatches`, async () => {
    const f = await fixture();
    try {
      const support = await f.create();
      const controller = new AbortController();
      const fetch = f.http.fetch;
      let httpSignal, release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const dispatched = new Promise(resolve => { started = resolve; });
      f.http.fetch = async (url, init) => {
        if (init.method !== "POST") return fetch(url, init);
        httpSignal = init.signal;
        if (mode === "invalid") f.http.controls.invalidReceipt = true;
        const result = await fetch(url, init); // synthetic remote acceptance precedes response loss
        started();
        if (["cancel", "timeout"].includes(mode)) await gate;
        if (mode === "lost") throw new Error("raw-session-sentinel transport failure");
        return result;
      };
      const pending = support.invoke(kind, undefined, mode === "timeout" ? AbortSignal.timeout(100) : controller.signal);
      if (mode === "cancel") { await dispatched; controller.abort(); }
      await assert.rejects(pending, error => {
        assert.doesNotMatch(String(error), secretPattern); return true;
      });
      if (["cancel", "timeout"].includes(mode)) { assert.equal(httpSignal.aborted, false); release(); }
      const resumed = await f.create();
      await assert.rejects(resumed.invoke(kind), /authoritative intent-to-report lookup is required/);
      await assert.rejects(resumed.reconcile(context, location, kind, new AbortController().signal), /intent-to-report lookup is required/);
      assert.equal(f.http.observations.posts.length, 1);
      const claims = (await f.database.query("SELECT payload FROM handrail_ai_documents WHERE kind='tool_execution' AND scope_id='tool'")).rows;
      assert.equal(claims.length, 1); assert.equal(claims[0].payload.status, "admitted");
      assert.equal((await f.database.query("SELECT * FROM handrail_ai_tool_ledger")).rows.length, 0);
      assert.doesNotMatch(await f.dump(), secretPattern);
      assert.equal(f.observed.opened, f.observed.closed);
    } finally { await f.database.close(); }
  });
}

for (const kind of ["bug", "enhancement"]) test(`${kind}: exact gateway factory, provider tool loop, durable approval and sanitized receipt (fixtures only)`, async () => {
  const f = await fixture();
  let assistant;
  try {
    const providerInputs = [], diagnostics = [];
    const request = async function* (body) {
      providerInputs.push(body);
      if (providerInputs.length === 1) {
        yield { type: "response.output_item.added", output_index: 0,
          item: { type: "function_call", id: "fc", call_id: "feedback-call", name: FEEDBACK_SUBMIT_TOOLS[kind], arguments: "" } };
        yield { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc",
          arguments: JSON.stringify({ title: `DEV QA fixture ${kind}`, description: "Offline contract check" }) };
      } else yield { type: "response.output_text.delta", delta: "Feedback receipt recorded." };
      yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
    };
    assistant = await createFeedbackGateway({ ...f.host, feedback: f.options, assistant: {
      id: "feedback-fixture", persistence: f.persistence, authorize: () => ({ ...context, rawSession: "raw-session-sentinel" }),
      authorizeConversation: input => input.authorizationContext.principalId === "alice" ? "allow" : "deny",
      authorizeApproval: () => "allow",
      automaticTitles: false, attachmentCleanup: false, recoverPendingOnContext: false,
      provider: openaiResponses({ model: "offline-fixture", request, supportsToolSearch: false }), diagnostics: e => diagnostics.push(e),
    } });
    const bundle = f.persistence.forScope(context, { createConversationId: () => location.conversationId,
      authorizeConversation: () => "allow", authorizeApproval: () => "allow" });
    await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" });
    await bundle.events.append({ conversationId: location.conversationId, expectedRevision: null, events: [
      { type: "message.created", message_id: "message", role: "user", content: [{ type: "text", text: `DEV QA fixture: please report this ${kind}.` }] },
      { type: "turn.started", turn_id: location.turnId, input_message_ids: ["message"] },
    ].map((payload, index) => parseConversationEvent({ version: 1, event_id: `event-${index}`, conversation_id: location.conversationId,
      revision: index + 1, occurred_at: new Date().toISOString(), actor: { type: "user", id: "alice" }, source: { type: "sync" },
      ...(index === 0 ? { mutation_id: "message" } : {}), payload })) });
    const post = (path, value) => assistant.handle(new Request(`https://fixture.invalid/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
    const response = await post("turns/start", { conversationId: location.conversationId, conversationTurnId: location.turnId,
      mutationId: "message", idempotencyKey: "start", request: { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
        messages: [{ role: "user", content: [{ type: "text", text: `DEV QA fixture: please report this ${kind}.` }] }],
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} } });
    assert.equal(response.status, 200);
    const output = response.text();
    let proposal;
    await waitFor(async () => { proposal = (await bundle.approvals.listGroup({ permissionContext: context, groupId: location.conversationId }))[0]; return proposal; });
    assert.equal(f.http.observations.posts.length, 0, "provider cannot bypass approval");
    const decision = await post("approvals/transition", { conversationId: location.conversationId, proposalId: proposal.proposal_id,
      expectedVersion: 1, status: "confirmed", idempotencyKey: "confirm", idempotencyFingerprint: "confirm" });
    assert.equal(decision.status, 200);
    const clientEvents = await output;
    await waitFor(() => f.http.observations.posts.length === 1 && providerInputs.length === 2);
    assert.match(JSON.stringify(providerInputs), /fixture-(bug|enhancement)/);
    assert.doesNotMatch(JSON.stringify({ providerInputs, clientEvents, diagnostics }), secretPattern);
    assert.doesNotMatch(await f.dump(), secretPattern);
    assert.ok(providerInputs[0].tools.every(tool => !JSON.stringify(tool).includes("idempotency_key") && !JSON.stringify(tool).includes("event_id")));
  } finally { await assistant?.stopBackgroundWorkers(); await f.database.close(); }
});
