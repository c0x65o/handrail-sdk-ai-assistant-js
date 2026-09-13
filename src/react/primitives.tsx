import {
  createContext,
  Fragment,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type FormEvent,
  type FormHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type LiHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import type { ConversationAttachmentReference } from "../conversation/events.js";
import type {
  ConversationAttachmentRecord,
  ConversationMessageRecord,
  ConversationReplayError,
  ConversationState,
  ConversationToolCallRecord,
  ConversationToolResultRecord,
  ConversationTurnRecord,
  ConversationTurnStateStatus,
} from "../conversation/state.js";
import type {
  PresenceController,
  PresenceControllerSnapshot,
} from "../presence/controller.js";
import type { AssistantActivity, PresenceParticipantSummary } from "../presence/types.js";
import { ConversationContext } from "./context.js";
import {
  PrimitiveContext,
  type PrimitiveContextValue,
  useResolvedState,
} from "./primitive-context.js";
import type {
  ConversationComposerAttachment,
  ConversationComposerError,
  ConversationComposerResult,
} from "./use-conversation-composer.js";

export type PrimitiveRender<Element extends HTMLElement, Props> = (
  props: Props,
  ref: ForwardedRef<Element>,
) => ReactNode;

export type PrimitiveError =
  | ConversationComposerError
  | ConversationReplayError
  | ConversationTurnRecord["error"]
  | Error
  | string
  | null
  | undefined;

export type MessagePartRenderer = (
  part: ConversationMessageRecord["content"][number],
  message: ConversationMessageRecord | undefined,
  index: number,
) => ReactNode;
export type MessageContentRenderer = (
  parts: ConversationMessageRecord["content"],
  message: ConversationMessageRecord | undefined,
) => ReactNode;
export type MessageAttachmentRenderer = (
  attachment: ConversationMessageRecord["attachments"][number],
  message: ConversationMessageRecord,
  index: number,
) => ReactNode;

export type ToolResultRenderer = (
  result: ConversationToolResultRecord,
  toolCall: ConversationToolCallRecord,
  message: ConversationMessageRecord | undefined,
) => ReactNode;

export type ToolCallRenderer = (
  toolCall: ConversationToolCallRecord,
  message: ConversationMessageRecord | undefined,
  renderResult: ToolResultRenderer | undefined,
) => ReactNode;

export type ErrorRenderer = (error: Exclude<PrimitiveError, null | undefined>) => ReactNode;

export type AttachmentPrimitiveValue =
  | ConversationComposerAttachment
  | ConversationAttachmentReference
  | ConversationAttachmentRecord;

export type AttachmentRenderer = (
  attachment: AttachmentPrimitiveValue,
  index: number,
) => ReactNode;

export type PresenceRenderer = (
  participant: PresenceParticipantSummary,
  index: number,
) => ReactNode;

const EMPTY_PRESENCE_SNAPSHOT: PresenceControllerSnapshot = Object.freeze({
  conversationId: null as never,
  connected: false,
  records: Object.freeze([]),
  participants: Object.freeze([]),
});

function useResolvedPresence(
  explicit?: PresenceController,
): PresenceControllerSnapshot | null {
  const primitives = useContext(PrimitiveContext);
  const controller = explicit ?? primitives?.presence ?? null;
  const subscribe = useCallback(
    (listener: () => void) => controller?.subscribe(() => listener()) ?? (() => undefined),
    [controller],
  );
  const getSnapshot = useCallback(
    () => controller?.getSnapshot() ?? EMPTY_PRESENCE_SNAPSHOT,
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return controller === null ? primitives?.presenceSnapshot ?? null : snapshot;
}

function useResolvedComposer(
  explicit?: ConversationComposerResult,
): ConversationComposerResult | null {
  const primitives = useContext(PrimitiveContext);
  return explicit ?? primitives?.composer ?? null;
}

function errorMessage(error: Exclude<PrimitiveError, null | undefined>): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if ("message" in error && typeof error.message === "string") return error.message;
  if ("type" in error) return String(error.type).replaceAll("_", " ");
  return "An error occurred.";
}

interface AttachmentReferenceLike {
  readonly attachment_id: string;
  readonly filename?: string;
  readonly media_type: string;
}

function attachmentReference(
  attachment: AttachmentPrimitiveValue,
): AttachmentReferenceLike | undefined {
  if ("reference" in attachment && "message_id" in attachment) {
    return attachment.reference;
  }
  if ("attachment_id" in attachment) return attachment;
  return attachment.reference;
}

function attachmentId(attachment: AttachmentPrimitiveValue): string {
  if ("id" in attachment) return attachment.id;
  return String(attachmentReference(attachment)?.attachment_id ?? "attachment");
}

function attachmentName(attachment: AttachmentPrimitiveValue): string {
  if ("filename" in attachment && attachment.filename) return attachment.filename;
  const reference = attachmentReference(attachment);
  return reference?.filename ?? reference?.media_type ??
    ("mediaType" in attachment ? attachment.mediaType : attachmentId(attachment));
}

function isComposerAttachment(
  attachment: AttachmentPrimitiveValue,
): attachment is ConversationComposerAttachment {
  return "progress" in attachment && "status" in attachment && "kind" in attachment;
}

function attachmentKind(attachment: AttachmentPrimitiveValue): "image" | "document" {
  if (isComposerAttachment(attachment)) return attachment.kind;
  return attachmentReference(attachment)?.media_type === "application/pdf"
    ? "document"
    : "image";
}

function attachmentMediaType(attachment: AttachmentPrimitiveValue): string {
  return isComposerAttachment(attachment)
    ? attachment.mediaType
    : attachmentReference(attachment)?.media_type ?? "unknown";
}

function latestTurn(state: ConversationState | undefined): ConversationTurnRecord | undefined {
  if (!state || state.turns.length === 0) return undefined;
  if (state.active_turn_id !== null) {
    return state.turns.find((turn) => turn.turn_id === state.active_turn_id) ??
      state.turns.at(-1);
  }
  return state.turns.at(-1);
}

function statusLabel(status: StreamStatusValue): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Responding";
    case "waiting_for_tool_result": return "Waiting for a tool result";
    case "completed": return "Complete";
    case "cancelled": return "Cancelled";
    case "failed": return "Failed";
    case "idle": return "Idle";
  }
}

