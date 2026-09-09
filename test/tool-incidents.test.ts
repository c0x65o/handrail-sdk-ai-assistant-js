import { afterEach, describe, expect, it, vi } from "vitest";
import { accumulateToolIncident, createMcpToolIncidentReporter, createToolIncidentDispatcher,
  type ToolIncidentOccurrence, type ToolIncidentRecord, type ToolIncidentStore } from "../src/server/tool-incidents.js";

const occurrence: ToolIncidentOccurrence = { occurrenceId: "one", toolName: "get_invoice_detail", sdkVersion: "0.2.22",
  appVersion: "1.0.0", environment: "production", recovery: { type: "handrail.tool_recovery.v1", status: "recovered",
    category: "not_found", code: "invoice_not_found", attempts: 2, failedAttempts: 1, reason: "completed" } };
function memory(initial: ToolIncidentRecord): ToolIncidentStore & { current(): ToolIncidentRecord } {
  let row = initial;
  return { current: () => row, async record(value) { row = accumulateToolIncident(row, value); return row; },
    async pending(_limit, now) { return row.report && row.nextAttemptAt <= now ? [row] : []; },
    async update(_id, update) { row = update(row); } };
}
function bug() { return accumulateToolIncident(null, { ...occurrence, recovery: {
  ...occurrence.recovery, status: "failed", category: "bug", reason: "terminal" } }); }
afterEach(() => vi.useRealTimers());

describe("tool failure feedback", () => {
  it("counts recovered failures, escalates recurrence, and freezes an idempotent redacted intake", () => {
    const first = accumulateToolIncident(null, occurrence);
    const second = accumulateToolIncident(first, { ...occurrence, occurrenceId: "two" });
    expect(second.report).toBeNull();
    const third = accumulateToolIncident(second, { ...occurrence, occurrenceId: "three",
      arguments: { invoice: "private" }, message: "secret" } as ToolIncidentOccurrence);
    expect(third).toMatchObject({ occurrences: 3, recoveredOccurrences: 3, report: { kind: "bug" } });
    const fourth = accumulateToolIncident(third, { ...occurrence, occurrenceId: "four" });
    expect(fourth.report).toEqual(third.report);
    expect(JSON.stringify(fourth)).not.toContain("secret");
    expect(JSON.stringify(fourth)).not.toContain('"arguments"');
    expect(accumulateToolIncident(null, { ...occurrence, recovery: { ...occurrence.recovery,
      category: "missing_capability", status: "failed", reason: "terminal" } }).report?.kind).toBe("enhancement");
  });

  it.each(["permission_denied", "business_rule", "cancelled"] as const)("never treats %s as a defect requiring repair", (category) => {
    let row: ToolIncidentRecord | null = null;
    for (let i = 0; i < 5; i++) row = accumulateToolIncident(row, { ...occurrence, occurrenceId: String(i),
      recovery: { ...occurrence.recovery, category, status: "failed", reason: "terminal" } });
    expect(row?.report).toBeNull();
  });

  it("retains a failed delivery across worker restart, then saves one receipt without creating code work", async () => {
    vi.useFakeTimers();
    const store = memory(bug());
    const submit = vi.fn().mockRejectedValueOnce(new Error("reporter unavailable")).mockResolvedValue({ reportId: "bug-1" });
    const requestRepair = vi.fn();
    const options = { store, reporter: { submit }, authorizeReporting: () => true, requestRepair };
    await createToolIncidentDispatcher(options).drain(new AbortController().signal);
    expect(store.current()).toMatchObject({ receipt: null, deliveryAttempts: 1 });
    await createToolIncidentDispatcher(options).drain(new AbortController().signal);
    expect(submit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await createToolIncidentDispatcher(options).drain(new AbortController().signal);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]![0]).toEqual(submit.mock.calls[1]![0]);
    expect(store.current().receipt).toEqual({ reportId: "bug-1" });
    expect(requestRepair).not.toHaveBeenCalled();
    await createToolIncidentDispatcher(options).drain(new AbortController().signal);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("requires host authorization for both reporting and a separately idempotent repair handoff", async () => {
    const store = memory(bug());
    const submit = vi.fn(async () => ({ reportId: "bug-1" }));
    const requestRepair = vi.fn(async () => ({ requestId: "repair-1" }));
    const options = { store, reporter: { submit }, requestRepair, authorizeRepair: () => true };
    await createToolIncidentDispatcher({ ...options, authorizeReporting: () => false }).drain(new AbortController().signal);
    expect(submit).not.toHaveBeenCalled();
    expect(requestRepair).not.toHaveBeenCalled();
    await createToolIncidentDispatcher({ ...options, authorizeReporting: () => true }).drain(new AbortController().signal);
    expect(requestRepair).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `ai-tool-repair:${store.current().incidentId}`, incident: expect.objectContaining({ receipt: { reportId: "bug-1" } }),
    }));
    expect(store.current().repairRequestId).toBe("repair-1");
  });

  it("bounds report retries and never accepts an empty remote receipt", async () => {
    vi.useFakeTimers();
    const store = memory(bug());
    const submit = vi.fn(async () => ({ reportId: "" }));
    const dispatcher = createToolIncidentDispatcher({ store, reporter: { submit }, authorizeReporting: () => true });
    for (let i = 0; i < 10; i++) {
      await dispatcher.drain(new AbortController().signal);
      vi.advanceTimersByTime(60 * 60_000);
    }
    expect(submit).toHaveBeenCalledTimes(5);
    expect(store.current()).toMatchObject({ receipt: null, deliveryAttempts: 5 });
  });
  it("returns on cancellation even if a storage adapter ignores the abort signal", async () => {
    const store = memory(bug());
    store.pending = async () => new Promise(() => undefined);
    const submit = vi.fn();
    const controller = new AbortController();
    const result = expect(createToolIncidentDispatcher({ store, reporter: { submit }, authorizeReporting: () => true })
      .drain(controller.signal)).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await result;
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps only diagnostic fields to the canonical MCP feedback tools", async () => {
    const call = vi.fn<(name: string, arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: "bug-1" });
    const reporter = createMcpToolIncidentReporter({ call, resolveReceipt: (value) => (value as { id: string }).id });
    const report = bug().report!;
    await expect(reporter.submit(report, new AbortController().signal)).resolves.toEqual({ reportId: "bug-1" });
    expect(call.mock.calls[0]).toEqual(["handrail_bug_reporter_v1_submit", {
      title: report.title, description: report.description, event_id: report.idempotencyKey,
      app_version: report.appVersion, impact: "moderate",
    }, expect.any(AbortSignal)]);
    await reporter.submit({ ...report, kind: "enhancement" }, new AbortController().signal);
    expect(call.mock.calls[1]?.[0]).toBe("handrail_enhancement_reporter_v1_submit");
    await expect(createMcpToolIncidentReporter({ call, resolveReceipt: () => null })
      .submit(report, new AbortController().signal)).rejects.toThrow("no verified receipt");
  });
});
