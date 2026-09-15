import {
  CONVERSATION_CATALOG_LIMITS,
  parseConversationCatalogIdempotencyKey,
  parseConversationCatalogTitle,
  type ConversationCatalogIdempotencyKey,
} from "./catalog.js";
import type { ConversationId } from "./events.js";
import type { ConversationState } from "./state.js";

/** Limits applied before any conversation text crosses the host hook boundary. */
export const CONVERSATION_TITLE_GENERATION_LIMITS = Object.freeze({
  userTextItems: 8,
  userTextLength: 1_024,
  userTextTotalLength: 4_096,
  idempotencyEntries: 128,
} as const);

export const DEFAULT_CONVERSATION_TITLE = "New conversation" as const;

export type ConversationTitleGenerationIdempotencyKey =
  ConversationCatalogIdempotencyKey;

/**
 * The complete conversation context visible to a title generator.
 *
 * `userTexts` contains only normalized, capped text from user messages or,
 * when those are absent, user speech supplied by an authorized host transport. It
 * never contains assistant/system text, attachments or references, tool data,
 * citations, metadata, credentials, authorization state, hidden instructions,
 * or provider-native fields.
 */
export interface ConversationTitleGenerationContext {
  readonly conversationId: ConversationId;
  readonly userTexts: readonly string[];
}

/** Fresh, bounded request constructed for each first-seen idempotency identity. */
export interface ConversationTitleGenerationHostRequest {
  readonly context: ConversationTitleGenerationContext;
  readonly signal: AbortSignal;
  readonly idempotencyKey: ConversationTitleGenerationIdempotencyKey;
}

/** Provider-neutral host boundary. Returned values are treated as untrusted. */
export type ConversationTitleGenerationHook = (
  request: ConversationTitleGenerationHostRequest,
) => unknown | Promise<unknown>;

export interface GenerateConversationTitleInput {
  readonly state: ConversationState;
  /** Trusted user speech fallback; never a synthetic chat message or instruction. */
  readonly externalUserTexts?: readonly string[];
  readonly signal: AbortSignal;
  readonly idempotencyKey: string;
}

export type ConversationTitleGenerationErrorCode =
  | "invalid_input"
  | "idempotency_conflict"
  | "capacity_exceeded";

/** Safe operational error that never includes conversation or host output. */
export class ConversationTitleGenerationError extends Error {
  readonly code: ConversationTitleGenerationErrorCode;

  constructor(code: ConversationTitleGenerationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ConversationTitleGenerationError";
    this.code = code;
  }
}

interface IdempotencyRecord {
  readonly signature: string;
  result: Promise<string>;
  settled: boolean;
}

const ERROR_MESSAGES = Object.freeze({
  invalid_input: "The conversation title generation request is invalid.",
  idempotency_conflict:
    "The conversation title generation identity was reused for different context.",
  capacity_exceeded:
    "The conversation title generation service is temporarily at capacity.",
} as const satisfies Record<ConversationTitleGenerationErrorCode, string>);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u;
const UNSAFE_TITLE_CHARACTER = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const SANITIZED_TEXT_CHARACTER = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * Builds the only context shape that may reach the host hook. Source state is
 * read narrowly and is never forwarded or retained as an object.
 */
export function createConversationTitleGenerationContext(
  state: ConversationState,
  externalUserTexts: readonly string[] = [],
): ConversationTitleGenerationContext {
  const conversationId = state.conversation_id;
  if (
    typeof conversationId !== "string" ||
    conversationId.length === 0 ||
    conversationId.length > CONVERSATION_CATALOG_LIMITS.identifierLength ||
    !IDENTIFIER.test(conversationId)
  ) {
    throw new ConversationTitleGenerationError("invalid_input");
  }

  const userTexts: string[] = [];
  let remaining: number =
    CONVERSATION_TITLE_GENERATION_LIMITS.userTextTotalLength;

  for (const message of state.messages) {
    if (
      message.role !== "user" ||
      userTexts.length >= CONVERSATION_TITLE_GENERATION_LIMITS.userTextItems ||
      remaining === 0
    ) {
      continue;
    }

    const text = sanitizeUserText(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" "),
    );
    if (text.length === 0) continue;

    const capped = truncateUtf16(
      text,
      Math.min(
        remaining,
        CONVERSATION_TITLE_GENERATION_LIMITS.userTextLength,
      ),
    ).trimEnd();
    if (capped.length === 0) continue;
    userTexts.push(capped);
    remaining -= capped.length;
  }

  // Keep external transport data out of text-chat titles. Read only this narrow,
  // bounded array; never forward a host record, metadata or provider event.
  if (userTexts.length === 0) {
    if (!Array.isArray(externalUserTexts)) throw new ConversationTitleGenerationError("invalid_input");
    for (const value of externalUserTexts.slice(0, CONVERSATION_TITLE_GENERATION_LIMITS.userTextItems)) {
      if (typeof value !== "string") throw new ConversationTitleGenerationError("invalid_input");
      const text = sanitizeUserText(value.slice(0, 8_192));
      const capped = truncateUtf16(text, Math.min(remaining, CONVERSATION_TITLE_GENERATION_LIMITS.userTextLength)).trimEnd();
      if (!capped) continue;
      userTexts.push(capped);
      remaining -= capped.length;
      if (remaining === 0) break;
    }
  }

  return Object.freeze({
    conversationId,
    userTexts: Object.freeze(userTexts),
  });
}

