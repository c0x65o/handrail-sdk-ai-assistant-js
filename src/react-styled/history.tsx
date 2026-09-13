import type { ReactNode } from "react";
import type { ConversationId } from "../conversation/events.js";
import type { ConversationCatalogDescriptor } from "../conversation/catalog.js";
import type { ConversationHistoryController } from "../react/conversation-history.js";

export interface ConversationHistoryPanelProps {
  readonly controller: ConversationHistoryController;
  readonly title?: ReactNode;
  readonly newLabel?: string;
  readonly getThreadLabel?: (conversationId: ConversationId) => ReactNode;
  readonly formatTimestamp?: (timestamp: string) => ReactNode;
  readonly renderActivity?: (conversationId: ConversationId) => ReactNode;
  readonly showPreviews?: boolean;
  readonly showUnreadFilter?: boolean;
  readonly includeStyles?: boolean;
}

export const HANDRAIL_CONVERSATION_HISTORY_CSS = `
.hr-history{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--hr-panel,#f7f6f4);color:var(--hr-text,#202124);font-family:var(--hr-font,inherit)}
.hr-history header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px;border-bottom:1px solid var(--hr-border,#e4e1dd)}
.hr-history h3{font-size:12px;text-transform:uppercase;letter-spacing:.09em;margin:0;color:var(--hr-muted,#666)}
.hr-history button{font:inherit;color:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:8px 12px;background:transparent}
.hr-history button:disabled{opacity:.5;cursor:default}.hr-history button:focus-visible{outline:3px solid color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 45%);outline-offset:2px}
.hr-history .hr-history__new{background:var(--hr-accent,#bd4b20);color:white;border-color:var(--hr-accent,#bd4b20)}
.hr-history nav{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--hr-border,#e4e1dd)}.hr-history nav button{flex:1}.hr-history nav [aria-pressed=true]{background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 90%);color:var(--hr-accent,#bd4b20)}
.hr-history ul{list-style:none;overflow:auto;overscroll-behavior:contain;padding:0;margin:0;min-height:0;flex:1}.hr-history li{border-bottom:1px solid var(--hr-border,#e4e1dd);position:relative}
.hr-history .hr-history__select{display:block;text-align:start;white-space:normal;border-radius:0;width:100%;padding:14px 16px;border-inline-start:3px solid transparent}
.hr-history .hr-history__select:hover{background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 95%)}.hr-history .hr-history__select[aria-current=true]{border-inline-start-color:var(--hr-accent,#bd4b20);background:color-mix(in srgb,var(--hr-accent,#bd4b20),transparent 91%)}
.hr-history__heading{display:flex;align-items:baseline;gap:12px;justify-content:space-between}.hr-history__heading strong{overflow-wrap:anywhere;min-width:0}.hr-history time{font-size:12px;flex-shrink:0;color:var(--hr-muted,#666)}
.hr-history__preview{display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--hr-muted,#666);margin-top:6px;font-size:13px}.hr-history__status{display:block;font-size:12px;color:var(--hr-accent,#bd4b20);margin-top:4px}
.hr-history .hr-history__lifecycle{display:block;margin:0 12px 8px auto;font-size:12px;color:var(--hr-muted,#666);padding:4px 8px}.hr-history__notice{padding:12px;margin:0;font-size:13px;overflow-wrap:anywhere}
.hr-history[data-presentation=compact]{position:relative}.hr-history[data-presentation=compact] .hr-history__panel{position:absolute;z-index:20;inset-inline-end:0;inset-block-start:100%;width:min(340px,calc(100vw - 32px));max-height:65dvh;display:flex;flex-direction:column;background:var(--hr-bg,#fff);box-shadow:0 10px 35px #0002;border:1px solid var(--hr-border,#e4e1dd);border-radius:12px}
.hr-history[data-presentation=compact] summary{cursor:pointer;list-style:none;padding:8px 12px}.hr-history[data-presentation=compact] summary::-webkit-details-marker{display:none}
.hr-chat-workspace{display:grid;grid-template-columns:minmax(210px,30%) minmax(0,1fr);min-width:0;min-height:0;height:100%;width:100%;overflow:hidden}.hr-chat-workspace>.hr-history{border-inline-end:1px solid var(--hr-border,#e4e1dd)}.hr-chat-workspace>.hr-chat{width:100%;min-width:0;height:100%;border-radius:0;border:0}.hr-chat-workspace[data-layout=launcher]{width:min(68rem,calc(100vw - 2rem));height:min(48rem,calc(100dvh - 6rem))}
@media(max-width:640px){.hr-chat-workspace{display:flex;flex-direction:column}.hr-chat-workspace>.hr-history{max-height:35dvh;border-inline-end:0;border-bottom:1px solid var(--hr-border,#e4e1dd)}.hr-chat-workspace>.hr-chat{flex:1;min-height:0}.hr-chat-workspace[data-layout=launcher]{height:calc(100dvh - 5rem);width:calc(100vw - 1rem)}}
`;

