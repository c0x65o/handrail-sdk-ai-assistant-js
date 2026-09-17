/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationDeferredRecords } from "../src/react/deferred-records.js";
import type { ConversationMessageTextReader } from "../src/react/large-message.js";
import type { ConversationDisplayContentChunk, ConversationDisplayRecord } from "../src/conversation/display-history.js";
afterEach(cleanup);
const records: ConversationDisplayRecord[] = ["tool", "source", "approval"].map((kind, index) => ({
  kind, id: `id-${index}`, revision: 4, turnId: "turn", bytes: 80000, deferred: true, value: null,
})) as ConversationDisplayRecord[];

it("loads only explicit details, keeps one section and cannot grant approval from record text", async () => {
  const first = "😀".repeat(8192), last = '{ "text": "<script>literal</script>" }';
  const read = vi.fn<ConversationMessageTextReader>(async input => ({ encoding: "plain-text", revision: 4,
    text: input.offset === 0 ? first : last, nextOffset: input.offset === 0 ? 8192 : null }));
  const view = render(<ConversationDeferredRecords conversationId="chat" generation={0} records={records} read={read} onRefresh={vi.fn()}/>);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(view.getAllByRole("button", { name: "Read details" })[0]!);
  await waitFor(() => expect(view.getByLabelText("Details part").textContent).toBe(first));
  expect(read.mock.calls[0]![0]).toMatchObject({ kind: "tool", id: "id-0", format: "record-text", revision: 4, offset: 0 });
  fireEvent.click(view.getByRole("button", { name: "Next part" }));
  await waitFor(() => expect(view.getByLabelText("Details part").textContent).toBe(last));
  expect(view.queryByText(first)).toBeNull(); expect(view.container.querySelector("script")).toBeNull();
  fireEvent.click(view.getAllByRole("button", { name: "Read details" })[1]!);
  await waitFor(() => expect(read.mock.calls.at(-1)![0].kind).toBe("approval"));
  expect(view.getAllByRole("region", { name: "Record details" })).toHaveLength(1);
  expect(view.queryByRole("button", { name: /confirm|approve/iu })).toBeNull();
});

it("cancels and hides old-account details immediately even when record IDs match", async () => {
  let resolve!: (value: ConversationDisplayContentChunk) => void;
  const read = vi.fn<ConversationMessageTextReader>(() => new Promise(done => { resolve = done; }));
  const props = { conversationId: "chat", generation: 0, records, read, onRefresh: vi.fn() };
  const view = render(<ConversationDeferredRecords {...props}/>);
  fireEvent.click(view.getAllByRole("button", { name: "Read details" })[0]!);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  const next = vi.fn<ConversationMessageTextReader>();
  view.rerender(<ConversationDeferredRecords {...props} read={next}/>);
  expect(read.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => resolve({ encoding: "plain-text", revision: 4, text: "old account", nextOffset: null }));
  expect(view.queryByText("old account")).toBeNull(); expect(next).not.toHaveBeenCalled();
});
