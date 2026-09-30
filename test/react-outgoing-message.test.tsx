/** @vitest-environment jsdom */
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createApplicationConversationRuntime } from "../src/client/application-runtime.js";
import { InMemoryApplicationConversationPendingStore } from "../src/client/session-submission.js";
import { ConversationProvider } from "../src/react/context.js";
import { ConversationTranscript } from "../src/react/conversation-transcript.js";

it("renders and follows outgoing text before a slow send, then removes it after a preflight failure", async () => {
  const control = { schemaVersion: 1 as const, conversationId: "chat", generation: 0, revision: 0, canonicalRevision: 0,
    status: "ready" as const, activeTurnId: null, activeTurn: null, latestTurn: null, requestedTurn: null };
  const pending = new InMemoryApplicationConversationPendingStore();
  const runtime = createApplicationConversationRuntime({ conversationId: "chat" as never, clientId: "client" as never,
    reader: { control: async () => control, page: async () => ({ ...control, records: [], nextCursor: null }),
      changes: async () => ({ ...control, records: [], nextCursor: null, throughRevision: 0 }) },
    resources: { appendMutations: vi.fn() }, transport: { capabilities: {
      authoritativeCancellation: { supported: false }, attachmentUpload: { supported: false }, documentInput: { supported: false },
      presence: { supported: false }, synchronization: { supported: false } }, startTurn: vi.fn(), resumeTurn: vi.fn() }, pendingStore: pending });
  const session = runtime.displaySession!;
  await waitFor(() => expect(session.getSnapshot().control?.status).toBe("ready"));
  const view = render(<ConversationProvider runtime={runtime}><ConversationTranscript state={runtime.getSnapshot()} emptyState={<p>Start chatting</p>}/></ConversationProvider>);
  try {
    const transcript = view.getByRole("log");
    Object.defineProperties(transcript, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 300 } });
    let reject!: (cause: unknown) => void;
    vi.spyOn(pending, "load").mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    let sending!: Promise<unknown>;
    act(() => { sending = session.sendMessage({ content: "Visible immediately", request: { text: "Visible immediately" } }).catch(() => undefined); });
    expect(view.getByText("Visible immediately")).toBeTruthy();
    expect(view.getByText("Sending…")).toBeTruthy();
    expect(view.queryByText("Start chatting")).toBeNull();
    expect(transcript.scrollTop).toBe(900);
    await act(async () => { reject(new Error("Storage offline")); await sending; });
    expect(view.queryByText("Visible immediately")).toBeNull();
    expect(view.getByText("Start chatting")).toBeTruthy();
  } finally { view.unmount(); runtime.destroy(); }
});
