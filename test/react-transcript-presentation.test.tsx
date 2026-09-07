// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachmentUploader, createConversationStore, type ConversationId, type ConversationRuntime } from "../src/index.js";
import { createInitialConversationState, type ConversationState } from "../src/conversation/state.js";
import { HandrailChatWorkspace, StyledChatPreset } from "../src/react-styled/index.js";

afterEach(cleanup);

function transcript(): ConversationState {
  return {
    ...createInitialConversationState("conversation" as never),
    turns: [{ turn_id: "turn" as never, continuation_of_turn_id: null, status: "completed",
      input_message_ids: [], output_message_ids: ["answer" as never], outcome: "stop",
      cancellation_reason: null, cancellation_status: null, cancellation_requested_reason: null,
      remote_may_still_be_running: false, error: null, retry_history: [],
      started_at: null, terminal_at: null, attribution: null }],
    messages: [{ message_id: "answer" as never, turn_id: "turn" as never, role: "assistant",
      content: [{ type: "text", text: '**Subscription** details.\n\n```json\n{"example": true}\n```' }],
      attachments: [], created_at: null, attribution: null }],
    tool_calls: [{ tool_call_id: "lookup" as never, turn_id: "turn" as never,
      name: "web_search", arguments: {}, requested_at: null, discovered_at: null,
      started_at: null, approval_required_at: null, attribution: null,
      result: { content: [{ type: "text", text: "Tool execution completed." }],
        is_error: false, recorded_at: "2026-09-06T00:00:00.000Z" as never,
        attribution: { actor: { type: "assistant" }, source: { type: "runtime" } } } }],
    citation_sources: [{ source_id: "pricing" as never, type: "web", label: "Pricing",
      locator: "https://example.com/pricing" }],
    citations: [{ citation_id: "citation" as never, source_id: "pricing" as never,
      order: 1, target: { type: "assistant_message", message_id: "answer" as never } }],
  };
}

describe("styled transcript presentation", () => {
  it.each([true, false])("omits unregistered tool JSON and preserves Markdown with messageActions=%s", (messageActions) => {
    const state = transcript();
    const view = render(<StyledChatPreset state={state} messageActions={messageActions}
      toolResultRenderers={{}}/>);
    const message = within(view.getByLabelText("assistant message"));
    expect(message.queryByText(/Tool execution completed/)).toBeNull();
    expect(message.getByText("Subscription").tagName).toBe("STRONG");
    expect(message.getByText('{"example": true}').closest("pre")).toBeTruthy();
    expect(state.tool_calls[0]?.result?.content[0]).toEqual({ type: "text", text: "Tool execution completed." });
    if (messageActions) expect(view.getByRole("link", { name: /Pricing/ })).toBeTruthy();
    view.rerender(<StyledChatPreset state={state} messageActions={messageActions}
      toolRendererKeys={{ web_search: "missing" }} toolResultRenderers={{ unrelated: () => <span>Unrelated result</span> }}/>);
    expect(message.queryByText(/Tool execution completed|Unrelated result/)).toBeNull();
    view.rerender(<StyledChatPreset state={state} messageActions={messageActions}
      toolRendererKeys={{ web_search: "search.summary" }}
      toolResultRenderers={{ "search.summary": () => <span>Search summary card</span> }}/>);
    expect(message.getByText("Search summary card")).toBeTruthy();
  });

  it.each([true, false])("disables the thread controls with selected conversation=%s", (selected) => {
    const conversationId = "conversation" as ConversationId;
    const state = transcript();
    const store = createConversationStore(conversationId, state);
    const runtime = { store, getSnapshot: () => state, observe: () => () => {},
      sendMessage: vi.fn(), resumeTurn: vi.fn(), restoreActiveTurn: vi.fn(), destroy: vi.fn(),
    } as unknown as ConversationRuntime<undefined>;
    const snapshot = { selectedConversationId: selected ? conversationId : null,
      runningCount: 0, errorCount: 0, unreadCount: 0,
      threads: [{ conversationId, runtime, turnStatus: "idle" as const, unread: false, revision: null }] };
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, open: vi.fn(), select: vi.fn() };
    const list = vi.fn();
    const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("Unused upload"); } });
    const view = render(<HandrailChatWorkspace workspace={workspace} conversationPicker={false}
      catalogOptions={{ catalog: { list } as never, authorizationContext: {} }}
      createConversation={vi.fn()}
      composerForConversation={() => ({ uploader, conversationId })}
      renderVoiceControls={() => <button>Dictate</button>}/>);
    expect(view.queryByRole("button", { name: "New" })).toBeNull();
    expect(view.queryByText("Threads")).toBeNull();
    expect(view.container.querySelector(".hr-chat__picker")).toBeNull();
    expect(list).not.toHaveBeenCalled();
    if (selected) {
      expect(view.getByRole("textbox")).toBeTruthy();
      expect(view.getByRole("button", { name: "Dictate" })).toBeTruthy();
      expect(view.queryByText(/Tool execution completed/)).toBeNull();
    }
    view.unmount();
    uploader.dispose();
  });
});
