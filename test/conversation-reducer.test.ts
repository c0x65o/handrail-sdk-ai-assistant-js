import { describe, expect, it } from "vitest";

import {
  CONVERSATION_EVENT_VERSION,
  createInitialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  type ConversationEvent,
  type ConversationState,
} from "../src/index.js";

type Fixture = Record<string, unknown>;

interface EventOptions {
  readonly eventId?: string;
  readonly revision: number;
  readonly payload: Fixture;
  readonly mutationId?: string;
  readonly conversationId?: string;
  readonly actor?: "assistant" | "user" | "system" | "tool";
  readonly actorId?: string;
  readonly occurredAt?: string;
  readonly imported?: boolean;
}

function event(options: EventOptions): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: options.eventId ?? `evt_${options.revision}`,
    conversation_id: options.conversationId ?? "conversation_01",
    revision: options.revision,
    occurred_at: options.occurredAt ??
      `2026-08-27T12:00:${String(options.revision).padStart(2, "0")}.000Z`,
    actor: {
      type: options.actor ??
        (options.mutationId === undefined ? "assistant" : "user"),
      ...(options.actorId === undefined ? {} : { id: options.actorId }),
    },
    source:
      options.imported ? { type: "import" } : options.mutationId === undefined
        ? { type: "runtime" }
        : { type: "client", client_id: "client_01" },
    ...(options.mutationId === undefined
      ? {}
      : { mutation_id: options.mutationId }),
    payload: options.payload,
  });
}

function replay(
  events: readonly ConversationEvent[],
  initial: ConversationState = createInitialConversationState(),
): ConversationState {
  return events.reduce(reduceConversationEvent, initial);
}

