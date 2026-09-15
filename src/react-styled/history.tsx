import { useEffect, useState, type ReactNode } from "react";
import type { ConversationId } from "../conversation/events.js";
import type { ConversationCatalogDescriptor } from "../conversation/catalog.js";
import type { ConversationHistoryController } from "../react/conversation-history.js";

export interface ConversationHistoryPanelProps {
  readonly controller: ConversationHistoryController;
  readonly title?: ReactNode;
  readonly newLabel?: string;
  readonly getThreadLabel?: (conversationId: ConversationId) => ReactNode;
  /** Overrides the default relative update label. */
  readonly formatTimestamp?: (timestamp: string) => ReactNode;
  readonly renderActivity?: (conversationId: ConversationId) => ReactNode;
  /** Opt in to message previews. Titles alone are shown by default. */
  readonly showPreviews?: boolean;
  readonly showUnreadFilter?: boolean;
  readonly includeStyles?: boolean;
}

export const HANDRAIL_CONVERSATION_HISTORY_CSS = `
.hr-history{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--hr-panel,#f7f6f4);color:var(--hr-text,#202124);font-family:var(--hr-font,inherit);font-size:12px;font-weight:400;line-height:1.4}
.hr-history header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--hr-border,#e4e1dd)}
.hr-history h3{font-size:10px;text-transform:uppercase;letter-spacing:.09em;margin:0;color:var(--hr-muted,#666)}
.hr-history button{font:inherit;color:inherit;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:5px 8px;background:transparent}
.hr-history button:disabled{opacity:.5;cursor:default}.hr-history button:focus-visible{outline:3px solid color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 45%);outline-offset:2px}
.hr-history .hr-history__new{background:var(--hr-accent,#bd4b20);color:white;border-color:var(--hr-accent,#bd4b20)}
.hr-history nav{display:flex;gap:4px;padding:4px 8px;border-bottom:1px solid var(--hr-border,#e4e1dd)}.hr-history nav button{flex:1}.hr-history nav [aria-pressed=true]{background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 90%);color:var(--hr-accent,#bd4b20)}
.hr-history ul{list-style:none;overflow:auto;overscroll-behavior:contain;padding:0;margin:0;min-height:0;flex:1}.hr-history li{border-bottom:1px solid var(--hr-border,#e4e1dd);position:relative}
.hr-history .hr-history__select{display:block;box-sizing:border-box;text-align:start;white-space:normal;border-radius:0;width:100%;min-height:48px;padding:6px 10px;border-inline-start:3px solid transparent}
.hr-history li[data-lifecycle-action] .hr-history__select{padding-inline-end:42px}
.hr-history .hr-history__select:hover{background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 95%)}.hr-history .hr-history__select[aria-current=true]{border-inline-start-color:var(--hr-accent,#bd4b20);background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 91%)}
.hr-history__heading{display:block;min-width:0}.hr-history__heading strong{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;min-width:0;line-height:1.4;max-height:2.8em}
.hr-history__meta{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:6px;margin-top:2px;font-size:10px;line-height:1.4;color:var(--hr-muted,#666)}.hr-history time{font-size:inherit}.hr-history__status{color:var(--hr-accent,#bd4b20)}
.hr-history__preview{display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--hr-muted,#666);margin-top:3px;font-size:11px}
.hr-history .hr-history__lifecycle{position:absolute;inset-inline-end:6px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:30px;height:30px;padding:6px;color:var(--hr-muted,#666)}.hr-history .hr-history__lifecycle:hover:not(:disabled){background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 90%);color:var(--hr-accent,#bd4b20)}.hr-history__lifecycle svg{width:16px;height:16px;flex:none}.hr-history__notice{padding:12px;margin:0;font-size:13px;overflow-wrap:anywhere}
.hr-history[data-presentation=compact]{position:relative}.hr-history[data-presentation=compact] .hr-history__panel{position:absolute;z-index:20;inset-inline-end:0;inset-block-start:100%;box-sizing:border-box;width:min(300px,calc(100vw - 28px));max-height:min(420px,60dvh);overflow:hidden;display:flex;flex-direction:column;background:var(--hr-bg,#fff);box-shadow:0 10px 35px #0002;border:1px solid var(--hr-border,#e4e1dd);border-radius:8px}
.hr-history[data-presentation=compact]>summary{display:flex;align-items:center;gap:4px;cursor:pointer;list-style:none;padding:5px 8px;border-radius:6px}.hr-history[data-presentation=compact]>summary::after{content:" ▾"}.hr-history[data-presentation=compact][open]>summary::after{content:" ▴"}.hr-history[data-presentation=compact] summary::-webkit-details-marker{display:none}
.hr-chat-workspace{display:grid;grid-template-columns:minmax(210px,30%) minmax(0,1fr);min-width:0;min-height:0;height:100%;width:100%;overflow:hidden}.hr-chat-workspace>.hr-history{border-inline-end:1px solid var(--hr-border,#e4e1dd)}.hr-chat-workspace>.hr-chat{width:100%;min-width:0;height:100%;border-radius:0;border:0}.hr-chat-workspace[data-layout=launcher]{width:min(68rem,calc(100vw - 2rem));height:min(48rem,calc(100dvh - 6rem))}
@media(max-width:640px){.hr-chat-workspace{display:flex;flex-direction:column}.hr-chat-workspace>.hr-history{max-height:35dvh;border-inline-end:0;border-bottom:1px solid var(--hr-border,#e4e1dd)}.hr-chat-workspace>.hr-chat{flex:1;min-height:0}.hr-chat-workspace[data-layout=launcher]{height:calc(100dvh - 5rem);width:calc(100vw - 1rem)}}
/* Bound embedded menus to the chat header, including narrow drawers on wide screens. */
.hr-chat__header .hr-history[data-presentation=compact]{position:static}
.hr-chat__header .hr-history[data-presentation=compact] .hr-history__panel{inset-inline-end:12px;max-inline-size:calc(100% - 24px)}
@media(pointer:coarse){.hr-history button,.hr-history[data-presentation=compact]>summary{min-height:44px}.hr-history .hr-history__lifecycle{width:44px;height:44px;inset-inline-end:2px}.hr-history li[data-lifecycle-action] .hr-history__select{padding-inline-end:50px}}
`;