function isBusyStatus(status: StreamStatusValue): boolean {
  return status === "queued" || status === "running" ||
    status === "waiting_for_tool_result";
}

export interface ChatRootProps extends HTMLAttributes<HTMLDivElement> {
  composer?: ConversationComposerResult;
  presence?: PresenceController;
  state?: ConversationState;
  render?: PrimitiveRender<HTMLDivElement, HTMLAttributes<HTMLDivElement>>;
}

/** Optional native root and context bridge. Every child primitive also works without it. */
export const ChatRoot = forwardRef<HTMLDivElement, ChatRootProps>(function ChatRoot(
  { composer, presence, render, state: explicitState, ...props },
  forwardedRef,
) {
  const outer = useContext(PrimitiveContext);
  const state = useResolvedState(explicitState);
  const presenceSnapshot = useResolvedPresence(presence);
  const value = useMemo<PrimitiveContextValue>(() => ({
    composer: composer ?? outer?.composer ?? null,
    presence: presence ?? outer?.presence ?? null,
    presenceSnapshot,
    state,
  }), [composer, outer?.composer, outer?.presence, presence, presenceSnapshot, state]);
  const nativeProps: HTMLAttributes<HTMLDivElement> = {
    ...props,
    "aria-busy": props["aria-busy"] ??
      Boolean(value.composer?.isSending || value.state?.active_turn_id),
  };
  return (
    <PrimitiveContext.Provider value={value}>
      {render ? render(nativeProps, forwardedRef) : <div {...nativeProps} ref={forwardedRef} />}
    </PrimitiveContext.Provider>
  );
});

interface MessageCollectionOptions {
  error?: PrimitiveError;
  messages?: readonly ConversationMessageRecord[];
  renderError?: ErrorRenderer;
  renderMessage?: (
    message: ConversationMessageRecord,
    index: number,
    context: {
      readonly error: PrimitiveError;
      readonly toolCalls: readonly ConversationToolCallRecord[];
    },
  ) => ReactNode;
  renderContent?: MessageContentRenderer;
  renderPart?: MessagePartRenderer;
  renderAttachment?: MessageAttachmentRenderer;
  renderToolCall?: ToolCallRenderer;
  renderToolResult?: ToolResultRenderer;
  state?: ConversationState;
  toolCalls?: readonly ConversationToolCallRecord[];
  turns?: readonly ConversationTurnRecord[];
}

function messageContext(
  message: ConversationMessageRecord,
  turns: readonly ConversationTurnRecord[],
  toolCalls: readonly ConversationToolCallRecord[],
): { error: PrimitiveError; toolCalls: readonly ConversationToolCallRecord[] } {
  const turn = [...turns].reverse().find((candidate) =>
    candidate.output_message_ids.includes(message.message_id));
  if (!turn) return { error: undefined, toolCalls: [] };
  return {
    error: turn.error,
    toolCalls: toolCalls.filter((toolCall) => toolCall.turn_id === turn.turn_id),
  };
}

export interface TranscriptProps
  extends Omit<HTMLAttributes<HTMLElement>, "children">,
    MessageCollectionOptions {
  children?: ReactNode;
  render?: PrimitiveRender<HTMLElement, HTMLAttributes<HTMLElement>>;
}

export const Transcript = forwardRef<HTMLElement, TranscriptProps>(function Transcript(
  { children, render, ...props },
  forwardedRef,
) {
  const {
    error,
    messages,
    renderContent,
    renderError,
    renderMessage,
    renderPart,
    renderAttachment,
    renderToolCall,
    renderToolResult,
    state,
    toolCalls,
    turns,
    ...nativeProps
  } = props;
  const content = children ?? (
    <MessageList
      {...(error === undefined ? {} : { error })}
      {...(messages === undefined ? {} : { messages })}
      {...(renderContent === undefined ? {} : { renderContent })}
      {...(renderError === undefined ? {} : { renderError })}
      {...(renderMessage === undefined ? {} : { renderMessage })}
      {...(renderPart === undefined ? {} : { renderPart })}
      {...(renderAttachment === undefined ? {} : { renderAttachment })}
      {...(renderToolCall === undefined ? {} : { renderToolCall })}
      {...(renderToolResult === undefined ? {} : { renderToolResult })}
      {...(state === undefined ? {} : { state })}
      {...(toolCalls === undefined ? {} : { toolCalls })}
      {...(turns === undefined ? {} : { turns })}
    />
  );
  const elementProps: HTMLAttributes<HTMLElement> = {
    ...nativeProps,
    children: content,
    role: nativeProps.role ?? "region",
    "aria-label": nativeProps["aria-label"] ?? "Conversation transcript",
  };
  return render
    ? render(elementProps, forwardedRef)
    : <section {...elementProps} ref={forwardedRef} />;
});