/** Shared history presentation; navigation and mutation behavior belong to useConversationHistory. */
export function ConversationHistoryPanel(props: ConversationHistoryPanelProps) {
  const history = props.controller;
  return <>
    {props.includeStyles === false ? null : <style>{HANDRAIL_CONVERSATION_HISTORY_CSS}</style>}
    <header><h3>{props.title ?? "Conversations"}</h3>
      <button className="hr-history__new" type="button" disabled={history.busyId !== null} aria-busy={history.busyId === "create"}
        onClick={() => { void history.create(); }}>{history.busyId === "create" ? "Creating…" : props.newLabel ?? "New"}</button></header>
    <nav aria-label="Conversation views">
      <button type="button" aria-pressed={history.view === "active"} onClick={() => history.setView("active")}>Active</button>
      <button type="button" aria-pressed={history.view === "archived"} onClick={() => history.setView("archived")}>Archived</button>
    </nav>
    {history.view === "active" && props.showUnreadFilter !== false && <nav aria-label="Conversation filters">
      <button type="button" aria-pressed={history.unreadOnly} aria-label={`Unread conversations (${history.unreadCount})`}
        onClick={() => history.setUnreadOnly(!history.unreadOnly)}>Unread ({history.unreadCount})</button>
    </nav>}
    <ul aria-label="Conversations">{history.visible.map((descriptor) => {
      const activity = history.activity.find((record) => record.conversationId === descriptor.conversationId);
      return <li key={descriptor.conversationId} data-turn-status={activity?.turnStatus ?? "idle"} data-unread={activity?.unread || undefined}>
        <button className="hr-history__select" type="button" aria-current={history.snapshot.selectedConversationId === descriptor.conversationId ? "true" : undefined}
          onClick={() => { void history.select(descriptor); }}>
          <span className="hr-history__heading"><strong>{props.getThreadLabel?.(descriptor.conversationId) ?? descriptor.title ?? "New conversation"}</strong>
            <time dateTime={descriptor.updatedAt}>{props.formatTimestamp?.(descriptor.updatedAt) ??
              new Date(descriptor.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></span>
          {props.showPreviews !== false && <span className="hr-history__preview">{history.preview(descriptor)}</span>}
          {(activity?.turnStatus === "running" || activity?.unread) && <span className="hr-history__status">
            {[activity.turnStatus === "running" ? "Running" : "", activity.unread ? "Unread" : ""].filter(Boolean).join(" · ")}</span>}
          {props.renderActivity?.(descriptor.conversationId)}
        </button>
        {((descriptor.lifecycle === "active" && history.capabilities.archive.supported) ||
          (descriptor.lifecycle === "archived" && history.capabilities.restore.supported)) &&
          <HistoryLifecycleButton history={history} descriptor={descriptor}/>}
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
    aria-label={`${label} ${descriptor.title ?? "conversation"}`} onClick={() => { void history.changeLifecycle(descriptor); }}>{label}</button>;
}