function relativeUpdateLabel(timestamp: string, now: number): string {
  const updatedAt = Date.parse(timestamp);
  if (!Number.isFinite(updatedAt)) return "Update time unavailable";
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  if (seconds < 60) return "Updated just now";
  const units = [[31_536_000, "year"], [2_592_000, "month"], [604_800, "week"],
    [86_400, "day"], [3_600, "hour"], [60, "minute"]] as const;
  for (const [duration, unit] of units) {
    if (seconds >= duration) {
      const count = Math.floor(seconds / duration);
      return `Updated ${count} ${unit}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "Updated just now";
}

/** Shared history presentation; navigation and mutation behavior belong to useConversationHistory. */
export function ConversationHistoryPanel(props: ConversationHistoryPanelProps) {
  const history = props.controller;
  const [now, setNow] = useState(Date.now);
  const hasConversations = history.visible.length > 0;
  useEffect(() => {
    if (!hasConversations) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hasConversations]);
  return <>
    {props.includeStyles === false ? null : <style>{HANDRAIL_CONVERSATION_HISTORY_CSS}</style>}
    <header><h3>{props.title ?? "Conversations"}</h3>
      <button className="hr-history__new" type="button" disabled={history.busyId !== null} aria-busy={history.busyId === "create"}
        onClick={() => { void history.create(); }}>{history.busyId === "create" ? "Creating…" : props.newLabel ?? "New"}</button></header>
    <nav aria-label="Conversation views">
      <button type="button" aria-pressed={history.view === "active"} onClick={() => history.setView("active")}>Active</button>
      <button type="button" aria-pressed={history.view === "archived"} onClick={() => history.setView("archived")}>Archived</button>
      {history.view === "active" && props.showUnreadFilter !== false &&
        <button type="button" aria-pressed={history.unreadOnly} aria-label={`Unread conversations (${history.unreadCount})`}
          onClick={() => history.setUnreadOnly(!history.unreadOnly)}>Unread ({history.unreadCount})</button>}
    </nav>
    <ul aria-label="Conversations">{history.visible.map((descriptor) => {
      const activity = history.activity.find((record) => record.conversationId === descriptor.conversationId);
      const label = props.getThreadLabel?.(descriptor.conversationId) ?? descriptor.title ?? "New conversation";
      const hasLifecycleAction = (descriptor.lifecycle === "active" && history.capabilities.archive.supported) ||
        (descriptor.lifecycle === "archived" && history.capabilities.restore.supported);
      const updatedAt = new Date(descriptor.updatedAt);
      return <li key={descriptor.conversationId} data-turn-status={activity?.turnStatus ?? "idle"} data-unread={activity?.unread || undefined}
        data-lifecycle-action={hasLifecycleAction || undefined}>
        <button className="hr-history__select" type="button" aria-current={history.snapshot.selectedConversationId === descriptor.conversationId ? "true" : undefined}
          onClick={() => { void history.select(descriptor); }}>
          <span className="hr-history__heading"><strong title={typeof label === "string" ? label : undefined}>{label}</strong></span>
          <span className="hr-history__meta">
            <time dateTime={descriptor.updatedAt} title={Number.isFinite(updatedAt.getTime()) ? updatedAt.toLocaleString() : undefined}>
              {props.formatTimestamp?.(descriptor.updatedAt) ?? relativeUpdateLabel(descriptor.updatedAt, now)}</time>
            {(activity?.turnStatus === "running" || activity?.unread) && <span className="hr-history__status">
              {[activity.turnStatus === "running" ? "Running" : "", activity.unread ? "Unread" : ""].filter(Boolean).join(" · ")}</span>}
          </span>
          {props.showPreviews === true && <span className="hr-history__preview">{history.preview(descriptor)}</span>}
          {props.renderActivity?.(descriptor.conversationId)}
        </button>
        {hasLifecycleAction && <HistoryLifecycleButton history={history} descriptor={descriptor}/>}
      </li>;
    })}</ul>
    {history.loading && history.descriptors.length === 0 && <p className="hr-history__notice" role="status">Loading conversations…</p>}
    {!history.loading && !history.loadFailed && history.visible.length === 0 && <p className="hr-history__notice">
      {history.view === "archived" ? "No archived conversations." : history.unreadOnly ? "No unread conversations." : "No conversations yet. Select New to start one."}</p>}
    {history.loadFailed && <p className="hr-history__notice" role="status">Reconnecting to conversation history…</p>}
    {history.error && <p className="hr-history__notice" role="alert">{history.error}</p>}
    {(history.loadFailed || history.error || history.failedThreads.size > 0) && <button type="button" onClick={() => { void history.refresh(); }}>Retry history</button>}
  </>;
}

function HistoryLifecycleButton({ history, descriptor }: {
  readonly history: ConversationHistoryController; readonly descriptor: ConversationCatalogDescriptor;
}) {
  const label = descriptor.lifecycle === "active" ? "Archive" : "Restore";
  return <button type="button" className="hr-history__lifecycle" disabled={history.busyId !== null}
    aria-label={`${label} ${descriptor.title ?? "conversation"}`} title={label}
    onClick={() => { void history.changeLifecycle(descriptor); }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 8v12h16V8M3 4h18v4H3z" />
      {descriptor.lifecycle === "active" ? <path d="M9 12h6" /> : <path d="M12 17v-6m-3 3 3-3 3 3" />}
    </svg>
  </button>;
}