export interface MessageListProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    MessageCollectionOptions {
  children?: ReactNode;
  render?: PrimitiveRender<HTMLDivElement, HTMLAttributes<HTMLDivElement>>;
}

export const MessageList = forwardRef<HTMLDivElement, MessageListProps>(
  function MessageList(
    {
      children,
      error,
      messages: explicitMessages,
      render,
      renderContent,
      renderError,
      renderMessage,
      renderPart,
      renderAttachment,
      renderToolCall,
      renderToolResult,
      state: explicitState,
      toolCalls: explicitToolCalls,
      turns: explicitTurns,
      ...props
    },
    forwardedRef,
  ) {
    const state = useResolvedState(explicitState);
    const messages = explicitMessages ?? state?.messages ?? [];
    const turns = explicitTurns ?? state?.turns ?? [];
    const toolCalls = explicitToolCalls ?? state?.tool_calls ?? [];
    const resolvedError = error ?? state?.replay_error;
    const content = children ?? <>
      {messages.map((message, index) => {
        const context = messageContext(message, turns, toolCalls);
        return renderMessage
          ? <Fragment key={message.message_id}>{renderMessage(message, index, context)}</Fragment>
          : (
            <Message
              key={message.message_id}
              message={message}
              error={context.error}
              toolCalls={context.toolCalls}
              {...(renderContent === undefined ? {} : { renderContent })}
              {...(renderError === undefined ? {} : { renderError })}
              {...(renderPart === undefined ? {} : { renderPart })}
              {...(renderAttachment === undefined ? {} : { renderAttachment })}
              {...(renderToolCall === undefined ? {} : { renderToolCall })}
              {...(renderToolResult === undefined ? {} : { renderToolResult })}
            />
          );
      })}
      {resolvedError == null ? null : (
        <div role="alert">
          {renderError ? renderError(resolvedError) : errorMessage(resolvedError)}
        </div>
      )}
    </>;
    const nativeProps: HTMLAttributes<HTMLDivElement> = {
      ...props,
      children: content,
      role: props.role ?? "list",
      "aria-label": props["aria-label"] ?? "Messages",
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <div {...nativeProps} ref={forwardedRef} />;
  },
);

export interface MessageProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  children?: ReactNode;
  error?: PrimitiveError;
  message?: ConversationMessageRecord;
  parts?: ConversationMessageRecord["content"];
  render?: PrimitiveRender<HTMLElement, HTMLAttributes<HTMLElement>>;
  renderContent?: MessageContentRenderer;
  renderError?: ErrorRenderer;
  renderPart?: MessagePartRenderer;
  renderAttachment?: MessageAttachmentRenderer;
  renderToolCall?: ToolCallRenderer;
  renderToolResult?: ToolResultRenderer;
  toolCalls?: readonly ConversationToolCallRecord[];
}

