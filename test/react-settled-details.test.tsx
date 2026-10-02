// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationConversationSession } from "../src/client/application-session.js";
import type { ConversationDisplayPage, ConversationDisplayRecord } from "../src/conversation/display-history.js";
import { assistantToolArgumentReference } from "../src/conversation/approval-arguments.js";
import { createInitialConversationState, type ConversationApprovalProposalRecord } from "../src/conversation/state.js";
import { ConversationContext } from "../src/react/context.js";
import { StyledChatPreset } from "../src/react-styled/index.js";

const sessions: ApplicationConversationSession[] = [];
afterEach(() => { cleanup(); sessions.splice(0).forEach(session => session.dispose()); });
function fixture() {
  const values = [{ record: "Boat A", patch: { transport: "trailer" } }, { record: "Boat B", patch: { transport: "moored" } },
    { invoice: "Invoice C", recipient: "Billing team" }];
  const proposals = values.map((value, index) => ({ proposal_id: `p${index}`, proposal_version: 4, group_id: "chat",
    turn_id: "turn", tool_call_id: `call${index}`, tool_name: index === 2 ? "send_invoice" : "update_asset",
    status: index === 1 ? "rejected" : "executed", failure_reason: null, created_at: "2026-10-01T00:00:00.000Z",
    reviewed_arguments: { type: "opaque_reference", argument_ref: assistantToolArgumentReference(value) },
  }) as ConversationApprovalProposalRecord);
  const tools = proposals.map((proposal, i) => ({ turn_id: proposal.turn_id, tool_call_id: proposal.tool_call_id,
    name: proposal.tool_name, arguments: values[i] }) as never);
  const page = (records: readonly ConversationDisplayRecord[] = []): ConversationDisplayPage => ({ schemaVersion: 1,
    status: "ready", conversationId: "chat", generation: 0, revision: 10, canonicalRevision: 10, activeTurnId: null,
    records, nextCursor: null });
  const read = vi.fn(async (input: any): Promise<ConversationDisplayPage> => {
    const index = proposals.findIndex(p => p.proposal_id === input.view?.proposalId);
    if (index < 0) return page();
    return page([{ kind: "approval", id: proposals[index]!.proposal_id, turnId: "turn", revision: 10,
      bytes: 200, deferred: false, value: proposals[index]! }, { kind: "tool", id: `call${index}`, turnId: "turn", revision: 10,
      bytes: 200, deferred: false, value: tools[index]! }]);
  });
  const session = new ApplicationConversationSession({ conversationId: "chat" as never, clientId: "client" as never,
    reader: { page: read, changes: async () => ({ ...page(), throughRevision: 10 }),
      control: async () => ({ ...page(), activeTurn: null, latestTurn: null, requestedTurn: null, hasPendingApprovals: false }) },
    resources: { appendMutations: vi.fn() }, transport: {} as never, pendingApprovals: true,
    pendingStore: { load: async () => null, retain: vi.fn(), acknowledge: vi.fn() }, pollMilliseconds: 300000 });
  sessions.push(session);
  const state = { ...createInitialConversationState("chat" as never), approval_proposals: proposals };
  const binding = { store: { getSnapshot: () => state, subscribe: () => () => {} }, runtime: { displaySession: session } } as never;
  const view = (partial: boolean) => <ConversationContext.Provider value={binding}>
    <StyledChatPreset state={partial ? { ...state, partial: true } : { ...state, tool_calls: tools }}
      includeStyles={false} readOnly transcription={false}/></ConversationContext.Provider>;
  return { session, read, view, proposals, page };
}

it.each([false, true])("preserves distinguishable saved details through collapse and reload (paged=%s)", async partial => {
  const f = fixture(); await f.session.initialize();
  const view = render(f.view(partial));
  const callsBefore = f.read.mock.calls.length;
  expect(screen.queryByText("Boat A")).toBeNull();
  fireEvent.click(screen.getByText("Action history (3)"));
  for (const summary of await screen.findAllByText("Action details")) fireEvent.click(summary);
  expect(await screen.findByText("Boat A")).toBeTruthy();
  expect(screen.getByText("Boat B")).toBeTruthy();
  expect(screen.getByText("Invoice C")).toBeTruthy();
  expect(screen.getByText("trailer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  expect(f.read.mock.calls.length - callsBefore).toBe(partial ? 3 : 0);
  fireEvent.click(screen.getByText("Action history (3)"));
  expect(screen.queryByText("Boat A")).toBeNull();
  view.unmount(); render(f.view(partial));
  expect(screen.queryByText("Action details")).toBeNull();
  fireEvent.click(screen.getByText("Action history (3)"));
  expect(await screen.findAllByText("Action details")).toHaveLength(3);
});

it("rejects a changed saved version and drops detail reads when history closes", async () => {
  const f = fixture(); await f.session.initialize();
  f.read.mockImplementation(async () => f.page([{ kind: "approval", id: "p0", turnId: "turn", revision: 10,
    bytes: 200, deferred: false, value: { ...f.proposals[0]!, proposal_version: 5 } }]));
  render(f.view(true)); fireEvent.click(screen.getByText("Action history (3)"));
  await screen.findAllByRole("button", { name: "Retry action details" });
  expect(screen.queryByText("Boat A")).toBeNull();
  let release!: (value: ConversationDisplayPage) => void;
  f.read.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  fireEvent.click(screen.getAllByRole("button", { name: "Retry action details" })[0]!);
  await waitFor(() => expect(release).toBeDefined());
  fireEvent.click(screen.getByText("Action history (3)"));
  await act(async () => release(f.page()));
  expect(screen.queryByText("Saved action details are unavailable.")).toBeNull();
});
