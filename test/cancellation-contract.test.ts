import { expect, it } from "vitest";
import { parseStreamEvent } from "../src/protocol.js";
import { conversationCancellationReason, protocolCancellationReason, signalCancellationReason } from "../src/cancellation.js";

it.each([["explicit_stop", "user"], ["deadline_exceeded", "timeout"], ["policy_revoked", "superseded"],
  ["runtime_shutdown", "runtime_shutdown"]] as const)("validates and translates %s without losing intent", (wire, canonical) => {
  const event = parseStreamEvent({ protocol_version: "handrail.ai-runtime.v1", request_id: "stop", trace_id: "trace",
    type: "response.cancelled", sequence: 1, reason: wire });
  expect(event).toMatchObject({ reason: wire });
  expect(conversationCancellationReason(wire)).toBe(canonical);
  expect(protocolCancellationReason(canonical)).toBe(wire);
  const controller = new AbortController(); controller.abort(wire);
  expect(signalCancellationReason(controller.signal)).toBe(wire);
});
it("rejects unsupported wire, canonical and abort reasons", () => {
  for (const reason of ["user", "new_unknown_reason", ""]) {
    expect(() => parseStreamEvent({ protocol_version: "handrail.ai-runtime.v1", request_id: "stop", trace_id: "trace",
      type: "response.cancelled", sequence: 1, reason })).toThrow();
    expect(() => conversationCancellationReason(reason as never)).toThrow();
  }
  expect(() => protocolCancellationReason("unknown" as never)).toThrow();
  const controller = new AbortController(); controller.abort("unknown");
  expect(() => signalCancellationReason(controller.signal)).toThrow();
});