export const Message = forwardRef<HTMLElement, MessageProps>(function Message(
  {
    children,
    error,
    message,
    parts,
    render,
    renderContent,
    renderError,
    renderPart,
    renderAttachment,
    renderToolCall,
    renderToolResult,
    toolCalls = [],
    ...props
  },
  forwardedRef,
) {
  const content = children ?? <>
    {renderContent
      ? renderContent(parts ?? message?.content ?? [], message)
      : (parts ?? message?.content ?? []).map((part, index) => (
        <MessagePart
          key={index}
          part={part}
          index={index}
          {...(message === undefined ? {} : { message })}
          {...(renderPart === undefined ? {} : { renderPart })}
        />
      ))}
    {message?.attachments.length ? <ul aria-label="Message attachments">
      {message.attachments.map((attachment, index) => <li key={attachment.attachment_id}>
        {renderAttachment
          ? renderAttachment(attachment, message, index)
          : attachment.filename ?? attachment.media_type}
      </li>)}
    </ul> : null}
    {toolCalls.map((toolCall) => (
      <div key={toolCall.tool_call_id}>
        {renderToolCall
          ? renderToolCall(toolCall, message, renderToolResult)
          : <>
              <span>{toolCall.name ?? "Tool"}</span>
              {toolCall.result === null ? null : (
                renderToolResult
                  ? renderToolResult(toolCall.result, toolCall, message)
                  : <ToolResult result={toolCall.result} />
              )}
            </>}
      </div>
    ))}
    {error == null ? null : (
      <div role="alert">{renderError ? renderError(error) : errorMessage(error)}</div>
    )}
  </>;
  const role = message?.role;
  const nativeProps: HTMLAttributes<HTMLElement> = {
    ...props,
    children: content,
    role: props.role ?? "listitem",
    "aria-label": props["aria-label"] ?? (role ? `${role} message` : "Message"),
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <article {...nativeProps} ref={forwardedRef} />;
});

export interface MessagePartProps extends Omit<HTMLAttributes<HTMLSpanElement>, "part"> {
  index?: number;
  message?: ConversationMessageRecord;
  part: ConversationMessageRecord["content"][number];
  renderPart?: MessagePartRenderer;
}

export const MessagePart = forwardRef<HTMLSpanElement, MessagePartProps>(
  function MessagePart(
    { children, index = 0, message, part, renderPart, ...props },
    forwardedRef,
  ) {
    return (
      <span {...props} ref={forwardedRef}>
        {children ?? (renderPart ? renderPart(part, message, index) : part.text)}
      </span>
    );
  },
);

export interface ToolResultProps extends HTMLAttributes<HTMLDivElement> {
  result: ConversationToolResultRecord;
}

export const ToolResult = forwardRef<HTMLDivElement, ToolResultProps>(
  function ToolResult({ children, result, ...props }, forwardedRef) {
    return (
      <div {...props} ref={forwardedRef}>
        {children ?? result.content.map((part, index) => (
          <span key={index}>
            {part.type === "text" ? part.text : JSON.stringify(part.value)}
          </span>
        ))}
      </div>
    );
  },
);

export type StreamStatusValue = ConversationTurnStateStatus | "idle";

export interface StreamStatusProps extends HTMLAttributes<HTMLSpanElement> {
  renderStatus?: (status: StreamStatusValue) => ReactNode;
  state?: ConversationState;
  status?: StreamStatusValue;
}

export const StreamStatus = forwardRef<HTMLSpanElement, StreamStatusProps>(
  function StreamStatus(
    { children, renderStatus, state: explicitState, status, ...props },
    forwardedRef,
  ) {
    const state = useResolvedState(explicitState);
    const resolvedStatus = status ?? latestTurn(state)?.status ?? "idle";
    return (
      <span
        {...props}
        ref={forwardedRef}
        role={props.role ?? "status"}
        aria-live={props["aria-live"] ?? "polite"}
        aria-busy={props["aria-busy"] ?? isBusyStatus(resolvedStatus)}
      >
        {children ?? (renderStatus
          ? renderStatus(resolvedStatus)
          : statusLabel(resolvedStatus))}
      </span>
    );
  },
);

export interface LiveRegionProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children?: ReactNode | ((announcement: string) => ReactNode);
  completionMessage?: string;
  error?: PrimitiveError;
  renderError?: ErrorRenderer;
  state?: ConversationState;
  status?: StreamStatusValue;
}

/** Announces status boundaries only; message content is deliberately never read here. */
export const LiveRegion = forwardRef<HTMLDivElement, LiveRegionProps>(
  function LiveRegion(
    {
      children,
      completionMessage = "Response complete.",
      error: explicitError,
      renderError,
      state: explicitState,
      status,
      ...props
    },
    forwardedRef,
  ) {
    const state = useResolvedState(explicitState);
    const turn = latestTurn(state);
    const resolvedStatus = status ?? turn?.status ?? "idle";
    const resolvedError = explicitError ?? turn?.error ?? state?.replay_error;
    const errorText = resolvedError == null ? "" : errorMessage(resolvedError);
    const transition = `${String(turn?.turn_id ?? "")}:${resolvedStatus}:${errorText}`;
    const previousTransition = useRef<string | null>(null);
    const [announcement, setAnnouncement] = useState("");

    useEffect(() => {
      if (previousTransition.current === transition) return;
      previousTransition.current = transition;
      if (resolvedError != null || resolvedStatus === "failed") {
        setAnnouncement(errorText || "Response failed.");
      } else if (resolvedStatus === "completed") {
        setAnnouncement(completionMessage);
      } else if (resolvedStatus === "cancelled") {
        setAnnouncement("Response cancelled.");
      } else if (resolvedStatus === "queued") {
        setAnnouncement("Response queued.");
      } else if (resolvedStatus === "running") {
        setAnnouncement("Response started.");
      } else if (resolvedStatus === "waiting_for_tool_result") {
        setAnnouncement("Waiting for a tool result.");
      } else {
        setAnnouncement("");
      }
    }, [completionMessage, errorText, resolvedError, resolvedStatus, transition]);

    let content: ReactNode;
    if (typeof children === "function") content = children(announcement);
    else if (children !== undefined) content = children;
    else if (resolvedError != null && renderError) content = renderError(resolvedError);
    else content = announcement;

    return (
      <div
        {...props}
        ref={forwardedRef}
        role={props.role ?? "status"}
        aria-live={props["aria-live"] ?? "polite"}
        aria-atomic={props["aria-atomic"] ?? true}
      >
        {content}
      </div>
    );
  },
);

export interface PresenceListProps extends Omit<HTMLAttributes<HTMLUListElement>, "children"> {
  children?: ReactNode;
  participants?: readonly PresenceParticipantSummary[];
  presence?: PresenceController;
  renderParticipant?: PresenceRenderer;
}

export const PresenceList = forwardRef<HTMLUListElement, PresenceListProps>(
  function PresenceList(
    { children, participants: explicitParticipants, presence, renderParticipant, ...props },
    forwardedRef,
  ) {
    const snapshot = useResolvedPresence(presence);
    const participants = explicitParticipants ?? snapshot?.participants ?? [];
    return (
      <ul
        {...props}
        ref={forwardedRef}
        aria-label={props["aria-label"] ?? "Participants"}
      >
        {children ?? participants.map((participant, index) => (
          <li key={participant.participant_id}>
            {renderParticipant
              ? renderParticipant(participant, index)
              : String(participant.participant_id)}
          </li>
        ))}
      </ul>
    );
  },
);

