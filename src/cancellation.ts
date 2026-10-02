import type { CancellationReason } from "./protocol.js";
import type { ConversationTurnCancellationReason } from "./conversation/events.js";

/** Exact wire/canonical translations. Unknown reasons are protocol errors. */
export function conversationCancellationReason(reason: CancellationReason): ConversationTurnCancellationReason {
  switch (reason) {
    case "explicit_stop": return "user";
    case "deadline_exceeded": return "timeout";
    case "policy_revoked": return "superseded";
    case "runtime_shutdown": return "runtime_shutdown";
    default: throw new TypeError("Unsupported cancellation reason");
  }
}

export function protocolCancellationReason(reason: ConversationTurnCancellationReason): CancellationReason {
  switch (reason) {
    case "user": return "explicit_stop";
    case "timeout": return "deadline_exceeded";
    case "superseded": return "policy_revoked";
    case "runtime_shutdown": return "runtime_shutdown";
    default: throw new TypeError("Unsupported cancellation reason");
  }
}

/** Native aborts have no user intent. Typed transport aborts retain their cause. */
export function signalCancellationReason(signal: AbortSignal): CancellationReason {
  const reason: unknown = signal.reason;
  if (reason instanceof DOMException && reason.name === "AbortError") return "runtime_shutdown";
  if (reason instanceof Error && reason.name === "TimeoutError") return "deadline_exceeded";
  switch (reason) {
    case "explicit_stop":
    case "deadline_exceeded":
    case "policy_revoked":
    case "runtime_shutdown": return reason;
    default: throw new TypeError("Unsupported cancellation reason");
  }
}
