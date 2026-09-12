import { describe, expect, it, vi } from "vitest";
import {
  createBadResponseBugReporter, createBadResponseReportRequest, parseBadResponseReportReceipt,
} from "../src/index.js";

const request = createBadResponseReportRequest({ eventId: "event-1",
  conversationId: "conversation-1", messageId: "message-1", turnId: "turn-1" });
const receipt = { eventId: "event-1", bugId: "bug-1", classification: "bad_response", reviewStatus: "pending" };

describe("bad-response bug reporter adapter", () => {
  it("does not post ordinary bugs when the manual review queue is unavailable", async () => {
    const submit = vi.fn();
    const report = createBadResponseBugReporter({ reviewQueueAvailable: () => false,
      submit, resolveReceipt: (value) => value });
    await expect(report(request, { signal: new AbortController().signal })).rejects.toThrow("unavailable");
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses the Bug SDK submit shape, sends only references, and preserves the exact retry body", async () => {
    const submit = vi.fn<(...args: unknown[]) => Promise<{ receipt: typeof receipt }>>()
      .mockRejectedValueOnce(new Error("transport failed")).mockResolvedValue({ receipt });
    const report = createBadResponseBugReporter({ reviewQueueAvailable: () => true,
      submit, resolveReceipt: (result) => result.receipt });
    const options = { signal: new AbortController().signal };
    const untrustedExtras = { ...request, prompt: "private prompt", response: "private response",
      token: "private token", automationRequests: ["fix"] };
    await expect(report(untrustedExtras, options)).rejects.toThrow("transport failed");
    await expect(report(untrustedExtras, options)).resolves.toEqual(receipt);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    expect(submit.mock.calls[0]?.[0]).toEqual({ eventId: "event-1", title: "Bad assistant response",
      description: expect.any(String), metadata: { ai_response_feedback: {
        schema_version: 1, classification: "bad_response", conversation_id: "conversation-1",
        message_id: "message-1", turn_id: "turn-1", requested_review: "manual",
      } } });
    expect(JSON.stringify(submit.mock.calls)).not.toContain("private");
    expect(JSON.stringify(submit.mock.calls)).not.toContain("automationRequests");
  });

  it("does not submit after cancellation during readiness discovery", async () => {
    const controller = new AbortController();
    const submit = vi.fn();
    const report = createBadResponseBugReporter({ reviewQueueAvailable: () => { controller.abort(); return true; },
      submit, resolveReceipt: (value) => value });
    await expect(report(request, { signal: controller.signal })).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not claim review intake from a generic submitted result", async () => {
    const report = createBadResponseBugReporter({ reviewQueueAvailable: () => true,
      submit: async () => ({ status: "submitted", bugId: "bug-1" }), resolveReceipt: (value) => value });
    await expect(report(request, { signal: new AbortController().signal })).rejects.toThrow("receipt");
  });

  it.each([null, {}, { ...receipt, eventId: "different" }, { ...receipt, bugId: "" },
    { ...receipt, classification: "bug" }, { ...receipt, reviewStatus: "fixed" }])(
    "rejects a missing or mismatched receipt: %j", (value) => {
      expect(() => parseBadResponseReportReceipt(value, request)).toThrow();
    });

  it("accepts an authoritative receipt for an already verified report", () => {
    expect(parseBadResponseReportReceipt({ ...receipt, reviewStatus: "verified" }, request))
      .toEqual({ ...receipt, reviewStatus: "verified" });
  });

  it("generates a unique retry identity and rejects unbounded or malformed references", () => {
    const input = { conversationId: "conversation", messageId: "message" };
    const first = createBadResponseReportRequest(input);
    expect(first.eventId).not.toBe(createBadResponseReportRequest(input).eventId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.turnId).toBeNull();
    for (const messageId of ["", " ", "a\nb", "x".repeat(161)]) {
      expect(() => createBadResponseReportRequest({ ...input, messageId })).toThrow("reference");
    }
  });
});