export interface TypingIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  getParticipantName?: (participant: PresenceParticipantSummary) => string;
  /** Include the connected controller's local participant. Defaults false. */
  includeSelf?: boolean;
  participants?: readonly PresenceParticipantSummary[];
  presence?: PresenceController;
  renderTyping?: (participants: readonly PresenceParticipantSummary[]) => ReactNode;
}

export const TypingIndicator = forwardRef<HTMLSpanElement, TypingIndicatorProps>(
  function TypingIndicator(
    {
      children,
      getParticipantName = (participant) => participant.participant_kind === "assistant" ? "Assistant" : "Someone",
      includeSelf = false,
      participants: explicitParticipants,
      presence,
      renderTyping,
      ...props
    },
    forwardedRef,
  ) {
    const snapshot = useResolvedPresence(presence);
    const typing = (explicitParticipants ?? snapshot?.participants ?? [])
      .filter((participant) => participant.typing &&
        (includeSelf || snapshot == null || participant.participant_id !== snapshot.localParticipantId));
    const names = typing.map(getParticipantName);
    const defaultContent = names.length === 0
      ? ""
      : `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing.`;
    return (
      <span
        {...props}
        ref={forwardedRef}
        role={props.role ?? "status"}
        aria-live={props["aria-live"] ?? "polite"}
      >
        {children ?? (renderTyping ? renderTyping(typing) : defaultContent)}
      </span>
    );
  },
);

export interface AssistantActivityIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  participants?: readonly PresenceParticipantSummary[];
  presence?: PresenceController;
  renderActivity?: (activity: AssistantActivity | null) => ReactNode;
}

/** Render the freshest assistant activity without exposing its session identity. */
export const AssistantActivityIndicator = forwardRef<HTMLSpanElement, AssistantActivityIndicatorProps>(
  function AssistantActivityIndicator(
    { children, participants: explicitParticipants, presence, renderActivity, ...props },
    forwardedRef,
  ) {
    const snapshot = useResolvedPresence(presence);
    const assistant = (explicitParticipants ?? snapshot?.participants ?? [])
      .filter((participant) => participant.participant_kind === "assistant" && participant.assistant_activity)
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0];
    const activity = assistant?.assistant_activity ?? null;
    const content = activity === "thinking" ? "Assistant is thinking…"
      : activity === "responding" ? "Assistant is responding…"
        : activity === "using_tool" ? "Assistant is using a tool…" : "";
    return <span {...props} ref={forwardedRef} role={props.role ?? "status"}
      aria-live={props["aria-live"] ?? "polite"}>
      {children ?? (renderActivity ? renderActivity(activity) : content)}
    </span>;
  },
);

interface AttachmentContextValue {
  readonly attachment: AttachmentPrimitiveValue;
  readonly onCancel?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  readonly onRemove?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  readonly onRetry?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

export interface AttachmentListProps
  extends Omit<HTMLAttributes<HTMLUListElement>, "children"> {
  /** Show manual upload recovery in custom headless surfaces. */
  showRetry?: boolean;
  attachments?: readonly AttachmentPrimitiveValue[];
  children?: ReactNode;
  composer?: ConversationComposerResult;
  onCancel?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  onRemove?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  onRetry?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  renderAttachment?: AttachmentRenderer;
  renderError?: ErrorRenderer;
}

export const AttachmentList = forwardRef<HTMLUListElement, AttachmentListProps>(
  function AttachmentList(
    {
      attachments: explicitAttachments,
      children,
      composer: explicitComposer,
      onCancel,
      onRemove,
      onRetry,
      showRetry = true,
      renderAttachment,
      renderError,
      ...props
    },
    forwardedRef,
  ) {
    const composer = useResolvedComposer(explicitComposer);
    const attachments = explicitAttachments ?? composer?.attachments ?? [];
    const cancel = onCancel ?? composer?.cancelAttachment;
    const remove = onRemove ?? composer?.removeAttachment;
    const retry = showRetry ? onRetry ?? composer?.retryAttachment : undefined;
    return (
      <ul
        {...props}
        ref={forwardedRef}
        aria-label={props["aria-label"] ?? "Attachments"}
      >
        {children ?? attachments.map((attachment, index) => (
          <AttachmentItem
            key={attachmentId(attachment)}
            attachment={attachment}
            index={index}
            {...(cancel === undefined ? {} : { onCancel: cancel })}
            {...(remove === undefined ? {} : { onRemove: remove })}
            {...(retry === undefined ? {} : { onRetry: retry })}
            {...(renderAttachment === undefined ? {} : { renderAttachment })}
            {...(renderError === undefined ? {} : { renderError })}
          />
        ))}
      </ul>
    );
  },
);

export interface AttachmentItemProps extends Omit<LiHTMLAttributes<HTMLLIElement>, "children"> {
  attachment: AttachmentPrimitiveValue;
  children?: ReactNode;
  index?: number;
  onCancel?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  onRemove?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  onRetry?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
  renderAttachment?: AttachmentRenderer;
  renderError?: ErrorRenderer;
}

export const AttachmentItem = forwardRef<HTMLLIElement, AttachmentItemProps>(
  function AttachmentItem(
    {
      attachment,
      children,
      index = 0,
      onCancel,
      onRemove,
      onRetry,
      renderAttachment,
      renderError,
      ...props
    },
    forwardedRef,
  ) {
    const value = useMemo<AttachmentContextValue>(
      () => ({
        attachment,
        ...(onCancel === undefined ? {} : { onCancel }),
        ...(onRemove === undefined ? {} : { onRemove }),
        ...(onRetry === undefined ? {} : { onRetry }),
      }),
      [attachment, onCancel, onRemove, onRetry],
    );
    const attachmentError = "error" in attachment ? attachment.error : undefined;
    const name = attachmentName(attachment);
    const kind = attachmentKind(attachment);
    const composerAttachment = isComposerAttachment(attachment) ? attachment : undefined;
    return (
      <AttachmentContext.Provider value={value}>
        <li
          {...props}
          ref={forwardedRef}
          aria-label={props["aria-label"] ?? (
            composerAttachment === undefined
              ? `${name}, ${kind} attachment`
              : `${name}, ${kind} attachment, ${composerAttachment.status}`
          )}
        >
          {children ?? <>
            {renderAttachment
              ? renderAttachment(attachment, index)
              : <>
                <span>{name}</span>
                <span>Kind: {kind}</span>
                <span>Type: {attachmentMediaType(attachment)}</span>
                {composerAttachment === undefined ? null : <>
                  <span role="status">Status: {composerAttachment.status}</span>
                  <progress
                    aria-label={`${name} upload progress`}
                    max={Math.max(composerAttachment.progress.totalBytes, 1)}
                    value={Math.min(
                      composerAttachment.progress.uploadedBytes,
                      Math.max(composerAttachment.progress.totalBytes, 1),
                    )}
                  />
                </>}
              </>}
            {attachmentError === undefined ? null : (
              <span role="alert">
                {renderError ? renderError(attachmentError) : attachmentError.message}
              </span>
            )}
            {composerAttachment?.retryable && onRetry ? <AttachmentRetry /> : null}
            {composerAttachment?.cancellable && onCancel ? <AttachmentCancel /> : null}
            {onRemove === undefined ? null : <AttachmentRemove />}
          </>}
        </li>
      </AttachmentContext.Provider>
    );
  },
);

export interface AttachmentRetryProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  attachment?: AttachmentPrimitiveValue;
  attachmentId?: string;
  onRetry?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
}

