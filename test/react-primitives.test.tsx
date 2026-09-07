/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type KeyboardEvent } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInitialConversationState,
  type ConversationAttachmentReference,
  type ConversationId,
  type ConversationMessageRecord,
  type ConversationState,
  type ConversationToolCallRecord,
  type ConversationTurnRecord,
  type PresenceParticipantSummary,
} from "../src/index.js";
import {
  AttachmentItem,
  AssistantActivityIndicator,
  AttachmentList,
  AttachmentCancel,
  AttachmentRemove,
  AttachmentRetry,
  ChatRoot,
  Composer,
  ErrorList,
  FileInput,
  Form,
  LiveRegion,
  Message,
  MessageList,
  PresenceList,
  Retry,
  Stop,
  StreamStatus,
  Submit,
  Textarea,
  Transcript,
  TypingIndicator,
  type ConversationComposerResult,
} from "../src/react/index.js";

afterEach(() => cleanup());

const message = (
  text: string,
  role: ConversationMessageRecord["role"] = "assistant",
  id = "message_1",
): ConversationMessageRecord => ({
  message_id: id as ConversationMessageRecord["message_id"],
  role,
  content: [{ type: "text", text }],
  attachments: [],
  created_at: "2026-08-28T00:00:00.000Z" as ConversationMessageRecord["created_at"],
  attribution: null,
});

const turn = (
  status: ConversationTurnRecord["status"],
  overrides: Partial<ConversationTurnRecord> = {},
): ConversationTurnRecord => ({
  turn_id: "turn_1" as ConversationTurnRecord["turn_id"],
  continuation_of_turn_id: null,
  status,
  input_message_ids: [],
  output_message_ids: ["message_1" as ConversationMessageRecord["message_id"]],
  outcome: status === "completed" ? "stop" : null,
  cancellation_reason: null,
  cancellation_status: null,
  cancellation_requested_reason: null,
  remote_may_still_be_running: status !== "completed" && status !== "failed" &&
    status !== "cancelled",
  error: null,
  retry_history: [],
  started_at: null,
  terminal_at: null,
  attribution: null,
  ...overrides,
});

function conversationState(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    ...createInitialConversationState("conversation_primitives" as ConversationId),
    ...overrides,
  };
}

