import { createHash } from "node:crypto";
import { parseToolRecoverySummary, type ToolRecoverySummary } from "../tools/recovery.js";

/** Contains identifiers and fixed classification only. No arguments, prompts, errors, or business records. */
export interface ToolIncidentOccurrence {
  readonly occurrenceId: string;
  readonly toolName: string;
  readonly sdkVersion: string;
  readonly appVersion: string;
  readonly environment: string;
  readonly recovery: ToolRecoverySummary;
}
export interface ToolIncidentReport {
  readonly incidentId: string;
  readonly kind: "bug" | "enhancement";
  readonly title: string;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly appVersion: string;
}
export interface ToolIncidentRecord {
  readonly incidentId: string;
  readonly occurrences: number;
  readonly recoveredOccurrences: number;
  readonly latest: ToolIncidentOccurrence;
  /** Frozen submission body: every network retry has the same identity and payload. */
  readonly report: ToolIncidentReport | null;
  readonly receipt: { readonly reportId: string } | null;
  readonly deliveryAttempts: number;
  readonly nextAttemptAt: string;
  readonly repairRequestId: string | null;
}
export interface ToolIncidentStore {
  /** Atomically deduplicate occurrenceId and update one incident, scoped by the host's tenant/project. */
  record(occurrence: ToolIncidentOccurrence): Promise<ToolIncidentRecord>;
  pending(limit: number, now: string): Promise<readonly ToolIncidentRecord[]>;
  update(incidentId: string, update: (current: ToolIncidentRecord) => ToolIncidentRecord): Promise<void>;
}
export interface ToolIncidentReporter {
  /** Transport must honor idempotencyKey. Return an authoritative receipt, never a guessed success. */
  submit(report: ToolIncidentReport, signal: AbortSignal): Promise<{ readonly reportId: string }>;
}

async function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(run), stopped]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function token(value: string, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.:@/-]{1,160}$/.test(value)) throw new TypeError(`Invalid incident ${name}`);
  return value;
}
export function normalizeToolIncidentOccurrence(input: ToolIncidentOccurrence): ToolIncidentOccurrence {
  const recovery = parseToolRecoverySummary(input.recovery);
  if (!recovery) throw new TypeError("Invalid incident recovery receipt");
  return { occurrenceId: token(input.occurrenceId, "occurrenceId"), toolName: token(input.toolName, "toolName"),
    sdkVersion: token(input.sdkVersion, "sdkVersion"), appVersion: token(input.appVersion, "appVersion"),
    environment: token(input.environment, "environment"), recovery };
}
export function toolIncidentId(input: ToolIncidentOccurrence, scope = ""): string {
  return createHash("sha256").update(JSON.stringify([scope, input.environment, input.toolName, input.sdkVersion,
    input.appVersion, input.recovery.category, input.recovery.code])).digest("hex");
}

export function accumulateToolIncident(current: ToolIncidentRecord | null, value: ToolIncidentOccurrence, scope = ""): ToolIncidentRecord {
  const occurrence = normalizeToolIncidentOccurrence(value);
  const incidentId = toolIncidentId(occurrence, scope);
  if (current && current.incidentId !== incidentId) throw new TypeError("Incident identity changed");
  const count = (current?.occurrences ?? 0) + 1;
  const failure = occurrence.recovery;
  const expected = ["permission_denied", "cancelled", "business_rule"].includes(failure.category);
  const reportable = !expected && (failure.category === "bug" || failure.category === "missing_capability"
    || failure.status === "failed" && ["attempt_limit", "deadline", "unknown_outcome"].includes(failure.reason) || count >= 3);
  const report = current?.report ?? (reportable ? {
    incidentId,
    kind: failure.category === "missing_capability" ? "enhancement" as const : "bug" as const,
    title: `AI tool ${occurrence.toolName}: ${failure.code}`,
    description: `An AI tool operation requires investigation. This is diagnostic evidence, not a confirmed root cause.\nTool: ${occurrence.toolName}\nEnvironment: ${occurrence.environment}\nSDK: ${occurrence.sdkVersion}\nApplication: ${occurrence.appVersion}\nClassification: ${failure.category}/${failure.code}\nOutcome: ${failure.status}; reason: ${failure.reason}\nExecutions: ${failure.attempts}; failed attempts: ${failure.failedAttempts}\nOccurrences at intake: ${count}\nIncident: ${incidentId}\nReproduce with an authorized fixture, add a regression test, and validate a proposed fix before release. No business arguments or private records are included.`,
    idempotencyKey: `ai-tool-incident:${incidentId}`,
    appVersion: occurrence.appVersion,
  } : null);
  return { incidentId, occurrences: count, recoveredOccurrences: (current?.recoveredOccurrences ?? 0) + (failure.status === "recovered" ? 1 : 0),
    latest: occurrence, report, receipt: current?.receipt ?? null, deliveryAttempts: current?.deliveryAttempts ?? 0,
    nextAttemptAt: current?.nextAttemptAt ?? new Date(0).toISOString(), repairRequestId: current?.repairRequestId ?? null };
}

