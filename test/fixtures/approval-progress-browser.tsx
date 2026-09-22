import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialConversationState, parseConversationEvent, reduceConversationEvent,
  type ConversationState, type ConversationApprovalProposalRecord } from "../../src/index.js";
import { StyledChatPreset, StyledChatPresetStyles } from "../../src/react-styled/index.js";
import type { ComposerApprovalMode } from "../../src/composer-approval.js";

const stamp = "2026-09-22T12:00:00.000Z";
function snapshot(phase: string): ConversationState {
  const payloads: object[] = [
    { type: "message.created", message_id: "question", role: "user", content: [{ type: "text", text: "Update the network devices" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["question"] },
  ];
  for (let i = 0; i < 12; i++) payloads.push(
    { type: "tool_call.requested", turn_id: "turn", tool_call_id: `call-${i}`, name: "tech_network_import_ports", arguments: {} },
    { type: "tool_call.result_recorded", turn_id: "turn", tool_call_id: `call-${i}`, content: [{ type: "text", text: "Saved" }], is_error: false });
  payloads.push(phase === "complete" ? { type: "turn.completed", turn_id: "turn", output_message_ids: [], outcome: "stop" }
    : { type: "turn.status_changed", turn_id: "turn", status: phase === "working" ? "running" : "waiting_for_approval" });
  return payloads.reduce<ConversationState>((state, payload, index) => reduceConversationEvent(state, parseConversationEvent({
    version: 1, event_id: `event-${index}`, conversation_id: "preview", revision: index + 1, occurred_at: stamp,
    actor: { type: "system" }, source: { type: "runtime" }, payload,
  })), createInitialConversationState("preview" as never));
}
function proposal(index: number, status: ConversationApprovalProposalRecord["status"]) {
  return { proposal_id: `approval-${index}`, group_id: "preview", turn_id: "turn", tool_call_id: `call-${index}`,
    tool_name: index < 12 ? "tech_network_import_ports" : "tech_network_devices_update", proposal_version: 1, status,
    expires_at: null, created_at: stamp, updated_at: stamp,
    reviewed_arguments: { type: "redacted_json", value: { device: `Server ${index + 1}`, interface: "ens3f0np0" } },
  } as unknown as ConversationApprovalProposalRecord;
}
function App() {
  const [phase, setPhase] = useState("waiting");
  const [proposals, setProposals] = useState(() => Array.from({ length: 14 }, (_, i) => proposal(i, i < 12 ? "executed" : "pending")));
  const latest = useRef(proposals); latest.current = proposals;
  const [mode, setMode] = useState<ComposerApprovalMode>("required");
  const resources = useMemo(() => ({ listApprovalGroup: async () => latest.current,
    transitionApproval: async (input: { proposalId: string; status: string }) => {
      await new Promise(resolve => setTimeout(resolve, 200));
      const updated = latest.current.map(item => item.proposal_id === input.proposalId
        ? { ...item, status: input.status === "confirmed" ? "executed" as const : "rejected" as const, proposal_version: 2 } : item);
      setProposals(updated);
      return updated.find(item => item.proposal_id === input.proposalId)!;
    } }), []);
  return <><nav aria-label="Fixture controls">
    <button onClick={() => setPhase("working")}>Continue</button>
    <button onClick={() => { setProposals(items => [...items, proposal(14, "pending")]); setPhase("waiting"); }}>Next approval</button>
    <button onClick={() => setPhase("complete")}>Finish</button>
  </nav><div style={{ height: "calc(100% - 36px)" }}><StyledChatPresetStyles/>
    <StyledChatPreset state={snapshot(phase)} proposals={proposals} approvalResources={resources}
      approvalMode={mode} onApprovalModeChange={setMode} title="Cents · Network devices" transcription={false}
      theme={{ colors: { accent: "#a9502b", panel: "#f7f5f3", text: "#26241f", muted: "#6b6864", border: "#e4dfda" } }}/>
  </div></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
