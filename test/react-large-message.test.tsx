/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationDisplayWindow } from "../src/client/display-window.js";
import { ConversationDisplayTranscript } from "../src/react/display-transcript.js";
import type { ConversationMessageTextReader } from "../src/react/large-message.js";
import type { ConversationDisplayContentChunk, ConversationDisplayPage } from "../src/conversation/display-history.js";
afterEach(cleanup);
const fixture = (reader: ConversationMessageTextReader) => {
  const controller = new ConversationDisplayWindow({ reader: { page: async input => ({ schemaVersion: 1,
    conversationId: input.conversationId, generation: 0, revision: 4, canonicalRevision: 4, activeTurnId: null, status: "ready", nextCursor: null,
    records: ["one", "two"].map(id => ({ kind: "message", id, revision: 4, turnId: null, bytes: 80000, deferred: true, value: null })),
  }) as ConversationDisplayPage, changes: vi.fn() } });
  const props = { controller, pollingMilliseconds: 0, renderMessage: () => null, readMessageText: reader };
  const view = render(<ConversationDisplayTranscript {...props} conversationId="a"/>);
  return { view, controller, props };
};
it("loads large text only on demand, retains one bounded part, and reads earlier parts without assembling the message", async () => {
  const first = "😀".repeat(8192), last = "Final <script>literal text</script>";
  const read = vi.fn<ConversationMessageTextReader>(async input => ({ encoding: "plain-text", revision: 4,
    text: input.offset === 0 ? first : last, nextOffset: input.offset === 0 ? 8192 : null }));
  const { view, controller } = fixture(read);
  try {
    await waitFor(() => expect(view.getAllByRole("button", { name: "Read message" })).toHaveLength(2));
    expect(read).not.toHaveBeenCalled(); fireEvent.click(view.getAllByRole("button", { name: "Read message" })[0]!);
    await waitFor(() => expect(view.getByLabelText("Message text part").textContent).toBe(first));
    expect(read.mock.calls[0]![0]).toEqual({ conversationId: "a", generation: 0, kind: "message", id: "one", revision: 4, format: "message-text", offset: 0 });
    fireEvent.click(view.getByRole("button", { name: "Next part" }));
    await waitFor(() => expect(view.getByLabelText("Message text part").textContent).toBe(last));
    expect(view.queryByText(first)).toBeNull(); expect(view.container.querySelector("script")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Previous part" }));
    await waitFor(() => expect(view.getByLabelText("Message text part").textContent).toBe(first));
    fireEvent.click(view.getByRole("button", { name: "Read message" }));
    await waitFor(() => expect(read.mock.calls.at(-1)![0].id).toBe("two"));
    expect(view.getAllByRole("region", { name: "Large message text" })).toHaveLength(1);
    expect(controller.getSnapshot().records.every(record => record.value === null)).toBe(true);
  } finally { view.unmount(); controller.dispose(); }
});
it("aborts a pending section on chat switch and rejects its late result even when the reader ignores cancellation", async () => {
  let resolve!: (value: ConversationDisplayContentChunk) => void;
  const read = vi.fn<ConversationMessageTextReader>(() => new Promise(done => { resolve = done; }));
  const { view, controller, props } = fixture(read);
  try {
    await waitFor(() => expect(view.getAllByRole("button", { name: "Read message" })).toHaveLength(2));
    fireEvent.click(view.getAllByRole("button", { name: "Read message" })[0]!);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    view.rerender(<ConversationDisplayTranscript {...props} conversationId="b"/>);
    expect(read.mock.calls[0]![1].aborted).toBe(true);
    await act(async () => { resolve({ encoding: "plain-text", revision: 4, text: "old account content", nextOffset: null }); });
    expect(view.queryByText("old account content")).toBeNull();
    view.rerender(<ConversationDisplayTranscript {...props} conversationId="a"/>);
    await waitFor(() => expect(view.getAllByRole("button", { name: "Read message" })).toHaveLength(2));
    expect(read).toHaveBeenCalledOnce();
  } finally { view.unmount(); controller.dispose(); }
});
it.each(["content_changed", "forbidden"])("clears content and exposes safe handling for %s", async code => {
  const read = vi.fn<ConversationMessageTextReader>(async () => { throw { resourceCode: code }; });
  const { view, controller } = fixture(read);
  try {
    await waitFor(() => expect(view.getAllByRole("button", { name: "Read message" })).toHaveLength(2));
    fireEvent.click(view.getAllByRole("button", { name: "Read message" })[0]!);
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(view.queryByLabelText("Message text part")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry reading" })).toBeNull();
    expect(Boolean(view.queryByRole("button", { name: "Reload message" }))).toBe(code === "content_changed");
  } finally { view.unmount(); controller.dispose(); }
});
