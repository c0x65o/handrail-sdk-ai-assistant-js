import type { ConversationDisplayRecord, ConversationDisplayView } from "../conversation/display-history.js";

/** Leave room for the authenticated chat identity and maximum opaque cursor in
 * the gateway's 8 KiB envelope. More reference groups load only on demand. */
export function relatedViews(messageIds: readonly string[], turnId?: string): readonly ConversationDisplayView[] {
  const encoder = new TextEncoder(), groups: ConversationDisplayView[] = [];
  let ids: string[] = [], turn = turnId;
  const view = (): ConversationDisplayView => ({ type: "context", messageIds: ids, ...(turn ? { turnId: turn } : {}) });
  for (const id of [...messageIds].reverse()) {
    ids = [...ids, id];
    if (encoder.encode(JSON.stringify(view())).byteLength > 2048) {
      ids = ids.slice(0, -1); groups.push(view()); ids = [id]; turn = undefined;
    }
  }
  if (ids.length || turn) groups.push(view());
  return groups;
}

/** A bounded activity window, separate from message retention. Incoming pages
 * remain readable; moving past the bound explicitly exposes a restart action. */
export function mergeRelatedRecords(previous: readonly ConversationDisplayRecord[], incoming: readonly ConversationDisplayRecord[],
  direction: "older" | "latest" | "changes") {
  const key = (record: ConversationDisplayRecord) => JSON.stringify([record.kind, record.id]);
  const existing = new Map(previous.map(record => [key(record), record]));
  const updates = new Map(incoming.map(record => [key(record), record]));
  const order = direction === "older" ? [...incoming, ...previous] : [...previous, ...incoming];
  const merged = new Map<string, ConversationDisplayRecord>();
  for (const record of order) {
    const id = key(record), old = existing.get(id), update = updates.get(id);
    if (direction === "changes" && !old) continue;
    const value = old && (!update || old.revision > update.revision) ? old : update ?? record;
    if (!value.deleted && value.kind !== "message") merged.set(id, value);
  }
  const records = [...merged.values()], encoder = new TextEncoder();
  const sizes = records.map(record => encoder.encode(JSON.stringify(record)).byteLength + 1);
  let bytes = sizes.reduce((sum, size) => sum + size, 2), trimmed = false;
  while (records.length > 90 || bytes > 262144) {
    if (direction === "older") { records.pop(); bytes -= sizes.pop()!; }
    else { records.shift(); bytes -= sizes.shift()!; }
    trimmed = true;
  }
  return { records: Object.freeze(records), bytes, trimmed };
}