export const AttachmentRetry = forwardRef<HTMLButtonElement, AttachmentRetryProps>(
  function AttachmentRetry(
    {
      attachment: explicitAttachment,
      attachmentId: explicitId,
      children,
      disabled,
      onClick,
      onRetry,
      type,
      ...props
    },
    forwardedRef,
  ) {
    const context = useContext(AttachmentContext);
    const attachment = explicitAttachment ?? context?.attachment;
    const id = explicitId ?? (attachment ? attachmentId(attachment) : undefined);
    const retry = onRetry ?? context?.onRetry;
    const retryable = attachment !== undefined && isComposerAttachment(attachment)
      ? attachment.retryable
      : true;
    return (
      <button
        {...props}
        ref={forwardedRef}
        type={type ?? "button"}
        disabled={Boolean(disabled || !retry || !id || !retryable)}
        aria-label={props["aria-label"] ??
          `Retry ${attachment ? attachmentName(attachment) : "attachment"}`}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && retry && id) void retry(id);
        }}
      >
        {children ?? "Retry"}
      </button>
    );
  },
);

export interface AttachmentCancelProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  attachment?: AttachmentPrimitiveValue;
  attachmentId?: string;
  onCancel?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
}

export const AttachmentCancel = forwardRef<HTMLButtonElement, AttachmentCancelProps>(
  function AttachmentCancel(
    {
      attachment: explicitAttachment,
      attachmentId: explicitId,
      children,
      disabled,
      onCancel,
      onClick,
      type,
      ...props
    },
    forwardedRef,
  ) {
    const context = useContext(AttachmentContext);
    const attachment = explicitAttachment ?? context?.attachment;
    const id = explicitId ?? (attachment ? attachmentId(attachment) : undefined);
    const cancel = onCancel ?? context?.onCancel;
    const cancellable = attachment !== undefined && isComposerAttachment(attachment)
      ? attachment.cancellable
      : true;
    return (
      <button
        {...props}
        ref={forwardedRef}
        type={type ?? "button"}
        disabled={Boolean(disabled || !cancel || !id || !cancellable)}
        aria-label={props["aria-label"] ??
          `Cancel ${attachment ? attachmentName(attachment) : "attachment"}`}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && cancel && id) void cancel(id);
        }}
      >
        {children ?? "Cancel"}
      </button>
    );
  },
);

export interface AttachmentRemoveProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  attachment?: AttachmentPrimitiveValue;
  attachmentId?: string;
  onRemove?: (attachmentId: string) => void | boolean | Promise<void | boolean>;
}

