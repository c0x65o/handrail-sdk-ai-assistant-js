// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPendingApprovals } from "../src/react/pending-approvals.js";
import { StandardApprovalCard } from "../src/react-styled/index.js";
import { ApplicationConversationSession } from "../src/client/application-session.js";
import type { ConversationDisplayPage, ConversationDisplayRecord } from "../src/conversation/display-history.js";
import { assistantToolArgumentReference } from "../src/conversation/approval-arguments.js";
import { createInitialConversationState } from "../src/conversation/state.js";

const sessions: ApplicationConversationSession[] = [];
afterEach(() => { cleanup(); for (const session of sessions.splice(0)) session.dispose(); });
function fixture() {
  let revision = 100, generation = 0;
  const proposal = (id: string): ConversationDisplayRecord => ({ kind: "approval", id, revision: 2, turnId: "old",
    bytes: 200, deferred: false, value: { proposal_id: id, tool_call_id: `tool-${id}`, tool_name: `save-${id}`,
      turn_id: "old", group_id: "chat", status: "pending", proposal_version: 1, expires_at: null,
      reviewed_arguments: { type: "opaque_reference", argument_ref: assistantToolArgumentReference({ value: 42 }) } } as never });
  const page = (records: readonly ConversationDisplayRecord[] = [], nextCursor: string | null = null): ConversationDisplayPage => ({
    schemaVersion: 1, status: "ready", conversationId: "chat", generation, revision, canonicalRevision: revision,
    activeTurnId: null, records, nextCursor });
  const read = vi.fn(async (input: any, signal?: AbortSignal): Promise<ConversationDisplayPage> => {
    void signal;
    if (input.view?.type === "pending_approvals") return input.cursor ? page([proposal("one")]) : page([proposal("two")], "older");
    if (input.view?.type === "approval") return page([proposal(input.view.proposalId), { kind: "tool", id: `tool-${input.view.proposalId}`,
      revision: 2, bytes: 200, turnId: "old", deferred: false, value: { tool_call_id: `tool-${input.view.proposalId}`, turn_id: "old",
        name: `save-${input.view.proposalId}`, arguments: { value: 42 } } as never }]);
    return page();
  });
  const session = new ApplicationConversationSession({ conversationId: "chat" as never, clientId: "client" as never,
    reader: { page: read, changes: async () => ({ ...page(), throughRevision: revision }),
      control: async () => ({ ...page(), activeTurn: null, latestTurn: null, requestedTurn: null, hasPendingApprovals: true }) },
    resources: { appendMutations: vi.fn() }, transport: {} as never,
    pendingStore: { load: async () => null, retain: vi.fn(), acknowledge: vi.fn() }, pendingApprovals: true,
    pollMilliseconds: 300000 });
  sessions.push(session);
  const decide = vi.fn(async () => {});
  const view = () => render(<ConversationPendingApprovals session={session} renderApproval={(p, tools) => <StandardApprovalCard proposal={p}
    context={{ state: { ...createInitialConversationState("chat" as never), tool_calls: tools }, busy: false, readOnly: false, decide }}/>}/>);
  return { session, read, page, view, decide, advance: () => ++revision, clear: () => { generation = ++revision; } };
}

it("opens old pending actions on demand, keeps one page, and binds confirmation to fetched review details", async () => {
  const f = fixture(); await f.session.initialize(); f.view();
  expect(f.read.mock.calls.some(([input]) => input.view?.type === "pending_approvals")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Review pending approvals" }));
  fireEvent.click(await screen.findByRole("button", { name: "Older pending approvals" }));
  const old = await screen.findByRole("button", { name: "Review save-one" });
  expect(screen.queryByRole("button", { name: "Review save-two" })).toBeNull();
  expect(f.read.mock.calls.filter(([input]) => input.view?.type === "approval")).toHaveLength(0);
  fireEvent.click(old);
  const confirm = await screen.findByRole("button", { name: "Confirm" });
  expect(confirm.hasAttribute("disabled")).toBe(false);
  expect(f.read.mock.calls.find(([input]) => input.view?.type === "approval")?.[0]).toMatchObject({ limit: 2, maximumBytes: 131072 });
  fireEvent.click(confirm); expect(f.decide).toHaveBeenCalledWith("confirmed");
  fireEvent.click(screen.getByRole("button", { name: "Newest pending approvals" }));
  await screen.findByRole("button", { name: "Review save-two" });
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close pending approvals" }));
  expect(screen.queryByRole("button", { name: "Review save-two" })).toBeNull();
  expect(f.session.getSnapshot().window.records).toHaveLength(0);
});

it("cancels a held inbox read on close and rejects a response behind an independently refreshed control", async () => {
  const f = fixture(); await f.session.initialize(); f.view();
  let resolve!: (page: ConversationDisplayPage) => void;
  const held = new Promise<ConversationDisplayPage>(accept => { resolve = accept; });
  f.read.mockImplementationOnce(async () => held);
  fireEvent.click(screen.getByRole("button", { name: "Review pending approvals" }));
  await waitFor(() => expect(f.read.mock.calls.at(-1)?.[0].view?.type).toBe("pending_approvals"));
  const signal = f.read.mock.calls.at(-1)![1]!;
  fireEvent.click(screen.getByRole("button", { name: "Close pending approvals" }));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(f.page()));
  expect(screen.queryByText("No pending approvals on this page.")).toBeNull();
  const stale = f.page(); f.advance(); await f.session.refresh();
  f.read.mockResolvedValueOnce(stale);
  await expect(f.session.readApprovals({}, new AbortController().signal)).rejects.toMatchObject({ code: "stale_approvals" });
});

it("fails closed when an oversized review tool is deferred and never fetches its full content automatically", async () => {
  const f = fixture(); await f.session.initialize(); f.view();
  fireEvent.click(screen.getByRole("button", { name: "Review pending approvals" }));
  const button = await screen.findByRole("button", { name: "Review save-two" });
  const original = f.read.getMockImplementation()!;
  f.read.mockImplementationOnce(async (input, signal) => {
    const page = await original(input, signal);
    return { ...page, records: page.records.map(record => record.kind === "tool" ? { ...record, value: null, deferred: true, bytes: 1000000 } : record) };
  });
  fireEvent.click(button);
  const confirm = await screen.findByRole("button", { name: "Confirm" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Action details are unavailable/)).toBeTruthy();
});


it("clears an open review when the account changes even if chat IDs and revision numbers match", async () => {
  const first = fixture(), second = fixture();
  await first.session.initialize(); await second.session.initialize();
  const rendered = first.view();
  fireEvent.click(screen.getByRole("button", { name: "Review pending approvals" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review save-two" }));
  await screen.findByRole("button", { name: "Confirm" });
  rendered.rerender(<ConversationPendingApprovals session={second.session} renderApproval={() => <div>Second account</div>}/>);
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Close pending approvals" })).toBeNull();
  expect(second.read.mock.calls.some(([input]) => input.view?.type === "pending_approvals" || input.view?.type === "approval")).toBe(false);
});
