import { expect, it, vi } from "vitest";
import { ConversationDisplayWindow, type ConversationDisplayReader } from "../src/client/display-window.js";
import { ConversationDisplayHistoryError, type ConversationDisplayPage, type ConversationDisplayRecord,
  type ConversationDisplayPageInput } from "../src/conversation/display-history.js";

function record(id: number, text = `Message ${id}`, revision = id): ConversationDisplayRecord {
  return { kind: "message", id: `message-${id}`, revision, bytes: text.length + 200, turnId: null, deferred: false,
    value: { message_id: `message-${id}` as never, role: "user", content: [{ type: "text", text }],
      attachments: [], created_at: null, attribution: null } };
}
function page(conversationId: string, records: readonly ConversationDisplayRecord[], more = false): ConversationDisplayPage {
  return { schemaVersion: 1, status: "ready", conversationId, generation: 0, revision: 100,
    canonicalRevision: 100, activeTurnId: null, records, nextCursor: more ? "next" : null };
}
function fixture(textSize = 0) {
  const records = Array.from({ length: 20 }, (_, index) => record(index + 1, textSize ? "a".repeat(textSize) : undefined));
  const reader: ConversationDisplayReader = {
    page: vi.fn(async input => {
      const anchor = input.anchor, count = input.limit!;
      const index = anchor ? records.findIndex(record => record.id === anchor.messageId) : records.length;
      const start = anchor?.direction === "newer" ? index + (anchor.inclusive ? 0 : 1) : Math.max(0, index - count);
      const end = anchor?.direction === "newer" ? start + count : index;
      return page(input.conversationId, records.slice(start, end), anchor?.direction === "newer" ? end < records.length : start > 0);
    }),
    changes: vi.fn(async input => ({ ...page(input.conversationId, []), throughRevision: 100 })),
  };
  const window = new ConversationDisplayWindow({ reader, pageSize: 3, maximumMessages: textSize ? 30 : 6,
    pageBytes: 8192, maximumBytes: 16384 });
  return { records, reader, window };
}
const ids = (window: ConversationDisplayWindow) => window.getSnapshot().records.map(row => row.id);

it("keeps a bounded window while scrolling up and down, deduplicates simultaneous reads, and jumps to latest", async () => {
  const { reader, window } = fixture();
  await window.select("a"); expect(ids(window)).toEqual([18, 19, 20].map(id => `message-${id}`));
  await Promise.all([window.loadOlder(), window.loadOlder(), window.loadOlder()]);
  expect(reader.page).toHaveBeenCalledTimes(2);
  expect(ids(window)).toEqual([15, 16, 17, 18, 19, 20].map(id => `message-${id}`));
  await window.loadOlder(); expect(ids(window)).toEqual([12, 13, 14, 15, 16, 17].map(id => `message-${id}`));
  expect(window.getSnapshot()).toMatchObject({ hasOlder: true, hasNewer: true });
  await window.loadNewer(); expect(ids(window)).toEqual([15, 16, 17, 18, 19, 20].map(id => `message-${id}`));
  await window.jumpToLatest(); expect(ids(window)).toEqual([18, 19, 20].map(id => `message-${id}`));
  expect(window.getSnapshot()).toMatchObject({ hasOlder: true, hasNewer: false });
  expect(reader.changes).not.toHaveBeenCalled(); window.dispose();
});

it("bounds retained bytes independently of message count", async () => {
  const { window } = fixture(2000);
  await window.select("a");
  for (let index = 0; index < 6; index++) {
    await window.loadOlder();
    expect(window.getSnapshot().retainedBytes).toBeLessThanOrEqual(16384);
    expect(window.getSnapshot().records.length).toBeLessThan(9);
  }
  window.dispose();
});