export const AttachmentRemove = forwardRef<HTMLButtonElement, AttachmentRemoveProps>(
  function AttachmentRemove(
    {
      attachment: explicitAttachment,
      attachmentId: explicitId,
      children,
      disabled,
      onClick,
      onRemove,
      type,
      ...props
    },
    forwardedRef,
  ) {
    const context = useContext(AttachmentContext);
    const attachment = explicitAttachment ?? context?.attachment;
    const id = explicitId ?? (attachment ? attachmentId(attachment) : undefined);
    const remove = onRemove ?? context?.onRemove;
    return (
      <button
        {...props}
        ref={forwardedRef}
        type={type ?? "button"}
        disabled={Boolean(disabled || !remove || !id)}
        aria-label={props["aria-label"] ??
          `Remove ${attachment ? attachmentName(attachment) : "attachment"}`}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && remove && id) void remove(id);
        }}
      >
        {children ?? "Remove"}
      </button>
    );
  },
);

export interface ComposerProps extends HTMLAttributes<HTMLDivElement> {
  composer?: ConversationComposerResult;
  render?: PrimitiveRender<HTMLDivElement, HTMLAttributes<HTMLDivElement>>;
}

export const Composer = forwardRef<HTMLDivElement, ComposerProps>(function Composer(
  { composer: explicitComposer, onDragOver, onDrop, render, ...props },
  forwardedRef,
) {
  const outer = useContext(PrimitiveContext);
  const composer = explicitComposer ?? outer?.composer ?? null;
  const drop = composer?.getDropProps();
  const value = useMemo<PrimitiveContextValue>(() => ({
    composer,
    presence: outer?.presence ?? null,
    presenceSnapshot: outer?.presenceSnapshot ?? null,
    state: outer?.state,
  }), [composer, outer?.presence, outer?.presenceSnapshot, outer?.state]);
  const nativeProps: HTMLAttributes<HTMLDivElement> = {
    ...props,
    "aria-busy": props["aria-busy"] ?? Boolean(composer?.isSending),
    onDragOver: (event) => {
      onDragOver?.(event);
      if (!event.defaultPrevented) drop?.onDragOver?.(event);
    },
    onDrop: (event) => {
      onDrop?.(event);
      if (!event.defaultPrevented) drop?.onDrop(event);
    },
  };
  return (
    <PrimitiveContext.Provider value={value}>
      {render ? render(nativeProps, forwardedRef) : <div {...nativeProps} ref={forwardedRef} />}
    </PrimitiveContext.Provider>
  );
});

export interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  composer?: ConversationComposerResult;
  onSubmitAction?: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

export const Form = forwardRef<HTMLFormElement, FormProps>(function Form(
  { composer: explicitComposer, onSubmit, onSubmitAction, ...props },
  forwardedRef,
) {
  const composer = useResolvedComposer(explicitComposer);
  return (
    <form
      {...props}
      ref={forwardedRef}
      aria-label={props["aria-label"] ?? "Message composer"}
      aria-busy={props["aria-busy"] ?? Boolean(composer?.isSending)}
      onSubmit={(event) => {
        onSubmit?.(event);
        if (event.defaultPrevented) return;
        if (onSubmitAction) {
          event.preventDefault();
          void onSubmitAction(event);
        } else if (composer) {
          void composer.submit(event);
        }
      }}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  composer?: ConversationComposerResult;
  onValueChange?: (value: string) => void;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    {
      composer: explicitComposer,
      disabled,
      onBlur,
      onChange,
      onCompositionEnd,
      onCompositionStart,
      onKeyDown,
      onPaste,
      onValueChange,
      value,
      ...props
    },
    forwardedRef,
  ) {
    const composer = useResolvedComposer(explicitComposer);
    const bindings = composer?.getTextareaProps();
    return (
      <textarea
        {...props}
        ref={forwardedRef}
        value={value ?? bindings?.value}
        disabled={Boolean(disabled)}
        aria-busy={props["aria-busy"] ?? Boolean(composer?.isSending)}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          onChange?.(event);
          if (event.defaultPrevented) return;
          if (onValueChange) onValueChange(event.currentTarget.value);
          else bindings?.onChange(event);
        }}
        onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
          onPaste?.(event);
          if (!event.defaultPrevented) bindings?.onPaste(event);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          if (!event.defaultPrevented) bindings?.onBlur();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) bindings?.onKeyDown(event);
        }}
        onCompositionStart={(event: CompositionEvent<HTMLTextAreaElement>) => {
          onCompositionStart?.(event);
          if (!event.defaultPrevented) bindings?.onCompositionStart(event);
        }}
        onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
          onCompositionEnd?.(event);
          if (!event.defaultPrevented) bindings?.onCompositionEnd(event);
        }}
      />
    );
  },
);

export interface FileInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  composer?: ConversationComposerResult;
}

export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(
  function FileInput(
    { accept, composer: explicitComposer, disabled, multiple, onChange, ...props },
    forwardedRef,
  ) {
    const composer = useResolvedComposer(explicitComposer);
    const bindings = composer?.getFileInputProps();
    return (
      <input
        {...props}
        ref={forwardedRef}
        type="file"
        accept={accept ?? bindings?.accept}
        multiple={multiple ?? bindings?.multiple}
        disabled={Boolean(disabled || composer?.isSending)}
        aria-label={props["aria-label"] ?? "Attach files"}
        aria-busy={props["aria-busy"] ?? Boolean(composer?.isSending)}
        onChange={(event) => {
          onChange?.(event);
          if (!event.defaultPrevented) bindings?.onChange(event);
        }}
      />
    );
  },
);

export interface SubmitProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  composer?: ConversationComposerResult;
  busy?: boolean;
}

