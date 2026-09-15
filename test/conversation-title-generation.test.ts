import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_TITLE_GENERATION_LIMITS,
  DEFAULT_CONVERSATION_TITLE,
  ConversationTitleGenerationError,
  ConversationTitleGenerationService,
  createConversationTitleGenerationContext,
  type ConversationTitleGenerationHostRequest,
} from "../src/conversation/title-generation.js";
import {
  createInitialConversationState,
  type ConversationMessageRecord,
  type ConversationState,
} from "../src/conversation/state.js";
import type {
  ConversationId,
  ConversationMessageId,
} from "../src/conversation/events.js";
import * as conversationEntry from "../src/conversation/index.js";

function message(
  role: "user" | "assistant" | "system",
  text: string,
  index: number,
): ConversationMessageRecord {
  return {
    message_id: `message-${index}` as ConversationMessageId,
    role,
    content: Object.freeze([Object.freeze({ type: "text", text })]),
    attachments: Object.freeze([]),
    created_at: null,
    attribution: null,
  };
}

function conversationState(
  messages: readonly ConversationMessageRecord[] = [
    message("user", "Plan a weekend in Chicago", 1),
  ],
  conversationId = "conversation-1",
): ConversationState {
  return Object.freeze({
    ...createInitialConversationState(conversationId as ConversationId),
    messages: Object.freeze([...messages]),
  });
}

function input(
  state: ConversationState,
  signal: AbortSignal = new AbortController().signal,
  idempotencyKey = "title-1",
) {
  return { state, signal, idempotencyKey };
}