it("aborts selection requests and ignores late responses even if the reader ignores AbortSignal", async () => {
  const pending: { input: ConversationDisplayPageInput; signal?: AbortSignal; resolve: (page: ConversationDisplayPage) => void }[] = [];
  const reader: ConversationDisplayReader = { page: (input, signal) => new Promise(resolve => {
    pending.push({ input, ...(signal ? { signal } : {}), resolve });
  }), changes: vi.fn() };
  const window = new ConversationDisplayWindow({ reader });
  const first = window.select("a"); await Promise.resolve();
  const second = window.select("b"); await Promise.resolve();
  expect(pending[0]!.signal!.aborted).toBe(true);
  pending[1]!.resolve(page("b", [record(2)])); await second;
  pending[0]!.resolve(page("a", [record(1)])); await first;
  expect(window.getSnapshot().conversationId).toBe("b"); expect(ids(window)).toEqual(["message-2"]);
  const third = window.select("c"); await Promise.resolve(); window.dispose();
  pending[2]!.resolve(page("c", [record(3)])); await third;
  expect(window.getSnapshot().records).toEqual([]); expect(pending[2]!.signal!.aborted).toBe(true);
});

it("retains the changes watermark until its last page and keeps new off-screen messages out of the reading window", async () => {
  const { window, reader } = fixture(); await window.select("a");
  const changes = vi.mocked(reader.changes);
  changes.mockResolvedValueOnce({ ...page("a", [record(19, "updated", 101)]), revision: 103, canonicalRevision: 103,
    throughRevision: 103, nextCursor: "changes-next" });
  changes.mockResolvedValueOnce({ ...page("a", [record(21, "new", 102)]), revision: 103, canonicalRevision: 103,
    throughRevision: 103, nextCursor: null });
  changes.mockResolvedValueOnce({ ...page("a", []), revision: 103, canonicalRevision: 103, throughRevision: 103 });
  await window.refresh(); await window.refresh(); await window.refresh();
  expect(changes.mock.calls.map(call => call[0].afterRevision)).toEqual([100, 100, 103]);
  expect(changes.mock.calls[1]![0].cursor).toBe("changes-next");
  expect(ids(window)).toEqual(["message-18", "message-19", "message-20"]);
  expect(window.getSnapshot().records[1]!.value).toMatchObject({ content: [{ text: "updated" }] });
  expect(window.getSnapshot().hasNewer).toBe(true); window.dispose();
});

it("keeps loaded text on transient failures but evicts it on clear or authorization failure", async () => {
  const { window, reader } = fixture(); await window.select("a");
  vi.mocked(reader.page).mockRejectedValueOnce(new Error("offline"));
  await window.loadOlder(); expect(ids(window)).toHaveLength(3);
  expect(window.getSnapshot().error?.operation).toBe("older");
  await window.retry(); expect(ids(window)).toHaveLength(6);
  vi.mocked(reader.changes).mockRejectedValueOnce(new ConversationDisplayHistoryError("stale_cursor", "cleared"));
  await window.refresh(); expect(ids(window)).toEqual([]); expect(window.getSnapshot().error?.operation).toBe("initial");
  await window.retry(); expect(ids(window)).toHaveLength(3);
  vi.mocked(reader.changes).mockRejectedValueOnce({ transportCode: "forbidden" });
  await window.refresh(); expect(ids(window)).toEqual([]); window.dispose();
});

it("uses one bounded anchor request to restore a saved position and clears stale content while a projection catches up", async () => {
  const { window, reader } = fixture();
  await window.select("a", { messageId: "message-5", generation: 0, direction: "newer", inclusive: true });
  expect(ids(window)).toEqual(["message-5", "message-6", "message-7"]);
  expect(reader.page).toHaveBeenCalledOnce();
  vi.mocked(reader.changes).mockResolvedValueOnce({ ...page("a", []), status: "preparing", canonicalRevision: 110,
    throughRevision: 100 });
  await window.refresh(); expect(window.getSnapshot()).toMatchObject({ status: "preparing", records: [] });
  await window.refresh(); expect(ids(window)).toEqual(["message-18", "message-19", "message-20"]);
  window.dispose();
});
