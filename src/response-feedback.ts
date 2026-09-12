/** Reference-only feedback. The host resolves authorized conversation evidence on the server. */
export interface BadResponseReportRequest {
  readonly eventId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly turnId: string | null;
}

/** A bug ID alone does not prove the report entered the manual review queue. */
export interface BadResponseReportReceipt {
  readonly eventId: string;
  readonly bugId: string;
  readonly classification: "bad_response";
  readonly reviewStatus: "pending" | "verified";
}

export type BadResponseReporter = (
  request: BadResponseReportRequest,
  options: { readonly signal: AbortSignal },
) => Promise<BadResponseReportReceipt>;

export interface BadResponseReportingOptions {
  /** Explicit opt-in. Enable only after the host supports manual bad-response intake. */
  readonly enabled: boolean;
  readonly report: BadResponseReporter;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160
    || value.trim() !== value || Array.from(value).some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError("Invalid bad-response reference");
  }
  return value;
}

/** Reuse the returned request unchanged on retry; do not persist it across account changes. */
export function createBadResponseReportRequest(input: {
  readonly conversationId: string;
  readonly messageId: string;
  readonly turnId?: string | null;
  readonly eventId?: string;
}): BadResponseReportRequest {
  return Object.freeze({
    eventId: identifier(input.eventId ?? globalThis.crypto.randomUUID()),
    conversationId: identifier(input.conversationId),
    messageId: identifier(input.messageId),
    turnId: input.turnId == null ? null : identifier(input.turnId),
  });
}

export function parseBadResponseReportReceipt(
  value: unknown, request: BadResponseReportRequest,
): BadResponseReportReceipt {
  if (!value || typeof value !== "object") throw new TypeError("Bad-response review receipt is unavailable");
  const receipt = value as Record<string, unknown>;
  if (receipt.eventId !== request.eventId || receipt.classification !== "bad_response"
    || (receipt.reviewStatus !== "pending" && receipt.reviewStatus !== "verified")) {
    throw new TypeError("Bad-response review receipt is unavailable");
  }
  return Object.freeze({ eventId: request.eventId, bugId: identifier(receipt.bugId),
    classification: "bad_response", reviewStatus: receipt.reviewStatus });
}

/** Structurally compatible with @handrail/bug-reporter's BugReportInput. */
export interface BadResponseBugReport {
  readonly eventId: string;
  readonly title: string;
  readonly description: string;
  readonly metadata: {
    readonly ai_response_feedback: {
      readonly schema_version: 1;
      readonly classification: "bad_response";
      readonly conversation_id: string;
      readonly message_id: string;
      readonly turn_id: string | null;
      readonly requested_review: "manual";
    };
  };
}

/**
 * Uses the host's current-session Bug Reporter SDK client. Metadata is a routing
 * request, never workflow authority. Until Handrail supports this contract,
 * reviewQueueAvailable must return false and no bug will be submitted.
 */
export function createBadResponseBugReporter<TResult>(options: {
  readonly reviewQueueAvailable: (signal: AbortSignal) => boolean | Promise<boolean>;
  readonly submit: (report: BadResponseBugReport, options: { readonly signal: AbortSignal }) => Promise<TResult>;
  /** Read authoritative intake fields; never manufacture pending/verified from a generic success. */
  readonly resolveReceipt: (result: TResult) => unknown;
}): BadResponseReporter {
  return async (input, { signal }) => {
    signal.throwIfAborted();
    const request = createBadResponseReportRequest(input);
    if (!await options.reviewQueueAvailable(signal)) throw new Error("Bad-response review is unavailable");
    signal.throwIfAborted();
    const result = await options.submit({
      eventId: request.eventId,
      title: "Bad assistant response",
      description: "A user flagged an assistant response for manual review. Resolve the referenced message using authorized conversation access.",
      metadata: { ai_response_feedback: {
        schema_version: 1, classification: "bad_response",
        conversation_id: request.conversationId, message_id: request.messageId,
        turn_id: request.turnId, requested_review: "manual",
      } },
    }, { signal });
    signal.throwIfAborted();
    return parseBadResponseReportReceipt(options.resolveReceipt(result), request);
  };
}