/**
 * Calls a host title hook through a bounded, provider-neutral request and
 * supplies deterministic local fallback and idempotency behavior.
 */
export class ConversationTitleGenerationService {
  readonly #hook: ConversationTitleGenerationHook;
  readonly #idempotency = new Map<
    ConversationTitleGenerationIdempotencyKey,
    IdempotencyRecord
  >();

  constructor(hook: ConversationTitleGenerationHook) {
    if (typeof hook !== "function") {
      throw new ConversationTitleGenerationError("invalid_input");
    }
    this.#hook = hook;
  }

  async generateTitle(input: GenerateConversationTitleInput): Promise<string> {
    if (!isAbortSignal(input.signal)) {
      throw new ConversationTitleGenerationError("invalid_input");
    }
    throwIfAborted(input.signal);

    const context = createConversationTitleGenerationContext(input.state, input.externalUserTexts);
    let idempotencyKey: ConversationTitleGenerationIdempotencyKey;
    try {
      idempotencyKey = parseConversationCatalogIdempotencyKey(
        input.idempotencyKey,
        "rename",
      );
    } catch {
      throw new ConversationTitleGenerationError("invalid_input");
    }
    const signature = JSON.stringify(context);
    const existing = this.#idempotency.get(idempotencyKey);

    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new ConversationTitleGenerationError("idempotency_conflict");
      }
      this.#idempotency.delete(idempotencyKey);
      this.#idempotency.set(idempotencyKey, existing);
      return awaitWithSignal(existing.result, input.signal);
    }

    this.#makeCapacity();
    const request = Object.freeze({
      context,
      signal: input.signal,
      idempotencyKey,
    } satisfies ConversationTitleGenerationHostRequest);
    const fallback = fallbackTitle(context.userTexts[0]);
    const operation = this.#invoke(request, fallback);
    const record: IdempotencyRecord = {
      signature,
      result: operation,
      settled: false,
    };
    const result = operation.then(
      (title) => {
        record.settled = true;
        return title;
      },
      (error: unknown) => {
        if (this.#idempotency.get(idempotencyKey) === record) {
          this.#idempotency.delete(idempotencyKey);
        }
        throw error;
      },
    );
    record.result = result;
    this.#idempotency.set(idempotencyKey, record);
    return awaitWithSignal(result, input.signal);
  }

  async #invoke(
    request: ConversationTitleGenerationHostRequest,
    fallback: string,
  ): Promise<string> {
    const output = await awaitWithSignal(
      Promise.resolve().then(() => {
        throwIfAborted(request.signal);
        return this.#hook(request);
      }),
      request.signal,
    );
    throwIfAborted(request.signal);
    return normalizeHostTitle(output) ?? fallback;
  }

  #makeCapacity(): void {
    if (
      this.#idempotency.size <
      CONVERSATION_TITLE_GENERATION_LIMITS.idempotencyEntries
    ) {
      return;
    }
    for (const [key, record] of this.#idempotency) {
      if (record.settled) {
        this.#idempotency.delete(key);
        return;
      }
    }
    throw new ConversationTitleGenerationError("capacity_exceeded");
  }
}

function normalizeHostTitle(output: unknown): string | null {
  if (
    typeof output !== "string" ||
    output.length === 0 ||
    output.length > CONVERSATION_CATALOG_LIMITS.titleLength ||
    UNSAFE_TITLE_CHARACTER.test(output)
  ) {
    return null;
  }
  const normalized = normalizeWhitespace(output);
  try {
    return parseConversationCatalogTitle(normalized, "rename");
  } catch {
    return null;
  }
}

function fallbackTitle(firstUserText: string | undefined): string {
  if (firstUserText === undefined) return DEFAULT_CONVERSATION_TITLE;
  const truncated = truncateUtf16(
    firstUserText,
    CONVERSATION_CATALOG_LIMITS.titleLength,
  ).trimEnd();
  return truncated.length === 0 ? DEFAULT_CONVERSATION_TITLE : truncated;
}

function sanitizeUserText(value: string): string {
  return normalizeWhitespace(value.replace(SANITIZED_TEXT_CHARACTER, " "));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateUtf16(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  let truncated = value.slice(0, maximumLength);
  const final = truncated.charCodeAt(truncated.length - 1);
  if (final >= 0xd800 && final <= 0xdbff) truncated = truncated.slice(0, -1);
  return truncated;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