function composer(
  overrides: Partial<ConversationComposerResult> = {},
): ConversationComposerResult {
  const submit = vi.fn<ConversationComposerResult["submit"]>(async (event) => {
    event?.preventDefault();
    return null;
  });
  const stop = vi.fn<ConversationComposerResult["stop"]>(async () => true);
  const textareaKeyDown = vi.fn((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
  return {
    draft: "hello",
    acquireSubmissionBlock: vi.fn(() => vi.fn()),
    setDraft: vi.fn(),
    attachments: [],
    errors: [],
    canSend: true,
    isSending: false,
    submit,
    cancel: stop,
    stop,
    retryAttachment: vi.fn(() => true),
    cancelAttachment: vi.fn(() => true),
    removeAttachment: vi.fn(() => true),
    getTextareaProps: () => ({
      value: "hello",
      onChange: vi.fn(),
      onPaste: vi.fn(),
      onBlur: vi.fn(),
      onKeyDown: textareaKeyDown,
      onCompositionStart: vi.fn(),
      onCompositionEnd: vi.fn(),
    }),
    getFileInputProps: () => ({
      accept: "image/png,image/jpeg",
      multiple: true,
      onChange: vi.fn(),
    }),
    getDropProps: () => ({ onDragOver: vi.fn(), onDrop: vi.fn() }),
    ...overrides,
  };
}

describe("headless chat primitives", () => {
  it("renders an accessible minimal full-page composition", () => {
    const state = conversationState({
      messages: [message("Hello", "user"), message("Hi", "assistant", "message_2")],
      turns: [turn("running")],
      active_turn_id: "turn_1" as ConversationTurnRecord["turn_id"],
    });
    const bindings = composer({ isSending: true, canSend: false });

    render(
      <ChatRoot state={state} composer={bindings} aria-label="Support chat">
        <Transcript />
        <StreamStatus />
        <LiveRegion />
        <Composer>
          <Form>
            <Textarea aria-label="Message" />
            <FileInput />
            <Submit />
            <Stop />
            <Retry onRetry={vi.fn()} />
          </Form>
        </Composer>
      </ChatRoot>,
    );

    expect(screen.getByRole("region", { name: "Conversation transcript" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Messages" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "user message" }).textContent).toBe("Hello");
    expect(screen.getByRole("listitem", { name: "assistant message" }).textContent).toBe("Hi");
    expect(screen.getByRole("form", { name: "Message composer" }).getAttribute("aria-busy"))
      .toBe("true");
    expect(screen.getByRole("textbox", { name: "Message" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled"))
      .toBe(true);
    expect(screen.getByRole("button", { name: "Stop response" }).hasAttribute("disabled"))
      .toBe(false);
  });

  it("forwards file drag events while honoring a consumer's prevention", () => {
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    const bindings = composer({ getDropProps: () => ({ onDragOver, onDrop }) });
    const { rerender } = render(<Composer composer={bindings} data-testid="drop-target" />);
    fireEvent.dragOver(screen.getByTestId("drop-target"));
    fireEvent.drop(screen.getByTestId("drop-target"));
    expect(onDragOver).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
    rerender(<Composer composer={bindings} data-testid="drop-target"
      onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}/>);
    fireEvent.dragOver(screen.getByTestId("drop-target"));
    fireEvent.drop(screen.getByTestId("drop-target"));
    expect(onDragOver).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("uses the native form path and handles Enter without duplicate submission", () => {
    const bindings = composer();
    render(
      <Composer composer={bindings}>
        <Form>
          <Textarea aria-label="Message" />
          <Submit />
        </Form>
      </Composer>,
    );

    const textbox = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(bindings.submit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(bindings.submit).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Send message" }).getAttribute("type"))
      .toBe("submit");
  });

  it("honors consumer-prevented form, input, action, and removal events", () => {
    const bindings = composer();
    const onStop = vi.fn();
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    const prevent = (event: { preventDefault(): void }) => event.preventDefault();
    render(
      <>
        <Form composer={bindings} onSubmit={prevent}>
          <Submit composer={bindings} />
        </Form>
        <Textarea
          aria-label="Prevented message"
          composer={bindings}
          onKeyDown={prevent}
        />
        <Stop available onStop={onStop} onClick={prevent} />
        <Retry available onRetry={onRetry} onClick={prevent} />
        <AttachmentItem
          attachment={{
            attachment_id: "attachment_1" as never,
            media_type: "image/png",
            filename: "proof.png",
          }}
          onRemove={onRemove}
        >
          <AttachmentRemove onClick={prevent} />
        </AttachmentItem>
      </>,
    );

    fireEvent.submit(screen.getByRole("form"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prevented message" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove proof.png" }));
    expect(bindings.submit).not.toHaveBeenCalled();
    expect(bindings.getTextareaProps().onKeyDown).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("announces status transitions without announcing streamed token deltas", async () => {
    const running = conversationState({
      messages: [message("first token")],
      turns: [turn("running")],
      active_turn_id: "turn_1" as ConversationTurnRecord["turn_id"],
    });
    const { rerender } = render(
      <ChatRoot state={running}>
        <Transcript />
        <LiveRegion data-testid="live" />
      </ChatRoot>,
    );
    await waitFor(() => expect(screen.getByTestId("live").textContent).toBe("Response started."));

    const delta = conversationState({
      messages: [message("first token and private delta")],
      turns: [turn("running")],
      active_turn_id: "turn_1" as ConversationTurnRecord["turn_id"],
    });
    rerender(
      <ChatRoot state={delta}>
        <Transcript />
        <LiveRegion data-testid="live" />
      </ChatRoot>,
    );
    expect(screen.getByTestId("live").textContent).toBe("Response started.");
    expect(screen.getByTestId("live").textContent).not.toContain("private delta");
    expect(screen.getByRole("region", { name: "Conversation transcript" }).textContent)
      .toContain("private delta");

    rerender(
      <ChatRoot state={conversationState({ messages: delta.messages, turns: [turn("completed")] })}>
        <LiveRegion data-testid="live" />
      </ChatRoot>,
    );
    await waitFor(() => expect(screen.getByTestId("live").textContent).toBe("Response complete."));
  });

  it("forwards native props, events, styles, data attributes, refs, and render seams", () => {
    const rootRef = createRef<HTMLDivElement>();
    const click = vi.fn();
    render(
      <ChatRoot
        ref={rootRef}
        className="consumer-root"
        data-customer="yes"
        style={{ opacity: 0.5 }}
        onClick={click}
        render={(props, ref) => <main {...props} ref={ref as never} />}
      >
        custom root
      </ChatRoot>,
    );
    const root = screen.getByText("custom root");
    fireEvent.click(root);
    expect(root.tagName).toBe("MAIN");
    expect(root.className).toBe("consumer-root");
    expect(root.getAttribute("data-customer")).toBe("yes");
    expect(root.getAttribute("style")).toContain("opacity: 0.5");
    expect(rootRef.current).toBe(root);
    expect(click).toHaveBeenCalledOnce();
  });

  it("supports custom part, tool, result, error, and attachment renderers", () => {
    const failed = turn("failed", {
      error: { code: "tool_failed", message: "Tool failed", retryable: true },
    });
    const toolCall = {
      tool_call_id: "tool_call_1",
      turn_id: failed.turn_id,
      name: "lookup",
      arguments: { query: "weather" },
      requested_at: null,
      discovered_at: null,
      started_at: null,
      approval_required_at: null,
      attribution: null,
      result: {
        content: [{ type: "json", value: { degrees: 72 } }],
        is_error: false,
        recorded_at: "2026-08-28T00:00:01.000Z",
        attribution: { actor: { type: "tool" }, source: { type: "runtime" } },
      },
    } as unknown as ConversationToolCallRecord;
    const state = conversationState({
      messages: [message("forecast")],
      turns: [failed],
      tool_calls: [toolCall],
    });
    const attachment: ConversationAttachmentReference = {
      attachment_id: "attachment_1" as ConversationAttachmentReference["attachment_id"],
      media_type: "image/png",
      filename: "forecast.png",
    };

    render(
      <>
        <MessageList
          state={state}
          renderPart={(part) => <strong>part:{part.text}</strong>}
          renderToolResult={(result) => <code>result:{JSON.stringify(result.content)}</code>}
          renderToolCall={(call, renderedMessage, renderResult) => (
            <aside>
              tool:{call.name}:{renderedMessage?.role}
              {call.result && renderResult?.(call.result, call, renderedMessage)}
            </aside>
          )}
          renderError={(error) => <em>error:{
            typeof error === "object" && "message" in error ? error.message : "custom"
          }</em>}
        />
        <AttachmentList
          attachments={[attachment]}
          renderAttachment={(item) => <figure>attachment:{"filename" in item && item.filename}</figure>}
        />
      </>,
    );

    expect(screen.getByText("part:forecast")).toBeTruthy();
    expect(screen.getByText(/tool:lookup:assistant/u)).toBeTruthy();
    expect(screen.getByText(/result:/u)).toBeTruthy();
    expect(screen.getByText("error:Tool failed")).toBeTruthy();
    expect(screen.getByText("attachment:forecast.png")).toBeTruthy();
  });

  it("renders presence, typing, attachments, removal, and composer errors semantically", () => {
    const participant = {
      participant_id: "person_1",
      participant_kind: "human",
      state: "active",
      typing: true,
      updated_at: "2026-08-28T00:00:00.000Z",
      record_count: 1,
      records: [],
    } as unknown as PresenceParticipantSummary;
    const remove = vi.fn();
    const attachment: ConversationAttachmentReference = {
      attachment_id: "attachment_1" as ConversationAttachmentReference["attachment_id"],
      media_type: "image/png",
      filename: "photo.png",
    };
    render(
      <>
        <PresenceList participants={[participant]} />
        <TypingIndicator participants={[participant]} getParticipantName={() => "Alex"} />
        <AttachmentList attachments={[attachment]} onRemove={remove} />
        <ErrorList errors={["Could not send"]} />
      </>,
    );
    expect(screen.getByRole("list", { name: "Participants" }).textContent).toContain("person_1");
    expect(screen.getByText("Alex is typing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect(remove).toHaveBeenCalledWith("attachment_1");
    expect(screen.getByRole("list", { name: "Errors" }).textContent).toBe("Could not send");
  });

  it("hides local typing identities and presents assistant activity safely", () => {
    const local = {
      participant_id: "person_local", participant_kind: "human", state: "active",
      typing: true, updated_at: "2026-08-28T00:00:00.000Z", record_count: 1, records: [],
    } as unknown as PresenceParticipantSummary;
    const remote = {
      ...local, participant_id: "private_remote_identity",
      updated_at: "2026-08-28T00:00:01.000Z",
    } as unknown as PresenceParticipantSummary;
    const assistant = {
      ...local, participant_id: "private_assistant_identity", participant_kind: "assistant",
      typing: false, assistant_activity: "using_tool",
      updated_at: "2026-08-28T00:00:02.000Z",
    } as unknown as PresenceParticipantSummary;
    const snapshot = { localParticipantId: "person_local", participants: [local, remote, assistant] };
    const presence = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
    } as never;
    render(<><TypingIndicator presence={presence}/><AssistantActivityIndicator presence={presence}/></>);
    expect(screen.getByText("Someone is typing.")).toBeTruthy();
    expect(screen.queryByText(/private_/u)).toBeNull();
    expect(screen.getByText("Assistant is using a tool…")).toBeTruthy();
  });

  it("exposes accessible mixed attachment metadata, progress, and action seams", () => {
    const retryAttachment = vi.fn(() => true);
    const cancelAttachment = vi.fn(() => true);
    const removeAttachment = vi.fn(() => true);
    const pdf = new File(["pdf"], "guide.pdf", { type: "application/pdf" });
    const pending = {
      id: "attachment-upload-1",
      fingerprint: "browser-pdf:guide",
      source: pdf,
      filename: "guide.pdf",
      kind: "document",
      mediaType: "application/pdf",
      byteSize: pdf.size,
      status: "uploading",
      progress: { uploadedBytes: 2, totalBytes: pdf.size },
      retryable: false,
      cancellable: true,
    } as const;
    const image = new File(["image"], "retry.png", { type: "image/png" });
    const failed = {
      id: "attachment-upload-2",
      fingerprint: "browser-image:retry",
      source: image,
      filename: "retry.png",
      kind: "image",
      mediaType: "image/png",
      byteSize: image.size,
      previewUrl: "blob:retry",
      status: "failed",
      progress: { uploadedBytes: 1, totalBytes: image.size },
      error: { code: "upload_failed", message: "Upload failed", retryable: true },
      retryable: true,
      cancellable: false,
    } as const;
    const bindings = composer({
      attachments: [pending, failed],
      retryAttachment,
      cancelAttachment,
      removeAttachment,
    });

    render(<AttachmentList composer={bindings} aria-label="Pending attachments" />);
    const pdfItem = screen.getByRole("listitem", {
      name: "guide.pdf, document attachment, uploading",
    });
    expect(pdfItem.textContent).toContain("Kind: document");
    expect(pdfItem.textContent).toContain("Type: application/pdf");
    expect(within(pdfItem).getByRole("status").textContent).toBe("Status: uploading");
    expect(within(pdfItem).getByRole("progressbar", {
      name: "guide.pdf upload progress",
    }).getAttribute("value")).toBe("2");
    fireEvent.click(within(pdfItem).getByRole("button", { name: "Cancel guide.pdf" }));
    expect(cancelAttachment).toHaveBeenCalledWith("attachment-upload-1");

    const imageItem = screen.getByRole("listitem", {
      name: "retry.png, image attachment, failed",
    });
    fireEvent.click(within(imageItem).getByRole("button", { name: "Retry retry.png" }));
    fireEvent.click(within(imageItem).getByRole("button", { name: "Remove retry.png" }));
    expect(retryAttachment).toHaveBeenCalledWith("attachment-upload-2");
    expect(removeAttachment).toHaveBeenCalledWith("attachment-upload-2");

    const standalone = render(
      <AttachmentItem attachment={pending}>
        <AttachmentRetry attachment={failed}>Try again</AttachmentRetry>
        <AttachmentCancel>Stop upload</AttachmentCancel>
      </AttachmentItem>,
    );
    expect(within(standalone.container).getByRole("button", {
      name: "Retry retry.png",
    }).hasAttribute("disabled"))
      .toBe(true);
    expect(within(standalone.container).getByRole("button", {
      name: "Cancel guide.pdf",
    }).hasAttribute("disabled"))
      .toBe(true);
  });

  it("exposes accurate unavailable and busy action states", () => {
    render(
      <>
        <Submit composer={composer({ canSend: false, isSending: false })} />
        <Stop />
        <Retry busy onRetry={vi.fn()} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled"))
      .toBe(true);
    expect(screen.getByRole("button", { name: "Stop response" }).hasAttribute("disabled"))
      .toBe(true);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
  });

  it("allows completely custom composition without a root or presentation wrapper", () => {
    const bindings = composer();
    render(
      <main aria-label="Custom experience">
        <Message message={message("Standalone")} />
        <Form composer={bindings}>
          <Textarea composer={bindings} aria-label="Custom draft" />
          <Submit composer={bindings}>Go</Submit>
        </Form>
      </main>,
    );
    expect(screen.getByRole("main", { name: "Custom experience" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "assistant message" }).textContent)
      .toBe("Standalone");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(bindings.submit).toHaveBeenCalledOnce();
  });

  it("server-renders without stylesheets, injected styles, branding, or default classes", () => {
    const state = conversationState({ messages: [message("Server message")] });
    const markup = renderToString(
      <ChatRoot state={state}>
        <Transcript />
        <Form>
          <Textarea aria-label="Draft" defaultValue="selectable" />
          <FileInput />
          <Submit />
        </Form>
      </ChatRoot>,
    );
    expect(markup).toContain("Server message");
    expect(markup).not.toMatch(/<style|stylesheet|font-family|position:\s*fixed/iu);
    expect(markup).not.toContain("class=");
    expect(markup).not.toMatch(/handrail/iu);
  });
});
