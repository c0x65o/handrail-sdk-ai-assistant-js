import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import type { ConversationMessageRecord } from "../conversation/state.js";
import {
  createBadResponseReportRequest, parseBadResponseReportReceipt,
  type BadResponseReportingOptions, type BadResponseReportRequest,
} from "../response-feedback.js";

export interface BadResponseButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly conversationId: string;
  readonly message: ConversationMessageRecord;
  readonly reporting?: BadResponseReportingOptions;
}

/** Opt-in action for a host-authorized assistant response. No transcript content is submitted. */
export function BadResponseButton(props: BadResponseButtonProps) {
  if (props.reporting?.enabled !== true || props.message.role !== "assistant"
    || (!props.message.content.some((part) => part.type === "text" && part.text.trim().length > 0)
      && props.message.attachments.length === 0)) return null;
  return <ResponseButton key={JSON.stringify([props.conversationId, props.message.message_id])}
    {...props} reporting={props.reporting}/>;
}

function ResponseButton({ conversationId, message, reporting, disabled, onClick, ...props }:
  BadResponseButtonProps & { readonly reporting: BadResponseReportingOptions }) {
  const [status, setStatus] = useState<"idle" | "sending" | "reported" | "error">("idle");
  const request = useRef<BadResponseReportRequest | null>(null);
  const pending = useRef<AbortController | null>(null);
  const reported = useRef(false);
  useEffect(() => () => { pending.current?.abort(); }, []);

  const report = async () => {
    if (disabled || pending.current || reported.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setStatus("sending");
    try {
      request.current ??= createBadResponseReportRequest({
        conversationId, messageId: message.message_id, turnId: message.turn_id ?? null,
      });
      const receipt = await reporting.report(request.current, { signal: controller.signal });
      if (controller.signal.aborted) return;
      parseBadResponseReportReceipt(receipt, request.current);
      reported.current = true;
      setStatus("reported");
    } catch {
      if (!controller.signal.aborted) setStatus("error");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  };

  return <><button {...props} type="button" disabled={disabled || status === "sending" || status === "reported"}
    aria-busy={status === "sending"} onClick={(event) => {
      onClick?.(event);
      if (!event.defaultPrevented) void report();
    }}>{status === "sending" ? "Reporting…" : status === "reported" ? "Reported" : "Bad response"}</button>
    <span role="status" aria-live="polite" className="hr-message-action-status">
      {status === "reported" ? "Response reported for review."
        : status === "error" ? "Could not report this response. Please try again." : ""}
    </span></>;
}