/** A native submit button. Submission behavior belongs exclusively to the parent Form. */
export const Submit = forwardRef<HTMLButtonElement, SubmitProps>(function Submit(
  { busy, children, composer: explicitComposer, disabled, type, ...props },
  forwardedRef,
) {
  const composer = useResolvedComposer(explicitComposer);
  const isBusy = busy ?? composer?.isSending ?? false;
  return (
    <button
      {...props}
      ref={forwardedRef}
      type={type ?? "submit"}
      disabled={Boolean(disabled || isBusy || (composer && !composer.canSend))}
      aria-label={props["aria-label"] ?? "Send message"}
      aria-busy={props["aria-busy"] ?? isBusy}
    >
      {children ?? "Send"}
    </button>
  );
});

export interface StopProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  available?: boolean;
  busy?: boolean;
  composer?: ConversationComposerResult;
  onStop?: () => void | Promise<void | boolean>;
  state?: ConversationState;
}

export const Stop = forwardRef<HTMLButtonElement, StopProps>(function Stop(
  {
    available,
    busy = false,
    children,
    composer: explicitComposer,
    disabled,
    onClick,
    onStop,
    state: explicitState,
    type,
    ...props
  },
  forwardedRef,
) {
  const composer = useResolvedComposer(explicitComposer);
  const state = useResolvedState(explicitState);
  const stop = onStop ?? composer?.stop;
  const isAvailable = available ?? Boolean(
    stop && (onStop || composer?.isSending || state?.active_turn_id),
  );
  return (
    <button
      {...props}
      ref={forwardedRef}
      type={type ?? "button"}
      disabled={Boolean(disabled || busy || !isAvailable)}
      aria-label={props["aria-label"] ?? "Stop response"}
      aria-busy={props["aria-busy"] ?? busy}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && stop) void stop();
      }}
    >
      {children ?? "Stop"}
    </button>
  );
});

export interface RetryProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  attachmentId?: string;
  available?: boolean;
  busy?: boolean;
  composer?: ConversationComposerResult;
  onRetry?: () => void | boolean | Promise<void | boolean>;
  state?: ConversationState;
  turnId?: ConversationTurnRecord["turn_id"];
}

export const Retry = forwardRef<HTMLButtonElement, RetryProps>(function Retry(
  {
    attachmentId: retryAttachmentId,
    available,
    busy = false,
    children,
    composer: explicitComposer,
    disabled,
    onClick,
    onRetry,
    state: explicitState,
    turnId,
    type,
    ...props
  },
  forwardedRef,
) {
  const composer = useResolvedComposer(explicitComposer);
  const state = useResolvedState(explicitState);
  const binding = useContext(ConversationContext);
  const failedTurn = turnId === undefined
    ? [...(state?.turns ?? [])].reverse().find((turn) => turn.status === "failed")
    : state?.turns.find((turn) => turn.turn_id === turnId);
  const retry = onRetry ?? (
    retryAttachmentId !== undefined && composer
      ? () => composer.retryAttachment(retryAttachmentId)
      : failedTurn && binding?.runtime
        ? () => binding.runtime?.resumeTurn(failedTurn.turn_id)
        : undefined
  );
  const isAvailable = available ?? Boolean(
    retry && (onRetry || retryAttachmentId || failedTurn?.error?.retryable),
  );
  return (
    <button
      {...props}
      ref={forwardedRef}
      type={type ?? "button"}
      disabled={Boolean(disabled || busy || !isAvailable)}
      aria-label={props["aria-label"] ?? "Retry"}
      aria-busy={props["aria-busy"] ?? busy}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && retry) void retry();
      }}
    >
      {children ?? "Retry"}
    </button>
  );
});

export interface ErrorListProps extends Omit<HTMLAttributes<HTMLUListElement>, "children"> {
  children?: ReactNode;
  composer?: ConversationComposerResult;
  errors?: readonly Exclude<PrimitiveError, null | undefined>[];
  renderError?: ErrorRenderer;
}

export const ErrorList = forwardRef<HTMLUListElement, ErrorListProps>(
  function ErrorList(
    { children, composer: explicitComposer, errors: explicitErrors, renderError, ...props },
    forwardedRef,
  ) {
    const composer = useResolvedComposer(explicitComposer);
    const errors = explicitErrors ?? composer?.errors ?? [];
    return (
      <ul {...props} ref={forwardedRef} aria-label={props["aria-label"] ?? "Errors"}>
        {children ?? errors.map((error, index) => (
          <li key={index}>
            {renderError ? renderError(error) : errorMessage(error)}
          </li>
        ))}
      </ul>
    );
  },
);

// Descriptive aliases let consumers choose a terse compound API or explicit imports.
export const ComposerForm = Form;
export const ComposerTextarea = Textarea;
export const ComposerFileInput = FileInput;
export const ComposerSubmit = Submit;
export const ComposerStop = Stop;
export const ComposerRetry = Retry;
export const ComposerErrorList = ErrorList;

export type ComposerFormProps = FormProps;
export type ComposerTextareaProps = TextareaProps;
export type ComposerFileInputProps = FileInputProps;
export type ComposerSubmitProps = SubmitProps;
export type ComposerStopProps = StopProps;
export type ComposerRetryProps = RetryProps;
export type ComposerErrorListProps = ErrorListProps;