describe("ConversationTitleGenerationService", () => {
  it("is available from the public conversation entry point", () => {
    expect(conversationEntry.CONVERSATION_TITLE_GENERATION_LIMITS).toBe(
      CONVERSATION_TITLE_GENERATION_LIMITS,
    );
    expect(conversationEntry.ConversationTitleGenerationService).toBe(
      ConversationTitleGenerationService,
    );
  });

  it("accepts a valid host title and normalizes safe whitespace", async () => {
    const service = new ConversationTitleGenerationService(
      async () => "  Chicago\u00a0  weekend ideas  ",
    );

    await expect(
      service.generateTitle(input(conversationState())),
    ).resolves.toBe("Chicago weekend ideas");
  });

  it.each([
    ["empty", ""],
    ["non-string", { title: "unsafe" }],
    ["multiline", "Host\ntitle"],
    ["control character", "Host\u0000title"],
    ["unicode line separator", "Host\u2028title"],
    ["oversized", "x".repeat(257)],
  ])("falls back for %s host output", async (_case, output) => {
    const service = new ConversationTitleGenerationService(async () => output);

    await expect(
      service.generateTitle(input(conversationState())),
    ).resolves.toBe("Plan a weekend in Chicago");
  });

  it("sanitizes user controls and whitespace in the deterministic fallback", async () => {
    const state = conversationState([
      message("user", " \n\tFirst\u0000   useful\r request  ", 1),
    ]);
    const service = new ConversationTitleGenerationService(async () => "");

    await expect(service.generateTitle(input(state))).resolves.toBe(
      "First useful request",
    );
  });

  it("truncates fallback text deterministically without splitting a surrogate", async () => {
    const text = `${"a".repeat(255)}🙂 trailing text`;
    const state = conversationState([message("user", text, 1)]);
    const service = new ConversationTitleGenerationService(async () => "");

    const first = await service.generateTitle(input(state));
    const second = await service.generateTitle(input(state));

    expect(first).toBe("a".repeat(255));
    expect(first).toHaveLength(255);
    expect(second).toBe(first);
  });

  it("uses the fixed neutral label when no usable user text exists", async () => {
    const state = conversationState([
      message("assistant", "Private assistant output", 1),
      message("system", "Hidden instructions", 2),
      message("user", " \n\t\u0000 ", 3),
    ]);
    const service = new ConversationTitleGenerationService(async () => null);

    await expect(service.generateTitle(input(state))).resolves.toBe(
      DEFAULT_CONVERSATION_TITLE,
    );
  });

  it("rejects before calling the hook when already cancelled", async () => {
    const reason = new Error("cancelled by caller");
    const controller = new AbortController();
    controller.abort(reason);
    const hook = vi.fn();
    const service = new ConversationTitleGenerationService(hook);

    await expect(
      service.generateTitle(input(conversationState(), controller.signal)),
    ).rejects.toBe(reason);
    expect(hook).not.toHaveBeenCalled();
  });

  it("rejects promptly and preserves cancellation while awaiting the hook", async () => {
    const reason = new Error("cancelled while generating");
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const service = new ConversationTitleGenerationService(
      (request) => {
        receivedSignal = request.signal;
        return new Promise(() => undefined);
      },
    );

    const generated = service.generateTitle(
      input(conversationState(), controller.signal),
    );
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));
    controller.abort(reason);

    await expect(generated).rejects.toBe(reason);
  });

  it("replays a settled result for equivalent bounded context", async () => {
    const hook = vi
      .fn()
      .mockResolvedValueOnce("Stable host title")
      .mockResolvedValueOnce("Different title");
    const service = new ConversationTitleGenerationService(hook);
    const firstState = conversationState();
    const equivalentState = {
      ...firstState,
      metadata: { ignoredCredential: "Bearer private-token-value" },
      provider_native: { ignored: true },
    } as unknown as ConversationState;

    await expect(service.generateTitle(input(firstState))).resolves.toBe(
      "Stable host title",
    );
    await expect(service.generateTitle(input(equivalentState))).resolves.toBe(
      "Stable host title",
    );
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting reuse of an idempotency identity safely", async () => {
    const hook = vi.fn(async () => "Host title");
    const service = new ConversationTitleGenerationService(hook);

    await service.generateTitle(input(conversationState(), undefined, "same-key"));
    await expect(
      service.generateTitle(
        input(
          conversationState([message("user", "Different bounded text", 2)]),
          undefined,
          "same-key",
        ),
      ),
    ).rejects.toMatchObject({
      name: "ConversationTitleGenerationError",
      code: "idempotency_conflict",
      message:
        "The conversation title generation identity was reused for different context.",
    } satisfies Partial<ConversationTitleGenerationError>);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("passes exactly bounded user text, safe identity, signal, and idempotency to the hook", async () => {
    const controller = new AbortController();
    const longText = "u".repeat(
      CONVERSATION_TITLE_GENERATION_LIMITS.userTextLength + 100,
    );
    const userMessages = Array.from(
      { length: CONVERSATION_TITLE_GENERATION_LIMITS.userTextItems + 2 },
      (_, index) => message("user", index === 0 ? longText : `user-${index}`, index),
    );
    const sourceState = {
      ...conversationState([
        ...userMessages,
        message("assistant", "Assistant private output", 20),
        message("system", "Hidden system instructions", 21),
      ]),
      attachments: [{
        reference: {
          kind: "document",
          media_type: "application/pdf",
          filename: "private.pdf",
          content_reference: "document-ref-private",
        },
      }],
      tool_calls: [{
        name: "private_tool",
        arguments: { password: "tool-input-secret" },
        result: { content: [{ type: "text", text: "tool-result-secret" }] },
      }],
      metadata: {
        credentials: "Bearer metadata-secret",
        authorizationContext: { role: "owner" },
        hiddenInstruction: "Never reveal this",
      },
      citations: [{ locator: "https://private.example/source" }],
      provider_native: { response_id: "provider-private-id", model: "native" },
    } as unknown as ConversationState;
    let captured: ConversationTitleGenerationHostRequest | undefined;
    const service = new ConversationTitleGenerationService((request) => {
      captured = request;
      return "Captured safely";
    });

    await service.generateTitle(input(sourceState, controller.signal, "capture-1"));

    expect(captured).toBeDefined();
    expect(Object.keys(captured!)).toEqual([
      "context",
      "signal",
      "idempotencyKey",
    ]);
    expect(Object.keys(captured!.context)).toEqual([
      "conversationId",
      "userTexts",
    ]);
    expect(captured).toEqual({
      context: {
        conversationId: "conversation-1",
        userTexts: [
          "u".repeat(CONVERSATION_TITLE_GENERATION_LIMITS.userTextLength),
          "user-1",
          "user-2",
          "user-3",
          "user-4",
          "user-5",
          "user-6",
          "user-7",
        ],
      },
      signal: controller.signal,
      idempotencyKey: "capture-1",
    });
    expect(JSON.stringify(captured)).not.toMatch(
      /private|secret|password|authorization|provider|citation|document/iu,
    );
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured!.context)).toBe(true);
    expect(Object.isFrozen(captured!.context.userTexts)).toBe(true);
  });

  it("builds capped context independently of title generation", () => {
    const context = createConversationTitleGenerationContext(
      conversationState([
        message("user", "  one\n two  ", 1),
        message("assistant", "not visible", 2),
        message("user", "three", 3),
      ]),
    );

    expect(context).toEqual({
      conversationId: "conversation-1",
      userTexts: ["one two", "three"],
    });
  });
});

describe("external user speech title context", () => {
  it("bounds, normalizes and isolates speech without changing the source conversation", async () => {
    const state = conversationState([]);
    const hook = vi.fn(async (_request: ConversationTitleGenerationHostRequest) => "Spoken request");
    const service = new ConversationTitleGenerationService(hook);
    await service.generateTitle({ ...input(state), externalUserTexts: Array.from({ length: 10 }, () => " words\n".repeat(500)) });
    const context = hook.mock.calls[0]![0];
    expect(Object.keys(context.context)).toEqual(["conversationId", "userTexts"]);
    expect(context.context.userTexts.length).toBeLessThanOrEqual(8);
    expect(context.context.userTexts.every(text => text.length <= 1024 && !text.includes("\n"))).toBe(true);
    expect(context.context.userTexts.join("").length).toBeLessThanOrEqual(4096);
    expect(state.messages).toHaveLength(0);
    expect(state.turns).toHaveLength(0);
  });

  it("never substitutes external speech for an existing user message", () => {
    expect(createConversationTitleGenerationContext(conversationState(), ["External text"]).userTexts)
      .toEqual(["Plan a weekend in Chicago"]);
  });

  it("rejects malformed external text rather than serializing host metadata", () => {
    expect(() => createConversationTitleGenerationContext(conversationState([]), [{ secret: "hidden" }] as never))
      .toThrow(ConversationTitleGenerationError);
  });
});
