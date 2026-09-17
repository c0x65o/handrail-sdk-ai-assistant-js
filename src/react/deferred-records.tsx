import { useState, type ReactNode } from "react";
import type { ConversationDisplayRecord } from "../conversation/display-history.js";
import { ConversationLargeMessage, type ConversationMessageTextReader } from "./large-message.js";

/** Explicit record inspection, not approval authorization. Keeps just one
 * revision-pinned section, without inserting it into transcript/model state. */
export function ConversationDeferredRecords({ conversationId, generation, records, read, onRefresh }: {
  readonly conversationId: string;
  readonly generation: number;
  readonly records: readonly ConversationDisplayRecord[];
  readonly read: ConversationMessageTextReader;
  readonly onRefresh: () => void;
}): ReactNode {
  const [opened, setOpened] = useState<{ owner: ConversationMessageTextReader; key: string }>();
  const deferred = records.filter(record => record.deferred && !record.deleted);
  if (!deferred.length) return null;
  return <section aria-label="Additional details">
    {deferred.map(record => {
      const key = JSON.stringify([conversationId, generation, record.kind, record.id, record.revision]);
      return <ConversationLargeMessage key={key} conversationId={conversationId} generation={generation}
        record={record} read={read} structured expanded={opened?.owner === read && opened.key === key}
        onOpen={() => setOpened({ owner: read, key })} onClose={() => setOpened(undefined)} onRefresh={onRefresh}/>;
    })}
  </section>;
}
