import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  CONVERSATION_CITATION_RECORDS_VERSION,
  CONVERSATION_EVENT_LIMITS,
  CONVERSATION_EVENT_TYPES,
  CONVERSATION_EVENT_VERSION,
  ConversationEventValidationError,
  isConversationEvent,
  parseConversationEvent,
} from "../src/index.js";

type Fixture = Record<string, unknown>;

const payloads: Fixture[] = [
  {
    type: "message.created",
    message_id: "msg_01",
    role: "user",
    content: [{ type: "text", text: "Where is my order?" }],
  },
  {
    type: "message.text_appended",
    turn_id: "turn_01",
    message_id: "msg_02",
    text: "Your order is ",
  },
  {
    type: "message.attachment_referenced",
    message_id: "msg_01",
    attachment: {
      attachment_id: "att_01",
      media_type: "image/png",
      filename: "order.png",
      size_bytes: 2_048,
    },
  },
  {
    type: "citation.records_linked",
    citation_records_version: CONVERSATION_CITATION_RECORDS_VERSION,
    target: { type: "assistant_message", message_id: "msg_02" },
    sources: [
      {
        source_id: "source_01",
        type: "web",
        label: "Order status",
        locator: "https://example.com/orders/A-104",
      },
    ],
    citations: [
      {
        citation_id: "citation_01",
        source_id: "source_01",
        order: 0,
        target: { type: "assistant_message", message_id: "msg_02" },
      },
    ],
  },
  {
    type: "turn.started",
    turn_id: "turn_01",
    input_message_ids: ["msg_01"],
  },
  {
    type: "turn.status_changed",
    turn_id: "turn_01",
    status: "waiting_for_tool_result",
  },
  {
    type: "turn.attempt_started",
    turn_id: "turn_01",
    attempt: 1,
    operation: "start",
  },
  {
    type: "turn.retry_scheduled",
    turn_id: "turn_01",
    attempt: 1,
    reason_category: "unavailable",
    delay_ms: 250,
  },
  {
    type: "turn.retry_exhausted",
    turn_id: "turn_01",
    attempt: 3,
    reason_category: "unavailable",
    exhaustion_reason: "maximum_attempts",
  },
  {
    type: "turn.cancellation_requested",
    turn_id: "turn_01",
    reason: "user",
  },
  {
    type: "turn.cancellation_unsupported",
    turn_id: "turn_01",
    reason: "user",
  },
  {
    type: "turn.completed",
    turn_id: "turn_01",
    outcome: "stop",
    output_message_ids: ["msg_02"],
  },
  {
    type: "turn.cancelled",
    turn_id: "turn_01",
    reason: "user",
  },
  {
    type: "turn.failed",
    turn_id: "turn_01",
    error: {
      code: "runtime_unavailable",
      message: "The runtime is temporarily unavailable.",
      retryable: true,
    },
  },
  {
    type: "tool_call.requested",
    turn_id: "turn_01",
    tool_call_id: "call_01",
    name: "lookup_order",
    arguments: { order_id: "A-104" },
  },
  {
    type: "tool_call.discovered",
    turn_id: "turn_01",
    tool_call_id: "call_01",
  },
  {
    type: "tool_call.started",
    turn_id: "turn_01",
    tool_call_id: "call_01",
  },
  {
    type: "tool_call.approval_required",
    turn_id: "turn_01",
    tool_call_id: "call_01",
  },
  {
    type: "approval.proposal_created",
    proposal_id: "proposal_01",
    group_id: "group_01",
    turn_id: "turn_01",
    tool_call_id: "call_01",
    tool_name: "lookup_order",
    status: "pending",
    proposal_version: 1,
    expires_at: "2026-08-27T13:34:56.789Z",
    reviewed_arguments: {
      type: "redacted_json",
      value: { order_id: "A-***" },
    },
  },
  {
    type: "approval.proposal_status_changed",
    proposal_id: "proposal_01",
    proposal_version: 2,
    status: "confirmed",
    decision_reason: "Approved by the account owner",
  },
  {
    type: "tool_call.result_recorded",
    turn_id: "turn_01",
    tool_call_id: "call_01",
    content: [
      {
        type: "json",
        value: { order_id: "A-104", status: "out_for_delivery" },
      },
    ],
    is_error: false,
  },
  {
    type: "tool_loop.budget_exhausted",
    turn_id: "turn_01",
    budget: "total_tool_calls",
    limit: 12,
  },
  {
    type: "usage.receipt_linked",
    turn_id: "turn_01",
    usage_receipt_id: "usage_01",
  },
  {
    type: "conversation.metadata_updated",
    metadata: { feature: "order_support", experiment: { cohort: "b" } },
  },
  {
    type: "conversation.title_updated",
    title: "Order support",
  },
];

