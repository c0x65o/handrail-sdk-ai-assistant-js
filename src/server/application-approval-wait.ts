/** Observation of a host-owned action. Only the host confirmation endpoint executes it. */
export type ApplicationApprovalObservation<T> =
  | { readonly status: "pending" }
  | { readonly status: "settled"; readonly value: T };

export interface ApplicationApprovalWaitOptions<T> {
  readonly signal: AbortSignal;
  /** @deprecated Approval requests do not expire. Ignored. */
  readonly expiresAt?: number;
  /** Read authoritative domain state. Throw for missing, rejected, or failed actions. */
  readonly read: (signal: AbortSignal) => Promise<ApplicationApprovalObservation<T>>;
  readonly pollIntervalMs?: number;
}

export class ApplicationApprovalWaitExpiredError extends Error {
  constructor() {
    super("Approval waiting expired. Review the saved action before continuing.");
    this.name = "ApplicationApprovalWaitExpiredError";
  }
}

/**
 * @deprecated Provider turns must persist waiting_for_approval and return instead.
 * Explicitly abortable observation of an already-persisted host action. Does not
 * create, approve, execute, cancel, or retry mutations. Hosts must expose the
 * proposal before calling and retain their own authorization/execution ledger.
 * Ending observation does not revoke a proposal or undo an action in progress.
 */
export async function waitForApplicationApproval<T>(options: ApplicationApprovalWaitOptions<T>): Promise<T> {
  const interval = options.pollIntervalMs ?? 500;
  if (!Number.isInteger(interval) || interval < 10 || interval > 10_000) {
    throw new TypeError("Approval waiting requires a polling interval from 10 to 10000 ms");
  }
  options.signal.throwIfAborted();
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abortFromParent, { once: true });
  // One abort listener bounds both slow reads and idle polling. Losing reads
  // remain handled, but can never publish a late result or launch another poll.
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      const observation = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return options.read(controller.signal);
      }), aborted]);
      controller.signal.throwIfAborted();
      if (observation.status === "settled") return observation.value;
      await Promise.race([new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, interval); }), aborted]);
    }
  } finally {
    clearTimeout(pollTimer);
    options.signal.removeEventListener("abort", abortFromParent);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