const textTurn = [
  event({
    revision: 1,
    mutationId: "mutation_01",
    payload: {
      type: "message.created",
      message_id: "message_user",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  }),
  event({
    revision: 2,
    payload: {
      type: "turn.started",
      turn_id: "turn_01",
      input_message_ids: ["message_user"],
    },
  }),
  event({
    revision: 3,
    payload: {
      type: "turn.status_changed",
      turn_id: "turn_01",
      status: "running",
    },
  }),
  event({
    revision: 4,
    payload: {
      type: "message.created",
      message_id: "message_assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
    },
  }),
  event({
    revision: 5,
    payload: {
      type: "turn.completed",
      turn_id: "turn_01",
      outcome: "stop",
      output_message_ids: ["message_assistant"],
    },
  }),
] as const;

describe("reduceConversationEvent", () => {
  it("inserts imported history by original timestamp with stable ties and idempotent replay", () => {
    const created = (revision: number, id: string, occurredAt: string, imported = false) => event({
      revision, occurredAt, imported, payload: { type: "message.created", message_id: id,
        role: "user", content: [{ type: "text", text: id }] },
    });
    const live = created(1, "live", "2026-08-27T12:00:00.000Z");
    const older = created(2, "old_user", "2026-08-26T12:00:00.000Z", true);
    const oldest = created(3, "oldest", "2026-08-25T12:00:00.000Z", true);
    const tie = created(4, "old_reply", "2026-08-26T12:00:00.000Z", true);
    const state = replay([live, older, oldest, tie]);
    expect(state.messages.map(message => message.message_id)).toEqual(["oldest", "old_user", "old_reply", "live"]);
    expect(reduceConversationEvent(state, older)).toBe(state);
    expect(state.active_turn_id).toBeNull();
    expect(state.turns).toHaveLength(0);
    expect(Object.isFrozen(state.messages)).toBe(true);
  });

  it("retains live arrival order even when clocks differ", () => {
    const state = replay([2, 1].map((minute, index) => event({ revision: index + 1,
      occurredAt: `2026-08-27T12:0${minute}:00.000Z`, payload: { type: "message.created",
        message_id: `live_${index}`, role: "user", content: [{ type: "text", text: "Hello" }] } })));
    expect(state.messages.map(message => message.message_id)).toEqual(["live_0", "live_1"]);
  });

  it("moves an imported attachment placeholder to its original timestamp without losing its attachment", () => {
    const state = replay([
      event({ revision: 1, payload: { type: "message.created", message_id: "live", role: "user", content: [{ type: "text", text: "Live message" }] } }),
      event({ revision: 2, payload: { type: "message.attachment_referenced", message_id: "imported",
        attachment: { attachment_id: "att_old", media_type: "image/png" } } }),
      event({ revision: 3, imported: true, occurredAt: "2026-08-20T12:00:00.000Z",
        payload: { type: "message.created", message_id: "imported", role: "user", content: [{ type: "text", text: "Saved photo" }] } }),
    ]);
    expect(state.messages.map(message => message.message_id)).toEqual(["imported", "live"]);
    expect(state.messages[0]?.attachments).toMatchObject([{ attachment_id: "att_old" }]);
    const duplicate = reduceConversationEvent(state, event({ revision: 4, imported: true,
      payload: { type: "message.created", message_id: "imported", role: "user", content: [{ type: "text", text: "Overwritten" }] } }));
    expect(duplicate.messages).toBe(state.messages);
  });

  it("replays a text turn into stable message and terminal turn records", () => {
    const state = replay(textTurn);

    expect(state.conversation_id).toBe("conversation_01");
    expect(state.revision).toBe(5);
    expect(state.messages.map(({ message_id }) => message_id)).toEqual([
      "message_user",
      "message_assistant",
    ]);
    expect(state.messages[1]?.content).toEqual([
      { type: "text", text: "Hi there" },
    ]);
    expect(state.turns[0]).toMatchObject({
      turn_id: "turn_01",
      status: "completed",
      outcome: "stop",
      input_message_ids: ["message_user"],
      output_message_ids: ["message_assistant"],
    });
    expect(state.active_turn_id).toBeNull();
    expect(state.replay_error).toBeNull();
  });

  it("creates an assistant message on the first append and concatenates chunks immutably", () => {
    const chunks = [
      event({
        revision: 1,
        payload: {
          type: "message.text_appended",
          turn_id: "turn_stream",
          message_id: "message_stream",
          text: "Hello",
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "message.text_appended",
          turn_id: "turn_stream",
          message_id: "message_stream",
          text: ", world!",
        },
      }),
    ] as const;

    const first = reduceConversationEvent(
      createInitialConversationState(),
      chunks[0],
    );
    expect(first.messages[0]).toEqual({
      message_id: "message_stream",
      turn_id: "turn_stream",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      attachments: [],
      created_at: "2026-08-27T12:00:01.000Z",
      attribution: {
        actor: { type: "assistant" },
        source: { type: "runtime" },
      },
    });

    const complete = reduceConversationEvent(first, chunks[1]);
    expect(complete.messages[0]?.content).toEqual([
      { type: "text", text: "Hello, world!" },
    ]);
    expect(complete.messages[0]?.created_at).toBe(
      "2026-08-27T12:00:01.000Z",
    );
    expect(complete.messages[0]?.attribution).toEqual(
      first.messages[0]?.attribution,
    );
    expect(first.messages[0]?.content).toEqual([
      { type: "text", text: "Hello" },
    ]);
    expect(Object.isFrozen(complete.messages[0]?.content)).toBe(true);

    const duplicate = reduceConversationEvent(complete, chunks[1]);
    expect(duplicate).toBe(complete);
    const replayed = replay(chunks);
    const replayedAgain = replay(chunks);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(complete));
    expect(JSON.stringify(replayedAgain)).toBe(JSON.stringify(replayed));

    const identityConflict = reduceConversationEvent(complete, event({
      revision: 3,
      payload: {
        type: "message.text_appended",
        turn_id: "turn_other",
        message_id: "message_stream",
        text: " Must not append.",
      },
    }));
    expect(identityConflict.revision).toBe(3);
    expect(identityConflict.messages[0]?.content).toEqual([
      { type: "text", text: "Hello, world!" },
    ]);
  });

  it("promotes attachment placeholders and safely ignores role conflicts", () => {
    const promoted = replay([
      event({
        revision: 1,
        payload: {
          type: "message.attachment_referenced",
          message_id: "message_stream",
          attachment: {
            attachment_id: "att_stream",
            media_type: "image/png",
          },
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "message.created",
          message_id: "message_other",
          role: "assistant",
          content: [{ type: "text", text: "Other" }],
        },
      }),
      event({
        revision: 3,
        payload: {
          type: "message.text_appended",
          turn_id: "turn_stream",
          message_id: "message_stream",
          text: "Image received",
        },
      }),
    ]);

    expect(promoted.messages.map(({ message_id }) => message_id)).toEqual([
      "message_stream",
      "message_other",
    ]);
    expect(promoted.messages[0]).toMatchObject({
      turn_id: "turn_stream",
      role: "assistant",
      content: [{ type: "text", text: "Image received" }],
      attachments: [{ attachment_id: "att_stream" }],
      created_at: "2026-08-27T12:00:03.000Z",
      attribution: {
        actor: { type: "assistant" },
        source: { type: "runtime" },
      },
    });

    const conflicted = replay([
      event({
        revision: 1,
        mutationId: "mutation_user",
        payload: {
          type: "message.created",
          message_id: "message_conflict",
          role: "user",
          content: [{ type: "text", text: "Do not overwrite" }],
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "message.text_appended",
          turn_id: "turn_conflict",
          message_id: "message_conflict",
          text: "Corrupting append",
        },
      }),
    ]);

    expect(conflicted.revision).toBe(2);
    expect(conflicted.processed_event_ids).toEqual(["evt_1", "evt_2"]);
    expect(conflicted.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Do not overwrite" }],
      created_at: "2026-08-27T12:00:01.000Z",
    });
  });

  const projections = [
    {
      name: "tool continuation",
      events: [
        event({
          revision: 1,
          payload: {
            type: "turn.started",
            turn_id: "turn_tool",
            input_message_ids: ["message_tool_input"],
          },
        }),
        event({
          revision: 2,
          payload: {
            type: "tool_call.requested",
            turn_id: "turn_tool",
            tool_call_id: "call_01",
            name: "lookup",
            arguments: { query: "order" },
          },
        }),
        event({
          revision: 3,
          payload: {
            type: "turn.status_changed",
            turn_id: "turn_tool",
            status: "waiting_for_tool_result",
          },
        }),
        event({
          revision: 4,
          payload: {
            type: "tool_call.result_recorded",
            turn_id: "turn_tool",
            tool_call_id: "call_01",
            content: [{ type: "json", value: { found: true } }],
            is_error: false,
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.turns[0]?.status).toBe("waiting_for_tool_result");
        expect(state.tool_calls[0]).toMatchObject({
          tool_call_id: "call_01",
          name: "lookup",
          arguments: { query: "order" },
          result: { content: [{ type: "json", value: { found: true } }] },
        });
      },
    },
    {
      name: "PDF attachment-bearing message",
      events: [
        event({
          revision: 1,
          payload: {
            type: "message.created",
            message_id: "message_document",
            role: "user",
            content: [{ type: "text", text: "What is this?" }],
          },
        }),
        event({
          revision: 2,
          payload: {
            type: "message.attachment_referenced",
            message_id: "message_document",
            attachment: {
              attachment_id: "att_document_01",
              kind: "document",
              media_type: "application/pdf",
              filename: "receipt.pdf",
              size_bytes: 42,
            },
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.messages[0]?.attachments).toHaveLength(1);
        expect(state.attachments[0]).toMatchObject({
          message_id: "message_document",
          attachment_id: "att_document_01",
          reference: {
            kind: "document",
            media_type: "application/pdf",
            filename: "receipt.pdf",
            size_bytes: 42,
          },
        });
      },
    },
    {
      name: "cancellation",
      events: [
        event({
          revision: 1,
          payload: {
            type: "turn.started",
            turn_id: "turn_cancelled",
            input_message_ids: ["message_cancel_input"],
          },
        }),
        event({
          revision: 2,
          payload: {
            type: "turn.cancelled",
            turn_id: "turn_cancelled",
            reason: "user",
          },
        }),
        event({
          revision: 3,
          payload: {
            type: "turn.status_changed",
            turn_id: "turn_cancelled",
            status: "running",
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.turns[0]).toMatchObject({
          status: "cancelled",
          cancellation_reason: "user",
        });
        expect(state.revision).toBe(3);
      },
    },
    {
      name: "retryable failure",
      events: [
        event({
          revision: 1,
          payload: {
            type: "turn.failed",
            turn_id: "turn_failed",
            error: {
              code: "upstream_unavailable",
              message: "Try again later.",
              retryable: true,
            },
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.turns[0]).toMatchObject({
          status: "failed",
          error: { code: "upstream_unavailable", retryable: true },
        });
      },
    },
    {
      name: "usage receipt link",
      events: [
        event({
          revision: 1,
          payload: {
            type: "usage.receipt_linked",
            turn_id: "turn_usage",
            usage_receipt_id: "usage_01",
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.usage_receipt_links).toMatchObject([
          { turn_id: "turn_usage", usage_receipt_id: "usage_01" },
        ]);
        expect(state.usage_receipt_links[0]).not.toHaveProperty("tokens");
      },
    },
  ] as const;

  for (const projection of projections) {
    it(`projects ${projection.name}`, () => {
      projection.assert(replay(projection.events));
    });
  }

  it("clones, deeply freezes, and deterministically deduplicates PDF metadata", () => {
    const sourceAttachment = {
      attachment_id: "att_immutable_pdf",
      kind: "document",
      media_type: "application/pdf",
      filename: "original.pdf",
      size_bytes: 512,
    };
    const events = [
      event({
        revision: 1,
        payload: {
          type: "message.created",
          message_id: "message_pdf",
          role: "user",
          content: [{ type: "text", text: "Review this" }],
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "message.attachment_referenced",
          message_id: "message_pdf",
          attachment: sourceAttachment,
        },
      }),
      event({
        revision: 3,
        payload: {
          type: "message.attachment_referenced",
          message_id: "message_pdf",
          attachment: {
            ...sourceAttachment,
            filename: "conflicting-repeat.pdf",
          },
        },
      }),
    ];

    const state = replay(events);
    const independentlyReplayed = replay(events);
    sourceAttachment.filename = "mutated-after-reduction.pdf";

    expect(state.messages[0]?.attachments).toEqual([{
      attachment_id: "att_immutable_pdf",
      kind: "document",
      media_type: "application/pdf",
      filename: "original.pdf",
      size_bytes: 512,
    }]);
    expect(state.attachments).toHaveLength(1);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.messages[0]?.attachments)).toBe(true);
    expect(Object.isFrozen(state.messages[0]?.attachments[0])).toBe(true);
    expect(Object.isFrozen(state.attachments[0]?.reference)).toBe(true);
    expect(JSON.stringify(independentlyReplayed)).toBe(JSON.stringify(state));
    expect(JSON.stringify(state)).not.toMatch(
      /"(?:content_ref|provider_file_id|remote_url|binary|bytes|blob)":/,
    );
  });

  it("makes duplicate identities and whole-log replay byte-equivalent no-ops", () => {
    const once = replay(textTurn);
    const duplicateEvent = reduceConversationEvent(once, textTurn[0]);
    const twice = replay(textTurn, once);

    expect(duplicateEvent).toBe(once);
    expect(twice).toBe(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));

    const firstMutation = event({
      eventId: "evt_original_mutation",
      revision: 1,
      mutationId: "mutation_stable",
      payload: {
        type: "message.created",
        message_id: "message_mutation",
        role: "user",
        content: [{ type: "text", text: "Once" }],
      },
    });
    const regenerated = event({
      eventId: "evt_regenerated_mutation",
      revision: 1,
      mutationId: "mutation_stable",
      payload: {
        type: "message.created",
        message_id: "message_mutation",
        role: "user",
        content: [{ type: "text", text: "Once" }],
      },
    });
    const mutationState = reduceConversationEvent(
      reduceConversationEvent(createInitialConversationState(), firstMutation),
      regenerated,
    );
    expect(mutationState.processed_event_ids).toEqual(["evt_original_mutation"]);
    expect(mutationState.messages).toHaveLength(1);
  });

  it("preserves first-seen message, attachment, tool, and receipt ordering", () => {
    const state = replay([
      event({
        revision: 1,
        payload: {
          type: "message.attachment_referenced",
          message_id: "message_first",
          attachment: {
            attachment_id: "att_first",
            media_type: "image/png",
          },
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "message.created",
          message_id: "message_second",
          role: "assistant",
          content: [{ type: "text", text: "Second" }],
        },
      }),
      event({
        revision: 3,
        payload: {
          type: "message.created",
          message_id: "message_first",
          role: "user",
          content: [{ type: "text", text: "First" }],
        },
      }),
    ]);

    expect(state.messages.map(({ message_id }) => message_id)).toEqual([
      "message_first",
      "message_second",
    ]);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "First" }],
      attachments: [{ attachment_id: "att_first" }],
    });
  });

  it("surfaces revision gaps and stale revisions without partially applying them", () => {
    const missingFirst = event({
      eventId: "evt_gap",
      revision: 2,
      payload: { type: "conversation.title_updated", title: "Must not apply" },
    });
    const gap = reduceConversationEvent(
      createInitialConversationState(),
      missingFirst,
    );

    expect(gap).toMatchObject({
      conversation_id: null,
      revision: null,
      title: null,
      processed_event_ids: [],
      replay_error: {
        type: "revision_gap",
        expected_revision: 1,
        received_revision: 2,
      },
    });

    const recovered = reduceConversationEvent(
      gap,
      event({
        eventId: "evt_first",
        revision: 1,
        payload: { type: "conversation.title_updated", title: "Accepted" },
      }),
    );
    expect(recovered.replay_error).toBeNull();
    expect(recovered.title).toBe("Accepted");

    const stale = reduceConversationEvent(
      recovered,
      event({
        eventId: "evt_stale",
        revision: 1,
        payload: { type: "conversation.title_updated", title: "Must not replace" },
      }),
    );
    expect(stale.title).toBe("Accepted");
    expect(stale.revision).toBe(1);
    expect(stale.replay_error?.type).toBe("stale_revision");
  });

  it("deeply detaches projected JSON data from mutable event inputs", () => {
    const source = {
      type: "tool_call.requested" as const,
      turn_id: "turn_clone",
      tool_call_id: "call_clone",
      name: "clone",
      arguments: { nested: { value: "original" } },
    };
    const input = event({ revision: 1, payload: source });
    const state = reduceConversationEvent(createInitialConversationState(), input);

    source.arguments.nested.value = "mutated";
    expect(state.tool_calls[0]?.arguments).toEqual({
      nested: { value: "original" },
    });
    expect(Object.isFrozen(state.tool_calls[0]?.arguments)).toBe(true);
  });

  it("projects grouped proposals and every documented legal lifecycle transition", () => {
    const events: ConversationEvent[] = [
      event({
        revision: 1,
        payload: {
          type: "turn.started",
          turn_id: "turn_approval",
          input_message_ids: ["message_approval"],
        },
      }),
    ];
    const proposals = [
      ["call_retry", "proposal_retry", "opaque_reference", "2026-08-27T12:01:00Z"],
      ["call_reject", "proposal_reject", "redacted_json", "2026-08-27T12:01:00Z"],
      ["call_expire", "proposal_expire", "redacted_json", "2026-08-27T12:00:15Z"],
      ["call_success", "proposal_success", "redacted_json", "2026-08-27T12:01:00Z"],
    ] as const;
    let revision = 2;
    for (const [callId, proposalId, reviewType, expiresAt] of proposals) {
      events.push(event({
        revision: revision++,
        payload: {
          type: "tool_call.requested",
          turn_id: "turn_approval",
          tool_call_id: callId,
          name: "send_update",
          arguments: { destination: "account-owner" },
        },
      }));
      events.push(event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_created",
          proposal_id: proposalId,
          group_id: "approval_group_01",
          turn_id: "turn_approval",
          tool_call_id: callId,
          tool_name: "send_update",
          status: "pending",
          proposal_version: 1,
          expires_at: expiresAt,
          reviewed_arguments: reviewType === "opaque_reference"
            ? {
                type: "opaque_reference",
                argument_ref: `approval-arguments/${proposalId}`,
              }
            : {
                type: "redacted_json",
                value: { destination: "account owner" },
              },
        },
      }));
    }
    events.push(
      event({
        revision: revision++,
        mutationId: "confirm-retry",
        actorId: "owner-01",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_retry",
          proposal_version: 2,
          status: "confirmed",
          decision_reason: "Owner confirmed",
        },
      }),
      event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_retry",
          proposal_version: 3,
          status: "executing",
        },
      }),
      event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_retry",
          proposal_version: 4,
          status: "failed",
          failure_reason: "Temporary downstream failure",
        },
      }),
    );
    const failedState = replay(events);
    expect(failedState.approval_proposals[0]).toMatchObject({
      status: "failed",
      proposal_version: 4,
      failure_reason: "Temporary downstream failure",
    });
    events.push(
      event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_retry",
          proposal_version: 5,
          status: "executing",
        },
      }),
      event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_retry",
          proposal_version: 6,
          status: "executed",
        },
      }),
      event({
        revision: revision++,
        mutationId: "reject-proposal",
        actorId: "owner-02",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_reject",
          proposal_version: 2,
          status: "rejected",
          decision_reason: "Owner rejected",
        },
      }),
      event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        occurredAt: "2026-08-27T12:00:16Z",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_expire",
          proposal_version: 2,
          status: "expired",
          decision_reason: "Review window elapsed",
        },
      }),
      event({
        revision: revision++,
        mutationId: "confirm-success",
        actorId: "owner-03",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_success",
          proposal_version: 2,
          status: "confirmed",
        },
      }),
      event({
        revision: revision++,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_success",
          proposal_version: 3,
          status: "executing",
        },
      }),
      event({
        revision,
        actor: "system",
        actorId: "approval-host",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_success",
          proposal_version: 4,
          status: "executed",
        },
      }),
    );

    const state = replay(events);
    expect(state.approval_proposals.map((proposal) => proposal.proposal_id)).toEqual(
      proposals.map(([, proposalId]) => proposalId),
    );
    expect(state.approval_proposals.map((proposal) => proposal.group_id)).toEqual(
      Array(4).fill("approval_group_01"),
    );
    expect(state.approval_proposals.map((proposal) => proposal.status)).toEqual([
      "executed", "rejected", "expired", "executed",
    ]);
    expect(state.approval_proposals[0]).toMatchObject({
      turn_id: "turn_approval",
      tool_call_id: "call_retry",
      tool_name: "send_update",
      proposal_version: 6,
      failure_reason: null,
      decision_attribution: {
        actor: { type: "user", id: "owner-01" },
      },
    });
    expect(state.approval_proposals[1]?.decision_attribution).toMatchObject({
      actor: { type: "user", id: "owner-02" },
    });
    expect(state.tool_calls.every((toolCall) =>
      toolCall.approval_required_at !== null
    )).toBe(true);
    expect(Object.isFrozen(state.approval_proposals)).toBe(true);
    expect(Object.isFrozen(state.approval_proposals[0])).toBe(true);
    expect(Object.isFrozen(state.approval_proposals[0]?.reviewed_arguments)).toBe(true);
    expect(JSON.stringify(replay(events))).toBe(JSON.stringify(state));
  });

  it("no-ops illegal, stale, gapped, repeated, expired, and implicit approvals", () => {
    const base = [
      event({
        revision: 1,
        payload: {
          type: "tool_call.requested",
          turn_id: "turn_guarded",
          tool_call_id: "call_guarded",
          name: "dangerous_action",
          arguments: { target: "bounded-target" },
        },
      }),
      event({
        revision: 2,
        actor: "system",
        payload: {
          type: "approval.proposal_created",
          proposal_id: "proposal_guarded",
          turn_id: "turn_guarded",
          tool_call_id: "call_guarded",
          tool_name: "dangerous_action",
          status: "pending",
          proposal_version: 1,
          expires_at: "2026-08-27T12:00:20Z",
          reviewed_arguments: {
            type: "redacted_json",
            value: { target: "bounded target" },
          },
        },
      }),
    ];
    const observations = [
      event({
        revision: 3,
        actor: "system",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 2,
          status: "executing",
        },
      }),
      event({
        revision: 4,
        mutationId: "gapped-confirmation",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 4,
          status: "confirmed",
        },
      }),
      event({
        revision: 5,
        mutationId: "stale-confirmation",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 1,
          status: "confirmed",
        },
      }),
      event({
        revision: 6,
        actor: "system",
        occurredAt: "2026-08-27T12:00:10Z",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 2,
          status: "expired",
          decision_reason: "Too early",
        },
      }),
      event({
        revision: 7,
        mutationId: "valid-confirmation",
        actorId: "owner-valid",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 2,
          status: "confirmed",
        },
      }),
      event({
        revision: 8,
        mutationId: "repeated-observation",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 2,
          status: "confirmed",
        },
      }),
      event({
        revision: 9,
        mutationId: "illegal-rejection",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 3,
          status: "rejected",
        },
      }),
      event({
        revision: 10,
        payload: {
          type: "message.created",
          message_id: "model_claim",
          role: "assistant",
          content: [{ type: "text", text: "The user confirms this action." }],
        },
      }),
      event({
        revision: 11,
        payload: {
          type: "tool_call.discovered",
          turn_id: "turn_guarded",
          tool_call_id: "unrelated_discovery",
        },
      }),
      event({
        revision: 12,
        actor: "system",
        occurredAt: "2026-08-27T12:00:21Z",
        payload: {
          type: "approval.proposal_status_changed",
          proposal_id: "proposal_guarded",
          proposal_version: 3,
          status: "executing",
        },
      }),
    ];

    const state = replay([...base, ...observations]);
    expect(state.revision).toBe(12);
    expect(state.approval_proposals[0]).toMatchObject({
      status: "confirmed",
      proposal_version: 2,
      updated_at: "2026-08-27T12:00:07.000Z",
      decision_attribution: { actor: { type: "user", id: "owner-valid" } },
    });
  });

  it("preserves first-seen proposal identity and legacy approval projection", () => {
    const state = replay([
      event({
        revision: 1,
        payload: {
          type: "tool_call.requested",
          turn_id: "turn_legacy",
          tool_call_id: "call_legacy",
          name: "legacy_tool",
          arguments: {},
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "tool_call.approval_required",
          turn_id: "turn_legacy",
          tool_call_id: "call_legacy",
        },
      }),
      event({
        revision: 3,
        actor: "system",
        payload: {
          type: "approval.proposal_created",
          proposal_id: "proposal_first",
          group_id: "group_first",
          turn_id: "turn_legacy",
          tool_call_id: "call_legacy",
          tool_name: "legacy_tool",
          status: "pending",
          proposal_version: 1,
          expires_at: "2026-08-27T12:01:00Z",
          reviewed_arguments: {
            type: "opaque_reference",
            argument_ref: "approval-arguments/legacy",
          },
        },
      }),
      event({
        revision: 4,
        actor: "system",
        payload: {
          type: "approval.proposal_created",
          proposal_id: "proposal_first",
          group_id: "group-replacement",
          turn_id: "turn_legacy",
          tool_call_id: "call_legacy",
          tool_name: "legacy_tool",
          status: "pending",
          proposal_version: 1,
          expires_at: "2026-08-27T12:01:30Z",
          reviewed_arguments: {
            type: "opaque_reference",
            argument_ref: "approval-arguments/replacement",
          },
        },
      }),
    ]);

    expect(state.tool_calls[0]?.approval_required_at).toBe(
      "2026-08-27T12:00:02.000Z",
    );
    expect(state.approval_proposals).toHaveLength(1);
    expect(state.approval_proposals[0]).toMatchObject({
      group_id: "group_first",
      reviewed_arguments: {
        type: "opaque_reference",
        argument_ref: "approval-arguments/legacy",
      },
    });
  });
});