const event = (payload: Fixture = payloads[0]!): Fixture => ({
  version: CONVERSATION_EVENT_VERSION,
  event_id: "evt_01",
  conversation_id: "conversation_01",
  revision: 1,
  occurred_at: "2026-08-27T12:34:56.789Z",
  actor: payload.type === "approval.proposal_created"
    ? { type: "system", id: "approval_host_01" }
    : { type: "user", id: "user_01" },
  source: payload.type === "approval.proposal_created"
    ? { type: "runtime" }
    : {
        type: "client",
        client_id: "client_01",
        device_id: "device_01",
      },
  ...(payload.type === "approval.proposal_created"
    ? {}
    : { mutation_id: "mutation_01" }),
  metadata: { feature: "support" },
  payload,
});

const without = (fixture: Fixture, key: string): Fixture =>
  Object.fromEntries(Object.entries(fixture).filter(([name]) => name !== key));

describe("durable conversation event contract", () => {
  it("round-trips every exported event discriminator without mutation", () => {
    expect(payloads.map((payload) => payload.type)).toEqual(
      CONVERSATION_EVENT_TYPES,
    );

    for (const [index, payload] of payloads.entries()) {
      const fixture = {
        ...event(payload),
        event_id: `evt_${index + 1}`,
        revision: index + 1,
      };

      expect(parseConversationEvent(fixture)).toBe(fixture);
      expect(isConversationEvent(fixture)).toBe(true);
    }
  });

  it("accepts normalized citation JSON after a jsonb-style object-key reorder", () => {
    const fixture = event({
      citations: [{
        target: { message_id: "msg_02", type: "assistant_message" },
        order: 0,
        source_id: "source_01",
        citation_id: "citation_01",
      }],
      sources: [{
        locator: "https://example.com/orders/A-104",
        label: "Order status",
        type: "web",
        source_id: "source_01",
      }],
      target: { message_id: "msg_02", type: "assistant_message" },
      citation_records_version: CONVERSATION_CITATION_RECORDS_VERSION,
      type: "citation.records_linked",
    });

    expect(parseConversationEvent(fixture)).toBe(fixture);
  });

  it("round-trips legacy and typed image metadata plus typed PDF metadata", () => {
    const attachments = [
      {
        attachment_id: "att_legacy_image",
        media_type: "image/jpeg",
      },
      {
        attachment_id: "att_typed_image",
        kind: "image",
        media_type: "image/webp",
        filename: "photo.webp",
        size_bytes: AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes,
      },
      {
        attachment_id: "att_pdf_document",
        kind: "document",
        media_type: "application/pdf",
        filename: "owner statement.pdf",
        size_bytes: AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes,
      },
    ] as const;

    for (const attachment of attachments) {
      const fixture = event({
        type: "message.attachment_referenced",
        message_id: "msg_attachments",
        attachment,
      });
      expect(parseConversationEvent(fixture)).toBe(fixture);
      expect(parseConversationEvent(fixture).payload).toMatchObject({ attachment });
    }
  });

  it("rejects unsafe, unbounded, binary-like, or provider-native attachment data", () => {
    const pdf = {
      attachment_id: "att_pdf_safe",
      kind: "document",
      media_type: "application/pdf",
      filename: "safe.pdf",
      size_bytes: 1,
    };
    const malformedAttachments: unknown[] = [
      { ...pdf, attachment_id: "file_provider_123" },
      { ...pdf, attachment_id: "https://files.invalid/document" },
      { ...pdf, filename: "../unsafe.pdf" },
      { ...pdf, filename: "Bearer abcdefghijklmnop.pdf" },
      { ...pdf, filename: "x".repeat(AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength + 1) },
      { ...pdf, size_bytes: 0 },
      { ...pdf, size_bytes: AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes + 1 },
      { ...pdf, kind: "image" },
      { ...pdf, media_type: "application/octet-stream" },
      { ...pdf, content_ref: "ref_private_binary" },
      { ...pdf, provider_file_id: "file_123" },
      { ...pdf, remote_url: "https://files.invalid/document" },
      { ...pdf, bytes: new Uint8Array([37, 80, 68, 70]) },
      { ...pdf, source: { type: "base64", data: "JVBERi0=" } },
      new Uint8Array([37, 80, 68, 70]),
      new Blob(["%PDF"]),
    ];

    for (const attachment of malformedAttachments) {
      const fixture = event({
        type: "message.attachment_referenced",
        message_id: "msg_attachments",
        attachment,
      });
      expect(() => parseConversationEvent(fixture)).toThrow(
        ConversationEventValidationError,
      );
      expect(isConversationEvent(fixture)).toBe(false);
    }

    expect(() => parseConversationEvent(event({
      type: "message.attachment_referenced",
      message_id: "msg_attachments",
      attachment: {
        attachment_id: "att_image_oversized",
        kind: "image",
        media_type: "image/png",
        size_bytes: AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes + 1,
      },
    }))).toThrow(/size_bytes/);
  });

  it("rejects unknown envelope and discriminator-specific payload fields", () => {
    expect(() =>
      parseConversationEvent({ ...event(), future_envelope_field: true }),
    ).toThrow(/future_envelope_field.*not a supported field/);

    for (const payload of payloads) {
      expect(() =>
        parseConversationEvent(event({ ...payload, future_payload_field: true })),
      ).toThrow(/future_payload_field.*not a supported field/);
    }

    const attachmentPayload = payloads[2]!;
    parseConversationEvent(event(attachmentPayload));
    expect(() =>
      parseConversationEvent(
        event({
          ...attachmentPayload,
          attachment: {
            ...(attachmentPayload.attachment as Fixture),
            remote_url: "https://example.invalid/native-reference",
          },
        }),
      ),
    ).toThrow(/remote_url.*not a supported field/);
  });

  it("accepts one bounded assistant text chunk and rejects malformed append payloads", () => {
    const payload = {
      type: "message.text_appended",
      turn_id: "turn_01",
      message_id: "msg_assistant_01",
      text: "Hello, world!",
    };

    expect(parseConversationEvent(event(payload)).payload).toBe(payload);

    for (const malformed of [
      { ...payload, turn_id: "" },
      { ...payload, turn_id: 42 },
      { ...payload, message_id: "" },
      {
        ...payload,
        message_id: "m".repeat(
          CONVERSATION_EVENT_LIMITS.identifierLength + 1,
        ),
      },
      { ...payload, text: "" },
      { ...payload, text: "x".repeat(CONVERSATION_EVENT_LIMITS.textLength + 1) },
      {
        ...payload,
        text: "😀".repeat(
          Math.floor(CONVERSATION_EVENT_LIMITS.textChunkBytes / 4) + 1,
        ),
      },
      { ...payload, provider_delta: { native: true } },
    ]) {
      expect(() => parseConversationEvent(event(malformed))).toThrow(
        ConversationEventValidationError,
      );
      expect(isConversationEvent(event(malformed))).toBe(false);
    }

    for (const key of ["turn_id", "message_id", "text"]) {
      expect(() => parseConversationEvent(event(without(payload, key)))).toThrow(
        new RegExp(`${key}.*required`),
      );
    }
  });

  it("accepts exactly one bounded safe approval argument review form", () => {
    const proposal = {
      type: "approval.proposal_created",
      proposal_id: "proposal_safe",
      group_id: "group_safe",
      turn_id: "turn_01",
      tool_call_id: "call_01",
      tool_name: "send_order_update",
      status: "pending",
      proposal_version: 1,
      expires_at: "2026-08-27T13:00:00Z",
      reviewed_arguments: {
        type: "redacted_json",
        value: { order: "A-***", recipients: ["account owner"] },
      },
    };
    expect(parseConversationEvent(event(proposal)).payload).toBe(proposal);

    const opaque = {
      ...proposal,
      proposal_id: "proposal_opaque",
      reviewed_arguments: {
        type: "opaque_reference",
        argument_ref: "approval-arguments/order-update/01",
      },
    };
    expect(parseConversationEvent(event(opaque)).payload).toBe(opaque);

    for (const reviewed_arguments of [
      {
        type: "redacted_json",
        value: { safe: true },
        argument_ref: "also-present",
      },
      { type: "redacted_json", value: { api_key: "redacted" } },
      { type: "redacted_json", value: { provider_response: { id: "native" } } },
      { type: "redacted_json", value: { system_prompt: "hidden" } },
      { type: "redacted_json", value: { document: "A".repeat(256) } },
      { type: "opaque_reference", argument_ref: "https://host.invalid/args" },
      {
        type: "opaque_reference",
        argument_ref: "a".repeat(
          CONVERSATION_EVENT_LIMITS.approvalArgumentReferenceLength + 1,
        ),
      },
    ]) {
      expect(() => parseConversationEvent(event({
        ...proposal,
        reviewed_arguments,
      }))).toThrow(ConversationEventValidationError);
    }

    const oversizedSnapshot = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, "x".repeat(200)]),
    );
    expect(() => parseConversationEvent(event({
      ...proposal,
      reviewed_arguments: { type: "redacted_json", value: oversizedSnapshot },
    }))).toThrow(/serialize to at most/);
  });

  it("validates lifecycle versions, actors, expiry, and safe reasons", () => {
    const status = {
      type: "approval.proposal_status_changed",
      proposal_id: "proposal_01",
      proposal_version: 2,
      status: "rejected",
      decision_reason: "The requested action is no longer wanted",
    };
    expect(parseConversationEvent(event(status)).payload).toBe(status);

    for (const malformed of [
      { ...status, proposal_version: 0 },
      { ...status, status: "pending" },
      {
        ...status,
        decision_reason: "x".repeat(CONVERSATION_EVENT_LIMITS.approvalReasonLength + 1),
      },
      { ...status, decision_reason: "Bearer abcdefghijklmnop" },
      {
        ...status,
        status: "failed",
        decision_reason: undefined,
      },
      { ...status, status: "executing", decision_reason: "unexpected" },
    ]) {
      expect(() => parseConversationEvent(event(malformed))).toThrow(
        ConversationEventValidationError,
      );
    }

    expect(() => parseConversationEvent(without({
      ...event(status),
      actor: { type: "assistant" },
      source: { type: "runtime" },
    }, "mutation_id"))).toThrow(/explicit user or host system actor/);

    const created = payloads.find(
      (payload) => payload.type === "approval.proposal_created",
    )!;
    expect(() => parseConversationEvent({
      ...event(created),
      actor: { type: "assistant" },
    })).toThrow(/explicit host system actor/);
    expect(() => parseConversationEvent(event({
      ...created,
      expires_at: "2026-08-27T12:00:00Z",
    }))).not.toThrow();
    expect(() => parseConversationEvent(event({ ...created, expires_at: null }))).not.toThrow();
  });

  it("requires non-empty event and conversation identifiers and a revision", () => {
    for (const key of ["event_id", "conversation_id", "revision"] as const) {
      expect(() => parseConversationEvent(without(event(), key))).toThrow(
        new RegExp(`${key}.*required`),
      );
    }

    for (const key of ["event_id", "conversation_id"] as const) {
      expect(() => parseConversationEvent({ ...event(), [key]: "" })).toThrow(
        new RegExp(`${key}.*must not be empty`),
      );
    }
  });

  it("rejects unsupported versions and malformed revisions", () => {
    for (const version of [0, 2, "1", null]) {
      expect(() => parseConversationEvent({ ...event(), version })).toThrow(
        /version/,
      );
    }

    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => parseConversationEvent({ ...event(), revision })).toThrow(
        /positive safe integer monotonic revision/,
      );
    }

    expect(parseConversationEvent({
      ...event(),
      revision: Number.MAX_SAFE_INTEGER,
    })).toBeTypeOf("object");
  });

  it("accepts strict UTC timestamps and rejects malformed timestamps", () => {
    const accepted = [
      "2026-08-27T12:34:56Z",
      "2026-08-27T12:34:56.1Z",
      "2024-02-29T23:59:59.123456789Z",
    ];
    for (const occurred_at of accepted) {
      expect(parseConversationEvent({ ...event(), occurred_at })).toBeTypeOf(
        "object",
      );
    }

    const rejected = [
      "",
      "2026-08-27",
      "2026-08-27T12:34:56",
      "2026-08-27T12:34:56+00:00",
      "2026-02-30T12:34:56Z",
      "2026-13-01T12:34:56Z",
      "not-a-date",
      1_777_777,
    ];
    for (const occurred_at of rejected) {
      expect(() => parseConversationEvent({ ...event(), occurred_at })).toThrow(
        /occurred_at/,
      );
    }
  });

  it("enforces source identity and excludes mutation semantics from imported history", () => {
    expect(() =>
      parseConversationEvent({
        ...event(),
        source: { type: "client", client_id: "" },
      }),
    ).toThrow(/client_id.*must not be empty/);
    expect(parseConversationEvent({ ...event(), source: { type: "runtime" } })).toBeTypeOf("object");
    expect(parseConversationEvent({ ...event(), source: { type: "sync" } })).toBeTypeOf("object");
    expect(() =>
      parseConversationEvent({ ...event(), source: { type: "import" } }),
    ).toThrow(/mutation_id.*imported events/);

    const runtimeEvent = without(event(), "mutation_id");
    runtimeEvent.source = { type: "runtime" };
    expect(parseConversationEvent(runtimeEvent)).toBe(runtimeEvent);
  });

  it("accepts bounded JSON-safe metadata without cloning it", () => {
    const metadata = {
      feature: "support",
      flags: [true, false],
      measurements: { latency_ms: 12.5, cache_hit: null },
    };
    const fixture = { ...event(), metadata };

    const parsed = parseConversationEvent(fixture);
    expect(parsed).toBe(fixture);
    expect(parsed.metadata).toBe(metadata);
  });

  it("rejects circular, non-JSON, credential, and provider-native metadata", () => {
    const circular: Fixture = {};
    circular.self = circular;

    const rejectedMetadata = [
      circular,
      { value: undefined },
      { value: 1n },
      { value: Number.NaN },
      { value: new Date() },
      { api_key: "redacted" },
      { nested: { authorization: "redacted" } },
      { provider_payload: { chunk: "opaque" } },
      { backend: "openai" },
      { note: "Bearer abcdefghijk" },
    ];

    for (const metadata of rejectedMetadata) {
      expect(() => parseConversationEvent({ ...event(), metadata })).toThrow(
        ConversationEventValidationError,
      );
      expect(isConversationEvent({ ...event(), metadata })).toBe(false);
    }
  });

  it("bounds metadata depth, string length, and serialized UTF-8 bytes", () => {
    let nested: Fixture = { value: true };
    for (
      let index = 0;
      index <= CONVERSATION_EVENT_LIMITS.metadataDepth;
      index += 1
    ) {
      nested = { nested };
    }
    expect(() => parseConversationEvent({ ...event(), metadata: nested })).toThrow(
      /depth/,
    );

    expect(() =>
      parseConversationEvent({
        ...event(),
        metadata: {
          value: "x".repeat(
            CONVERSATION_EVENT_LIMITS.metadataStringLength + 1,
          ),
        },
      }),
    ).toThrow(/at most 4096 characters/);

    expect(() =>
      parseConversationEvent({
        ...event(),
        metadata: {
          one: "😀".repeat(2_000),
          two: "😀".repeat(2_000),
          three: "😀".repeat(2_000),
        },
      }),
    ).toThrow(/serialize to at most 16384 bytes/);
  });

  it("rejects presence and typing because they are ephemeral", () => {
    for (const type of ["presence.updated", "typing.started", "typing.stopped"]) {
      expect(() => parseConversationEvent(event({ type }))).toThrow(
        /not a supported durable event discriminator/,
      );
    }

    expect(() =>
      parseConversationEvent({ ...event(), typing: { active: true } }),
    ).toThrow(/typing.*not a supported field/);
    expect(() =>
      parseConversationEvent({ ...event(), presence: { status: "online" } }),
    ).toThrow(/presence.*not a supported field/);
  });
});
