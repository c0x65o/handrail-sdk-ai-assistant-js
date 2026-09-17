// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createHandrailAiClient, APPLICATION_GATEWAY_PROTOCOL_VERSION, type ApplicationGatewayCapabilities } from "../src/client/index.js";
import { ConversationProvider } from "../src/react/context.js";
import { StyledChatPreset } from "../src/react-styled/index.js";

afterEach(cleanup);
const capabilities: ApplicationGatewayCapabilities = { protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION,
  authoritativeCancellation: false, attachments: false, presence: false, activity: false, synchronization: false,
  resources: { conversations: true, approvals: true, titleGeneration: false },
  displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144, control: true } };
function gateway() {
  const requests: { path: string; operation: string; input: any; bytes: number }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(init?.body)), input = body.input ?? body;
    let value: unknown;
    if (path.endsWith("/conversations/get")) value = { operation: "get", status: "found", descriptor: {
      conversationId: input.conversationId, title: "Saved", lifecycle: "active", archivedAt: null,
      createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z", version: 1, metadata: {} } };
    else {
      if (!path.endsWith("/conversations/history")) throw new Error(`Unexpected full-history endpoint: ${path}`);
      const header = { schemaVersion: 1, status: "ready", conversationId: input.conversationId, generation: 0,
        revision: 200, canonicalRevision: 200, activeTurnId: null };
      if (body.operation === "control") value = { ...header, activeTurn: null, latestTurn: null, requestedTurn: null };
      else if (body.operation === "changes") value = { ...header, records: [], nextCursor: null, throughRevision: 200 };
      else if (input.view?.type === "context") value = { ...header, records: [], nextCursor: null };
      else {
        const end = input.anchor ? Number(String(input.anchor.messageId).split("-").at(-1)) - 1 : 200;
        const start = Math.max(1, end - (input.limit ?? 30) + 1);
        const records = Array.from({ length: end - start + 1 }, (_, i) => ({ kind: "message", id: `m-${start + i}`, revision: start + i,
          turnId: null, bytes: 200, deferred: false, value: { message_id: `m-${start + i}`, role: "assistant",
            content: [{ type: "text", text: `${input.conversationId} saved ${start + i}` }], attachments: [], created_at: null, attribution: null } }));
        value = { ...header, records, nextCursor: start > 1 ? "older" : null };
      }
    }
    const json = JSON.stringify({ ok: true, value }); requests.push({ path, operation: body.operation, input, bytes: new TextEncoder().encode(json).byteLength });
    return new Response(json, { headers: { "content-type": "application/json" } });
  });
  return { requests, fetcher };
}

it("negotiates bounded history in the standard React preset with no snapshot, saved stream replay, or approval-list hydration", async () => {
  const f = gateway(); const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", fetch: f.fetcher, capabilities,
    conversations: { mode: "single", conversationId: "single" as never, clientId: "client" as never } });
  const approvals = { listApprovalGroup: vi.fn(async () => []), transitionApproval: vi.fn() };
  try {
    const view = render(<ConversationProvider runtime={client.conversation!}><StyledChatPreset approvalResources={approvals}/></ConversationProvider>);
    await screen.findByText("single saved 200");
    expect(view.container.querySelectorAll("[data-display-message]")).toHaveLength(30);
    expect(screen.queryByText("single saved 170")).toBeNull();
    expect(client.conversation!.getSnapshot().partial).toBe(true);
    expect(client.conversation!.getSnapshot()).not.toHaveProperty("processed_event_ids");
    expect(client.conversation!.store).not.toHaveProperty("applyEvents");
    expect(client.workspace).toBeNull(); expect(approvals.listApprovalGroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" })); await screen.findByText("single saved 141");
    expect(view.container.querySelectorAll("[data-display-message]")).toHaveLength(60);
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" })); await screen.findByText("single saved 111");
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" })); await screen.findByText("single saved 81");
    expect(view.container.querySelectorAll("[data-display-message]")).toHaveLength(90);
    expect(screen.queryByText("single saved 200")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" })); await screen.findByText("single saved 200");
    expect(view.container.querySelectorAll("[data-display-message]")).toHaveLength(30);
    expect(f.requests.every(request => request.path.endsWith("/conversations/history"))).toBe(true);
    expect(Math.max(...f.requests.map(request => request.bytes))).toBeLessThan(65536);
    view.unmount();
  } finally { await client.dispose(); }
});

it("negotiates multiple conversations lazily and drops the previous chat body when switching", async () => {
  const f = gateway(); const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", fetch: f.fetcher, capabilities,
    conversations: { mode: "multiple", clientId: "client" as never, authorize: () => "allow" } });
  try {
    expect(f.fetcher).not.toHaveBeenCalled();
    const a = await client.workspace!.open({ authorizationContext: {}, conversationId: "a" as never });
    const view = render(<ConversationProvider runtime={a}><StyledChatPreset/></ConversationProvider>);
    await screen.findByText("a saved 200");
    let b!: typeof a;
    await act(async () => { b = await client.workspace!.open({ authorizationContext: {}, conversationId: "b" as never }); });
    view.rerender(<ConversationProvider runtime={b}><StyledChatPreset/></ConversationProvider>);
    expect(screen.queryByText("a saved 200")).toBeNull(); await screen.findByText("b saved 200");
    await waitFor(() => expect(a.getSnapshot().messages).toEqual([]));
    expect(a.displaySession?.getSnapshot().related).toEqual([]);
    expect(client.workspace!.getSnapshot().selectedConversationId).toBe("b");
    expect(f.requests.filter(request => request.operation === "page" && !request.input.view)).toHaveLength(2);
    view.unmount();
    for (let index = 0; index < 6; index++) {
      const runtime = await client.workspace!.open({ authorizationContext: {}, conversationId: `additional-${index}` as never });
      await runtime.synchronize!();
    }
    await waitFor(() => expect(client.workspace!.getSnapshot().threads).toHaveLength(4));
    expect(client.workspace!.getSnapshot().threads.filter(thread => thread.runtime.getSnapshot().messages.length)).toHaveLength(1);
    expect(client.registry!.getSnapshot().liveCount).toBe(4);
  } finally { await client.dispose(); }
});
