/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationDisplayWindow } from "../src/client/display-window.js";
import { ConversationDisplayTranscript } from "../src/react/display-transcript.js";
import type { ConversationDisplayPage, ConversationDisplayRecord } from "../src/conversation/display-history.js";

afterEach(cleanup);
const record = (id: string): ConversationDisplayRecord => ({ kind: "message", id, turnId: null,
  revision: 1, bytes: 100, deferred: false, value: { message_id: id as never, role: "user", content: [],
    attachments: [], attribution: null, created_at: null } });
const page = (id: string, records = [record(`${id}-message`)]): ConversationDisplayPage => ({ schemaVersion: 1,
  conversationId: id, status: "ready", revision: 10, canonicalRevision: 10, generation: 0,
  activeTurnId: null, records, nextCursor: null });

it("loads only the selected display page, exposes oversized content explicitly, and retries an initial failure", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page("a", [
    { ...record("large"), value: null, deferred: true }, record("a-message"),
  ]));
  const controller = new ConversationDisplayWindow({ reader: { page: read, changes: vi.fn() } });
  const view = render(<ConversationDisplayTranscript controller={controller} conversationId="a" pollingMilliseconds={0}
    renderMessage={record => <p>{record.id}</p>}/>);
  expect(view.getByRole("status").textContent).toContain("Loading conversation");
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Retry history" }));
  await waitFor(() => expect(view.getByText("a-message")).toBeTruthy());
  expect(view.getByText("This message is too large for the history preview.")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount(); controller.dispose();
});

it("hides the previous conversation immediately and cancels reads on unmount", async () => {
  let resolve!: (page: ConversationDisplayPage) => void;
  let signal: AbortSignal | undefined;
  const read = vi.fn(async (input: { conversationId: string }, abort?: AbortSignal) => {
    if (input.conversationId === "b") { signal = abort; return new Promise<ConversationDisplayPage>(done => { resolve = done; }); }
    return page(input.conversationId);
  });
  const controller = new ConversationDisplayWindow({ reader: { page: read, changes: vi.fn() } });
  const props = { controller, pollingMilliseconds: 0, renderMessage: (record: ConversationDisplayRecord) => <p>{record.id}</p> };
  const view = render(<ConversationDisplayTranscript {...props} conversationId="a"/>);
  await waitFor(() => expect(view.getByText("a-message")).toBeTruthy());
  view.rerender(<ConversationDisplayTranscript {...props} conversationId="b"/>);
  expect(view.queryByText("a-message")).toBeNull();
  await waitFor(() => expect(signal).toBeDefined());
  view.unmount(); expect(signal!.aborted).toBe(true);
  await act(async () => { resolve(page("b")); });
  expect(controller.getSnapshot().records).toEqual([]); controller.dispose();
});

it("restores the saved message with one anchor query instead of traversing prior pages", async () => {
  const read = vi.fn(async (input: { conversationId: string }) => ({ ...page(input.conversationId), generation: 5 }));
  const positions = { get: vi.fn(() => ({ messageId: "saved", generation: 5, offset: -20, following: false })), set: vi.fn() };
  const controller = new ConversationDisplayWindow({ reader: { page: read, changes: vi.fn() } });
  const view = render(<ConversationDisplayTranscript controller={controller} conversationId="a" pollingMilliseconds={0}
    positions={positions} renderMessage={record => <p>{record.id}</p>}/>);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(read.mock.calls[0]![0]).toMatchObject({ anchor: { messageId: "saved", generation: 5, direction: "newer", inclusive: true } });
  view.unmount(); controller.dispose();
});
