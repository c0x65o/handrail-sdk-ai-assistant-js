import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ConversationDisplayWindow } from "../../src/client/display-window.js";
import { ConversationDisplayTranscript } from "../../src/react/display-transcript.js";
import type { ConversationDisplayPageInput, ConversationDisplayRecord } from "../../src/conversation/display-history.js";

const requests: ConversationDisplayPageInput[] = [];
const record = (index: number, conversation: string): ConversationDisplayRecord => ({ kind: "message", id: `message-${index}`,
  turnId: null, revision: index, bytes: 300, deferred: false, value: { message_id: `message-${index}` as never, role: "assistant",
    attachments: [], created_at: null, attribution: null,
    content: [{ type: "text", text: `${conversation}: message ${index}\n${"Variable height message content.\n".repeat(index % 4 + 1)}` }] } });
let total = 1000;
let delay = 15;
const controller = new ConversationDisplayWindow({ pageSize: 20, maximumMessages: 60, reader: {
  async page(input, signal) {
    requests.push(input);
    await new Promise(resolve => setTimeout(resolve, input.conversationId === "slow" ? 500 : delay));
    signal?.throwIfAborted();
    const anchor = input.anchor, edge = anchor ? Number(anchor.messageId.split("-")[1]) : total + 1;
    const start = anchor?.direction === "newer" ? edge + (anchor.inclusive ? 0 : 1) : Math.max(1, edge - input.limit!);
    const end = anchor?.direction === "newer" ? Math.min(total, start + input.limit! - 1) : edge - 1;
    return { schemaVersion: 1, status: "ready", conversationId: input.conversationId, generation: 0,
      revision: total, canonicalRevision: total, activeTurnId: null,
      records: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => record(start + index, input.conversationId)),
      nextCursor: (anchor?.direction === "newer" ? end < total : start > 1) ? "more" : null };
  },
  async changes(input) { return { schemaVersion: 1, status: "ready", conversationId: input.conversationId, generation: 0,
    revision: total, canonicalRevision: total, activeTurnId: null, throughRevision: total, records: [], nextCursor: null }; },
} });
function App() {
  const [conversation, setConversation] = useState("chat");
  Object.assign(globalThis, { fixture: { controller, requests, setConversation, setTotal: (value: number) => { total = value; },
    setDelay: (value: number) => { delay = value; } } });
  return <><button onClick={() => setConversation("slow")}>Slow chat</button><button onClick={() => setConversation("fast")}>Fast chat</button>
    <ConversationDisplayTranscript controller={controller} conversationId={conversation} pollingMilliseconds={0} id="transcript"
      renderMessage={record => <p>{record.value?.content.map(part => part.type === "text" ? part.text : "").join("")}</p>}/></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
