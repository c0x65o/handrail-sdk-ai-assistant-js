import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialConversationState, parseConversationEvent, reduceConversationEvent, type ConversationState } from "../../dist/index.js";
import { StyledChatPreset, StyledChatPresetStyles } from "../../dist/react-styled/index.js";

function snapshot(stage: number) {
  const payloads: object[] = [
    { type: "message.created", message_id: "question", role: "user", content: [{ type: "text", text: "What is the income this month?" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
  ];
  if (stage >= 1) for (let i = 0; i < 20; i++) {
    payloads.push({ type: "tool_call.requested", turn_id: "turn", tool_call_id: `call-${i}`, name: i === 0 ? "read_profit_and_loss" : `check_revenue_source_${i}`, arguments: { private: "DO_NOT_RENDER" } },
      { type: "tool_call.started", turn_id: "turn", tool_call_id: `call-${i}` });
    if (stage >= 2 || i < 19) payloads.push({ type: "tool_call.result_recorded", turn_id: "turn", tool_call_id: `call-${i}`, is_error: false, content: [{ type: "text", text: "DO_NOT_RENDER" }] });
  }
  if (stage >= 2) payloads.push({ type: "message.text_appended", message_id: "answer", turn_id: "turn", text: "Your income report is ready. These are synthetic preview figures." });
  if (stage >= 3) payloads.push({ type: "turn.completed", turn_id: "turn", outcome: "stop", output_message_ids: ["answer"] });
  return payloads.reduce<ConversationState>((state, payload, index) => reduceConversationEvent(state, parseConversationEvent({ version: 1,
    event_id: `event-${index}`, conversation_id: "preview", revision: index + 1, occurred_at: new Date(1700000000000 + index * 1000).toISOString(),
    actor: { type: "system" }, source: { type: "runtime" }, payload })), createInitialConversationState("preview" as never));
}
function App() {
  const [stage, setStage] = useState(0);
  return <><nav aria-label="Fixture controls">{["Thinking", "Tools", "Writing", "Complete"].map((label, index) =>
    <button key={label} onClick={() => setStage(index)}>{label}</button>)}</nav>
    <div className="hr-aegis-dialog" style={{ height: "calc(100% - 36px)" }}><StyledChatPresetStyles/><StyledChatPreset state={snapshot(stage)}
      title="Ask Aegis" theme={{ colors: { accent: "#a9502b", background: "#fff", panel: "#f7f5f3", text: "#26241f", muted: "#6b6864", border: "#e4dfda" } }}
      transcription={false} attachmentsEnabled={false}/></div></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
