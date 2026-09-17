import assert from "node:assert/strict";
import test from "node:test";
import { FEEDBACK_TOOL_NAMES, qualificationFixture, withQualificationAssistant } from "../examples/feedback-contract-qualification.mjs";

for (const kind of ["bug", "enhancement"]) {
  test(`${kind}: actual ToolPlugin dispatch, exact replay, conflicting retry and redacted receipt`, async () => {
    const fixture = qualificationFixture();
    await withQualificationAssistant(fixture, async ({ invoke, diagnostics }) => {
      const first = await invoke(kind);
      assert.equal(first.result.is_error, false);
      assert.deepEqual(await invoke(kind), first);
      assert.equal(fixture.observations.posts.length, 1);
      assert.equal((await invoke(kind, { arguments: { title: "Changed intent" } })).result.is_error, true);
      assert.equal(fixture.observations.posts.length, 1);
      assert.doesNotMatch(JSON.stringify({ first, diagnostics }), /synthetic-session|synthetic-bug-token|synthetic-enhancement-token/);
    });
    assert.equal(fixture.observations.closed, 1);
  });
  test(`${kind}: current authorization and cross-user replay fail closed`, async () => {
    const fixture = qualificationFixture();
    await withQualificationAssistant(fixture, async ({ invoke }) => {
      assert.equal((await invoke(kind)).result.is_error, false);
      fixture.controls.authorized = false;
      assert.equal((await invoke(kind)).result.is_error, true);
      fixture.controls.authorized = true;
      assert.equal((await invoke(kind, { context: { actor: "fixture-bob" } })).result.is_error, true);
      assert.equal(fixture.observations.posts.length, 1);
    });
    assert.equal(fixture.observations.closed, 1);
  });
  test(`${kind}: remote errors and invalid receipts never produce success`, async () => {
    for (const failure of ["remoteError", "invalidReceipt"]) {
      const fixture = qualificationFixture({ [failure]: true });
      await withQualificationAssistant(fixture, async ({ invoke }) => {
        assert.equal((await invoke(kind)).result.is_error, true);
        assert.equal(fixture.observations.posts.length, 1, "failure reached the actual connector HTTP boundary");
      });
      assert.equal(fixture.observations.closed, 1);
    }
  });
}

test("independent disabled reporters expose no corresponding submission tool", async () => {
  for (const [bug, enhancement] of [[false, false], [true, false], [false, true]]) {
    const fixture = qualificationFixture();
    await withQualificationAssistant(fixture, async ({ app, context }) => {
      const names = app.discover({ context }).map(tool => tool.name);
      assert.equal(names.includes(FEEDBACK_TOOL_NAMES.bugSubmit), bug);
      assert.equal(names.includes(FEEDBACK_TOOL_NAMES.enhancementSubmit), enhancement);
    }, { bug, enhancement });
    assert.equal(fixture.observations.closed, 1);
  }
});

test("separate users get separate identity-bearing connections", async () => {
  const alice = qualificationFixture(), bob = qualificationFixture({ actor: "fixture-bob" });
  await Promise.all([alice, bob].map(fixture => withQualificationAssistant(fixture, async ({ invoke }) => {
    assert.equal((await invoke("bug")).result.is_error, false);
  })));
  assert.notEqual(alice.observations.sessions[0], bob.observations.sessions[0]);
  assert.notEqual(alice.observations.posts[0].event_id, bob.observations.posts[0].event_id);
  assert.equal(alice.observations.closed, 1);
  assert.equal(bob.observations.closed, 1);
});

test("pre-dispatch cancellation sends no intake and closes the connection", async () => {
  const fixture = qualificationFixture();
  await withQualificationAssistant(fixture, async ({ invoke }) => {
    const controller = new AbortController(); controller.abort();
    assert.equal((await invoke("bug", { signal: controller.signal })).result.is_error, true);
    assert.equal(fixture.observations.posts.length, 0);
  });
  assert.equal(fixture.observations.closed, 1);
});

// Contract fixture only. This does not execute or qualify the actual platform repair.
test("source-derived v1 enhancement lookup fixture succeeds through the supported connector", async () => {
  await withQualificationAssistant(qualificationFixture(), async ({ session }) => {
    const result = await session.callTool({ name: FEEDBACK_TOOL_NAMES.enhancementLookup,
      arguments: { request_id: "fixture-enhancement" }, toolCallId: "fixture-readback" });
    assert.notEqual(result.isError, true, "v1 fixture must be compatible");
    assert.equal(result.structuredContent.id, "fixture-enhancement");
  });
});

 test("historical unversioned enhancement lookup is rejected", async () => {
  await withQualificationAssistant(qualificationFixture({ unversionedLookup: true }), async ({ session }) => {
    const result = await session.callTool({ name: FEEDBACK_TOOL_NAMES.enhancementLookup,
      arguments: { request_id: "fixture-enhancement" }, toolCallId: "historical-readback" });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /feedback_transport_contract_mismatch/);
  });
});
