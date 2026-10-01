import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialConversationState, type ConversationApprovalProposalRecord } from "../../dist/index.js";
import { ConversationDisplayWindow } from "../../dist/client/index.js";
import { ConversationDisplayTranscript, ConversationTranscript } from "../../dist/react/index.js";

const messages = Array.from({ length: 25 }, (_, index) => ({ message_id: `m${index}` as never,
  role: "assistant" as const, content: [{ type: "text" as const, text: `Message ${index}` }],
  attachments: [], attribution: null, created_at: null }));
const state = { ...createInitialConversationState("synthetic" as never), messages,
  approval_proposals: ["Review proposed change", "Update a vehicle or boat", "Send invoice"].map((tool_name, i) => ({
    proposal_id: `p${i}`, tool_name, status: "executed", turn_id: "turn", created_at: "2026-10-01T00:00:00Z",
  }) as ConversationApprovalProposalRecord) };
const controller = new ConversationDisplayWindow({ reader: {
  page: async () => ({ schemaVersion: 1, conversationId: "synthetic", status: "ready", revision: 1,
    canonicalRevision: 1, generation: 0, activeTurnId: null, nextCursor: null,
    records: messages.map((value, i) => ({ kind: "message", id: value.message_id, revision: i, bytes: 100,
      turnId: null, deferred: false, value })) }),
  changes: async () => { throw new Error("No remote polling in this fixture"); },
} });
function Fixture() {
  const [frame, update] = useState(0);
  Object.assign(window, { streamFrame: () => update(value => value + 1) });
  const style = { height: "55vh", overflow: "auto", overflowAnchor: "none" as const };
  const message = (id: string) => <p style={{ height: id === "m24" ? 90 + frame * 10 : 90 }}>{id}</p>;
  return <main>
    <section id="full"><ConversationTranscript state={{ ...state, revision: frame as typeof state.revision }} style={style}
      renderMessage={m => message(m.message_id)} renderApproval={p => <article>{p.tool_name} · Executed</article>}/></section>
    <section id="paged"><ConversationDisplayTranscript controller={controller} conversationId="synthetic"
      pollingMilliseconds={0} contentVersion={frame} style={style} renderMessage={m => message(m.id)}/></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
