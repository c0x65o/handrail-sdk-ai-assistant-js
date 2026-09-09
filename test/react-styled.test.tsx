// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseConversationEvent } from "../src/conversation/events.js";
import { reduceConversationEvent } from "../src/conversation/reducer.js";
import { createInitialConversationState } from "../src/conversation/state.js";
import { InMemoryConversationActivityStore } from "../src/conversation/activity.js";
import { CatalogWorkspaceThreadPicker, HandrailAssistantLauncher, StandardConversationTitleObserver, StandardGatewayApprovals, StyledChatLauncher, StyledChatPreset, StyledChatPresetStyles, WorkspaceThreadPicker, createHandrailChatThemeStyle, gatewayAttachmentIntake, installToolRendererPlugins } from "../src/react-styled/index.js";

describe("styled React preset", () => {
  it("counts concurrent runs and unread failures independently, then clears attention when read", () => {
    const activity = new InMemoryConversationActivityStore();
    activity.replace([
      { conversationId: "first", turnId: "one", turnStatus: "running", unread: false },
      { conversationId: "second", turnId: "two", turnStatus: "running", unread: true },
      { conversationId: "failed", turnId: "three", turnStatus: "error", unread: true },
      { conversationId: "old-failure", turnStatus: "error", unread: false },
    ]);
    const view = render(<StyledChatLauncher activity={activity}/>);
    const trigger = view.container.querySelector<HTMLButtonElement>(".hr-chat__launcher-trigger")!;
    expect(trigger.textContent).toContain("2 running");
    expect(trigger.dataset.unreadCount).toBe("2");
    expect(trigger.dataset.error).toBe("false");
    act(() => {
      activity.upsert({ conversationId: "first", turnId: "one", turnStatus: "completed", unread: false });
      activity.upsert({ conversationId: "second", turnId: "two", turnStatus: "completed", unread: false });
    });
    expect(trigger.textContent).toContain("Unread");
    act(() => activity.markRead("failed"));
    expect(trigger.textContent).toBe("Open chat");
    expect(trigger.dataset.turnStatus).toBe("idle");
    expect(activity.getSnapshot().find((item) => item.conversationId === "failed")?.turnStatus).toBe("error");
  });

  it("shows server completion for an open disconnected thread in both launcher and picker", () => {
    const state = { ...createInitialConversationState("conversation" as never),
      turns: [{ turn_id: "turn", status: "running" }] };
    const snapshot = { selectedConversationId: null, runningCount: 1, errorCount: 0, unreadCount: 0,
      threads: [{ conversationId: "conversation", runtime: { getSnapshot: () => state },
        turnStatus: "running", unread: false, revision: 2 }] };
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => undefined,
      open: vi.fn(), select: vi.fn(), markRead: vi.fn() };
    const activity = new InMemoryConversationActivityStore();
    activity.upsert({ conversationId: "conversation", turnId: "turn", turnRevision: 2,
      turnStatus: "completed", unread: true });
    const view = render(<><StyledChatLauncher workspace={workspace as never} activity={activity}/>
      <WorkspaceThreadPicker workspace={workspace as never} activity={activity}/></>);
    const trigger = view.container.querySelector<HTMLButtonElement>(".hr-chat__launcher-trigger")!;
    expect(trigger.dataset.turnStatus).toBe("completed");
    expect(trigger.dataset.unreadCount).toBe("1");
    expect(screen.getByRole("button", { name: "conversation Unread" })).toBeTruthy();
    expect(screen.queryByText(/running\)/)).toBeNull();
    act(() => activity.upsert({ conversationId: "conversation", turnId: "turn", turnRevision: 2,
      turnStatus: "completed", unread: false }));
    expect(trigger.dataset.unreadCount).toBe("0");
    expect(screen.queryByRole("button", { name: "conversation Unread" })).toBeNull();
  });

  it("clears a stale running summary as soon as canonical completion arrives", () => {
    const activity = new InMemoryConversationActivityStore();
    const initial = createInitialConversationState("conversation" as never);
    const started = reduceConversationEvent(initial, parseConversationEvent({ version: 1, conversation_id: "conversation",
      event_id: "start", revision: 1, occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" },
      source: { type: "runtime" }, payload: { type: "turn.started", turn_id: "turn", input_message_ids: ["input"] } }));
    activity.upsert({ conversationId: "conversation", turnId: "turn", turnStatus: "running", unread: false,
      summary: "Comparing revenue" });
    const view = render(<StyledChatPreset state={started} activity={activity}/>);
    expect(screen.getByText("Comparing revenue")).toBeTruthy();
    const completed = reduceConversationEvent(started, parseConversationEvent({ version: 1, conversation_id: "conversation",
      event_id: "complete", revision: 2, occurred_at: "2026-09-04T00:00:01.000Z", actor: { type: "assistant" },
      source: { type: "runtime" }, payload: { type: "turn.completed", turn_id: "turn", outcome: "stop", output_message_ids: [] } }));
    view.rerender(<StyledChatPreset state={completed} activity={activity}/>);
    expect(screen.queryByText("Comparing revenue")).toBeNull();
    expect(screen.getByText("Done")).toBeTruthy();
    view.unmount();
  });

  it("shows one current summary in the open conversation and clears it on completion", () => {
    const activity = new InMemoryConversationActivityStore();
    const state = createInitialConversationState("bulk-revenue" as never);
    activity.upsert({ conversationId: "other", turnStatus: "running", unread: false,
      summary: "Other conversation work" });
    const view = render(<StyledChatPreset state={state} activity={activity}/>);
    expect(screen.queryByText("Other conversation work")).toBeNull();
    act(() => activity.upsert({ conversationId: "bulk-revenue", turnStatus: "running", unread: false,
      summary: "Tracing invoice accounts", progress: { completed: 18, total: 43, unit: "products" } }));
    expect(screen.getByText("Tracing invoice accounts (18/43 products)").getAttribute("role")).toBe("status");
    act(() => activity.upsert({ conversationId: "bulk-revenue", turnStatus: "running", unread: false,
      summary: "Comparing this month and last month" }));
    expect(screen.queryByText(/Tracing invoice accounts/)).toBeNull();
    expect(screen.getByText("Comparing this month and last month")).toBeTruthy();
    act(() => activity.upsert({ conversationId: "bulk-revenue", turnStatus: "completed", unread: true }));
    expect(screen.queryByText("Comparing this month and last month")).toBeNull();
    view.unmount();
  });
  it("boots the production launcher with canonical styles from an endpoint", () => {
    const fetcher: typeof fetch = async () => new Promise<Response>(() => undefined);
    const { container, getByText } = render(<HandrailAssistantLauncher endpoint="/api/assistant/aegis"
      fetch={fetcher} loading={<span>Connecting assistant</span>}/>);
    expect(getByText("Connecting assistant")).toBeTruthy();
    expect(container.querySelector("style[data-handrail-ai-preset]")).toBeTruthy();
  });

  it("allows a host to inject canonical styles once at an application boundary", () => {
    const fetcher: typeof fetch = async () => new Promise<Response>(() => undefined);
    const { container } = render(<HandrailAssistantLauncher endpoint="/api/assistant/aegis"
      fetch={fetcher} includeStyles={false} loading={<span>Connecting assistant</span>}/>);
    expect(container.querySelector("style[data-handrail-ai-preset]")).toBeNull();
  });

  it("derives file intake from protected gateway MIME and size limits", () => {
    expect(gatewayAttachmentIntake({
      protocolVersion: "handrail.application-gateway.v1",
      authoritativeCancellation: true,
      attachments: {
        maximumFiles: 4,
        maximumBytesPerFile: 10 * 1024 * 1024,
        acceptedMediaTypes: ["image/*", "application/pdf", "text/csv"],
      },
      presence: false,
      synchronization: false,
    })).toEqual({
      acceptedMediaTypes: [
        "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/csv",
      ],
      maxFileBytes: { image: 10 * 1024 * 1024, document: 10 * 1024 * 1024 },
      maxSelectionCount: { image: 4, document: 2 },
    });
    expect(gatewayAttachmentIntake({
      protocolVersion: "handrail.application-gateway.v1",
      authoritativeCancellation: false,
      attachments: false,
      presence: false,
      synchronization: false,
    })).toBeUndefined();
    expect(gatewayAttachmentIntake({
      protocolVersion: "handrail.application-gateway.v1",
      authoritativeCancellation: false,
      attachments: false,
      documentInput: {
        supported_mime_types: ["application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        max_document_count: 2,
        max_document_bytes: 25 * 1024 * 1024,
        requires_host_resolution: true,
      },
      presence: false,
      synchronization: false,
    }, true)).toMatchObject({
      acceptedMediaTypes: [
        "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
      maxFileBytes: { document: 25 * 1024 * 1024 },
      maxSelectionCount: { document: 2 },
    });
  });

  it.each(["running", "completed"])("generates and persists a title for a %s turn", async (turnStatus) => {
    const conversationId = "conversation-1" as never;
    const descriptor = { conversationId, title: null, lifecycle: "active", archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      version: 1, metadata: {} };
    const get = vi.fn(async () => ({ operation: "get", status: "found", descriptor }));
    const rename = vi.fn(async () => ({ operation: "rename", status: "updated",
      descriptor: { ...descriptor, title: "Quarterly cash planning", version: 2 } }));
    const generateTitle = vi.fn(async () => "Quarterly cash planning");
    const onTitle = vi.fn();
    const snapshot = { selectedConversationId: conversationId,
      runningCount: 0, errorCount: 0, unreadCount: 1,
      threads: [{ conversationId, runtime: {}, turnStatus, unread: true, revision: 4 }] };
    const workspace = { getSnapshot: () => snapshot,
      subscribe: () => () => undefined };
    const view = render(<StandardConversationTitleObserver client={{ workspace,
      catalog: { capabilities: { rename: { supported: true } }, get, rename },
      resources: { generateTitle } } as never} onTitle={onTitle}/>);
    await waitFor(() => expect(rename).toHaveBeenCalledWith(expect.objectContaining({
      conversationId, expectedVersion: 1, title: "Quarterly cash planning",
    })));
    expect(generateTitle).toHaveBeenCalledOnce();
    expect(onTitle).toHaveBeenCalledWith(conversationId, "Quarterly cash planning");
    view.unmount();
  });

  it.each(["Generated title", "Manual title"])("refreshes a persisted %s without a second rename", async (savedTitle) => {
    const conversationId = "conversation-title" as never;
    let descriptor = { conversationId, title: "New thread", lifecycle: "active", archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 1, metadata: {} };
    const get = vi.fn(async () => ({ operation: "get", status: "found", descriptor }));
    const rename = vi.fn();
    const generateTitle = vi.fn(async () => { descriptor = { ...descriptor, title: savedTitle, version: 2 }; return "Generated title"; });
    const onTitle = vi.fn();
    const snapshot = { selectedConversationId: null, runningCount: 0, errorCount: 0, unreadCount: 1,
      threads: [{ conversationId, runtime: {}, turnStatus: "completed", unread: true, revision: 4 }] };
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => undefined };
    const view = render(<StandardConversationTitleObserver client={{ workspace,
      catalog: { capabilities: { rename: { supported: true } }, get, rename }, resources: { generateTitle } } as never}
      placeholderTitles={["New thread"]} onTitle={onTitle}/>);
    await waitFor(() => expect(onTitle).toHaveBeenCalledWith(conversationId, savedTitle));
    expect(generateTitle).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("loads and confirms conversation-grouped approvals in the standard UI", async () => {
    const proposal = { proposal_id: "proposal-1", group_id: "conversation-1", turn_id: "turn-1",
      tool_call_id: "call-1", tool_name: "update_household", reviewed_arguments: {
        type: "redacted_json", value: {} }, status: "pending", proposal_version: 1,
      expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", created_attribution: {}, latest_attribution: {},
      decision_at: null, decision_attribution: null, decision_reason: null, failure_reason: null } as never;
    const listApprovalGroup = vi.fn(async () => [proposal]);
    const transitionApproval = vi.fn(async () => proposal);
    const workspaceSnapshot = { selectedConversationId: "conversation-1",
      runningCount: 0, errorCount: 0, unreadCount: 0, threads: [] };
    const workspace = { getSnapshot: () => workspaceSnapshot,
      subscribe: () => () => undefined };
    const view = render(<StandardGatewayApprovals client={{ workspace,
      resources: { listApprovalGroup, transitionApproval } } as never}/>);
    expect(await screen.findByText("update household")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(transitionApproval).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1", proposalId: "proposal-1", expectedVersion: 1,
      status: "confirmed",
    })));
    view.unmount();
  });

  it("maps typed theme tokens and mode to stable CSS properties", () => {
    expect(createHandrailChatThemeStyle({
      mode: "dark",
      colors: { accent: "#123456", danger: "crimson" },
      radii: { panel: "24px" },
      fontFamily: "Inter, sans-serif",
    })).toEqual({
      "--hr-accent": "#123456",
      "--hr-danger": "crimson",
      "--hr-radius-panel": "24px",
      "--hr-font": "Inter, sans-serif",
    });
    const { container, unmount } = render(<StyledChatPreset theme={{
      mode: "system", colors: { accent: "rebeccapurple" },
    }}/>);
    const root = container.querySelector<HTMLElement>(".hr-chat")!;
    expect(root.dataset.theme).toBe("system");
    expect(root.style.getPropertyValue("--hr-accent")).toBe("rebeccapurple");
    unmount();
  });
  it("installs renderer plugins by stable keys without exposing server executors", () => {
    const renderer = () => <span>Invoice</span>;
    expect(installToolRendererPlugins([{
      pluginId: "spartan.erp", version: "1.0.0",
      renderers: { "spartan.invoice.result": renderer },
      toolRendererKeys: { "spartan.invoice.lookup": "spartan.invoice.result" },
    }])).toEqual({
      renderers: { "spartan.invoice.result": renderer },
      toolRendererKeys: { "spartan.invoice.lookup": "spartan.invoice.result" },
    });
  });
  it("derives tool mappings from a matching data-only server catalog", () => {
    const renderer = () => <span>Invoice</span>;
    expect(installToolRendererPlugins([{
      pluginId: "spartan.erp", version: "1.0.0",
      renderers: { "spartan.invoice.result": renderer },
    }], { plugins: [{ pluginId: "spartan.erp", version: "1.0.0",
      presentations: [{ toolName: "spartan.invoice.lookup", rendererKey: "spartan.invoice.result" }] }] }))
      .toEqual({ renderers: { "spartan.invoice.result": renderer },
        toolRendererKeys: { "spartan.invoice.lookup": "spartan.invoice.result" } });
  });
  it("renders an accessible responsive chat surface without changing headless primitives", () => {
    const { container } = render(<><StyledChatPresetStyles/><StyledChatPreset title="Aegis" layout="drawer" conversationPicker={<button>Threads</button>} approvals={<section>Approval required</section>} citations={<aside>Sources</aside>}/></>);
    expect(screen.getByRole("heading", { name: "Aegis" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Conversation transcript" })).toBeTruthy();
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Message…");
    expect(screen.getByLabelText("Attach files")).toBeTruthy();
    expect(screen.getByText("Approval required")).toBeTruthy();
    expect(container.querySelector("[data-layout=drawer]")).toBeTruthy();
    expect(container.querySelector("style[data-handrail-ai-preset]")?.textContent).toContain("prefers-reduced-motion");
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  it("renders safe semantic Markdown, target citations, rich attachments, and voice composition", () => {
    const initial = createInitialConversationState("conversation" as never);
    const message = {
      message_id: "message" as never, turn_id: "turn" as never, role: "assistant" as const,
      content: [{ type: "text" as const,
        text: "### Summary\n\n- **Safe** item\n\n1. *First* step\n2. Second step\n\n> Trusted note\n\n[Good](https://example.com) [Bad](javascript:alert(1))" }],
      attachments: [{ attachment_id: "attachment" as never, kind: "image" as const,
        filename: "chart.png", media_type: "image/png" as const, size_bytes: 2048 }],
      created_at: null, attribution: null,
    };
    const state = { ...initial, messages: [message],
      citation_sources: [{ source_id: "source" as never, type: "web" as const,
        label: "Trusted source", locator: "https://example.com/source" }],
      citations: [{ citation_id: "citation" as never, source_id: "source" as never, order: 1,
        target: { type: "assistant_message" as const, message_id: "message" as never } }],
    };
    render(<StyledChatPreset state={state} voiceControls={<button>Speak</button>}
      resolveAttachmentUrl={() => "/api/attachments/attachment"}/>);
    expect(screen.getByRole("heading", { name: "Summary", level: 3 })).toBeTruthy();
    expect(screen.getByText("Safe").tagName).toBe("STRONG");
    expect(screen.getByText("First").tagName).toBe("EM");
    expect(screen.getByText("Trusted note").closest("blockquote")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Good" }).getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("Bad").closest("a")).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe("/api/attachments/attachment");
    expect(screen.getByRole("link", { name: /Trusted source/ }).getAttribute("href"))
      .toBe("https://example.com/source");
    expect(screen.getByRole("button", { name: "Speak" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" }).classList.contains("hr-chat__copy")).toBe(true);
  });
  it("shows Stop for running work without offering Retry for past failures", () => {
    const initial = createInitialConversationState("conversation" as never);
    const turn = { turn_id: "turn" as never, continuation_of_turn_id: null, status: "failed" as const,
      input_message_ids: [], output_message_ids: [], outcome: null, cancellation_reason: null,
      cancellation_status: null, cancellation_requested_reason: null, remote_may_still_be_running: false,
      error: { code: "provider_failed", message: "Try again.", retryable: true }, retry_history: [],
      started_at: null, terminal_at: null, attribution: null };
    const view = render(<StyledChatPreset state={{ ...initial, turns: [turn] }}/>);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
    view.rerender(<StyledChatPreset state={{ ...initial, turns: [{ ...turn, status: "running", error: null }],
      active_turn_id: turn.turn_id }}/>);
    expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  it("binds completion and unread workspace state to the launcher button", () => {
    const snapshot = { selectedConversationId: "second", runningCount: 0, errorCount: 0,
      unreadCount: 1, threads: [{ conversationId: "first", runtime: {}, turnStatus: "completed",
        unread: true, revision: 2 }] } as never;
    const { container } = render(<StyledChatLauncher title="Aegis" workspace={{ getSnapshot: () => snapshot,
      subscribe: () => () => undefined }}/>);
    const trigger = container.querySelector<HTMLButtonElement>(".hr-chat__launcher-trigger")!;
    expect(trigger.dataset.turnStatus).toBe("completed");
    expect(trigger.dataset.unreadCount).toBe("1");
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Aegis" })).toBeTruthy();
  });
  it("includes unopened server activity in launcher status", () => {
    const empty = { selectedConversationId: null, runningCount: 0, errorCount: 0,
      unreadCount: 0, threads: [] } as never;
    const activitySnapshot = [{ conversationId: "remote",
      turnStatus: "running" as const, unread: false,
      summary: "Tracing invoice revenue accounts",
      progress: { completed: 18, total: 43, unit: "products" } }];
    const { container } = render(<StyledChatLauncher workspace={{ getSnapshot: () => empty,
      subscribe: () => () => undefined }} activity={{ getSnapshot: () => activitySnapshot,
        subscribe: () => () => undefined }}/>);
    const trigger = container.querySelector<HTMLButtonElement>(".hr-chat__launcher-trigger")!;
    expect(trigger.dataset.turnStatus).toBe("busy");
    expect(trigger.textContent).toContain("Tracing invoice revenue accounts (18/43 products)");
  });
  it("keeps New available while another conversation is running", async () => {
    const open = vi.fn(async () => ({} as never));
    const select = vi.fn();
    const markRead = vi.fn();
    const onConversationRead = vi.fn();
    const running = { selectedConversationId: "running", runningCount: 1, errorCount: 0,
      unreadCount: 0, threads: [{ conversationId: "running", runtime: {}, turnStatus: "running",
        unread: false, revision: 2 }] } as never;
    render(<WorkspaceThreadPicker workspace={{ getSnapshot: () => running,
      subscribe: () => () => undefined, open, select, markRead }}
      onConversationRead={onConversationRead}
      createConversation={async () => ({ authorizationContext: {}, conversationId: "new" as never })}/>);
    const create = screen.getByRole("button", { name: "New" });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Threads (1 running)")).toBeTruthy();
    fireEvent.click(create);
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "new" })));
    fireEvent.click(screen.getByText("Threads (1 running)"));
    fireEvent.click(screen.getByRole("button", { name: /running Running/i }));
    expect(select).toHaveBeenCalledWith("running");
    expect(markRead).toHaveBeenCalledWith("running");
    expect(onConversationRead).toHaveBeenCalledWith("running");
  });
  it("hydrates every authorized catalog page and exposes archive and restore lifecycle actions", async () => {
    const active = { conversationId: "active", title: "Active case", lifecycle: "active",
      archivedAt: null, createdAt: "2026-01-01", updatedAt: "2026-01-02", version: "v1", metadata: {} } as never;
    const archived = { conversationId: "archived", title: "Past case", lifecycle: "archived",
      archivedAt: "2026-01-02", createdAt: "2026-01-01", updatedAt: "2026-01-02", version: "v2", metadata: {} } as never;
    const list = vi.fn(async (input: { cursor?: string }) => input.cursor
      ? { items: [archived], nextCursor: null, hasMore: false,
          order: { field: "updated_at", direction: "desc" } }
      : { items: [active], nextCursor: "next", hasMore: true,
          order: { field: "updated_at", direction: "desc" } });
    const archive = vi.fn(async () => ({ descriptor: archived }));
    const restore = vi.fn(async () => ({ descriptor: active }));
    const catalog = { list, archive, restore,
      capabilities: { archive: { supported: true }, restore: { supported: true } } } as never;
    const snapshot = { selectedConversationId: "active", runningCount: 0, errorCount: 0,
      unreadCount: 0, threads: [{ conversationId: "active", runtime: {}, turnStatus: "idle",
        unread: false, revision: 0 }] } as never;
    const open = vi.fn(async () => ({} as never));
    const close = vi.fn(async () => true);
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => undefined,
      open, close, select: vi.fn() };
    const view = render(<CatalogWorkspaceThreadPicker workspace={workspace as never}
      catalogOptions={{ catalog, authorizationContext: { accountId: "authorized" }, pageSize: 1 }}/>);
    const picker = within(view.container);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(view.container.querySelector("summary")!);
    fireEvent.click(picker.getByRole("button", { name: "Archive Active case" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "active", expectedVersion: "v1",
    })));
    expect(close).toHaveBeenCalledWith("active");
    await waitFor(() => expect(picker.getByRole<HTMLButtonElement>("button", { name: "Restore Past case" }).disabled).toBe(false));
    fireEvent.click(picker.getByRole("button", { name: "Restore Past case" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "archived", expectedVersion: "v2",
    })));
  });
});