/** The owner opts into reporting/repair once in trusted host policy; model output cannot enable either. */
export function createToolIncidentDispatcher(options: {
  readonly store: ToolIncidentStore;
  readonly reporter: ToolIncidentReporter;
  readonly authorizeReporting: (incident: ToolIncidentRecord) => boolean | Promise<boolean>;
  /** Optional existing developer pipeline. Its implementation must honor this stable idempotency key. */
  readonly requestRepair?: (input: { incident: ToolIncidentRecord; idempotencyKey: string; signal: AbortSignal }) => Promise<{ requestId: string }>;
  readonly authorizeRepair?: (incident: ToolIncidentRecord) => boolean | Promise<boolean>;
}) {
  return { drain(signal: AbortSignal, limit = 10): Promise<{ delivered: number; deferred: number }> { return abortable(signal, async () => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError("Invalid incident drain limit");
    let delivered = 0;
    let deferred = 0;
    for (const pending of await options.store.pending(limit, new Date().toISOString())) {
      signal.throwIfAborted();
      if (!pending.report || !await options.authorizeReporting(pending)) { deferred++; continue; }
      signal.throwIfAborted();
      try {
        const receipt = pending.receipt ?? await options.reporter.submit(pending.report, signal);
        const reportId = token(receipt.reportId, "reportId");
        await options.store.update(pending.incidentId, (current) => ({ ...current, receipt: { reportId } }));
        if (!pending.receipt) delivered++;
        signal.throwIfAborted();
        if (!pending.repairRequestId && options.requestRepair && await options.authorizeRepair?.({ ...pending, receipt })) {
          signal.throwIfAborted();
          const repair = await options.requestRepair({ incident: { ...pending, receipt },
            idempotencyKey: `ai-tool-repair:${pending.incidentId}`, signal });
          const requestId = token(repair.requestId, "repairRequestId");
          await options.store.update(pending.incidentId, (current) => ({ ...current, repairRequestId: requestId }));
        }
        // Completed reports stay durable for grouping; no periodic resubmission or unbounded repair loop.
        await options.store.update(pending.incidentId, (current) => ({ ...current, nextAttemptAt: "9999-12-31T00:00:00.000Z" }));
      } catch {
        deferred++;
        await options.store.update(pending.incidentId, (current) => ({ ...current,
          deliveryAttempts: current.deliveryAttempts + 1,
          nextAttemptAt: current.deliveryAttempts >= 4 ? "9999-12-31T00:00:00.000Z"
            : new Date(Date.now() + 60_000 * 2 ** current.deliveryAttempts).toISOString() }));
      }
    }
    return { delivered, deferred };
  }); } };
}

/** Uses the existing Handrail feedback tools. No developer operation is substituted for a missing reporter. */
export function createMcpToolIncidentReporter(input: {
  readonly call: (name: string, arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  readonly resolveReceipt: (result: unknown, kind: "bug" | "enhancement") => string | null;
}): ToolIncidentReporter {
  return { async submit(report, signal) {
    const args = report.kind === "bug" ? { title: report.title, description: report.description,
      event_id: report.idempotencyKey, app_version: report.appVersion, impact: "moderate" }
      : { title: report.title, description: report.description, idempotency_key: report.idempotencyKey,
          external_conversation_id: report.incidentId, priority: "medium", context: { app_version: report.appVersion } };
    const result = await input.call(report.kind === "bug" ? "handrail_bug_reporter_v1_submit" : "handrail_enhancement_reporter_v1_submit", args, signal);
    const reportId = input.resolveReceipt(result, report.kind);
    if (!reportId) throw new Error("Incident reporter returned no verified receipt");
    return { reportId: token(reportId, "reportId") };
  } };
}
