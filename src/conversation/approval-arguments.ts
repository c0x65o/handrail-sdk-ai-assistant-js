import { sha256Text } from "../provider-context.js";
import type { JsonObject, JsonValue } from "../protocol.js";
import type { ConversationApprovalProposalRecord, ConversationState } from "./state.js";

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

/** Stable argument binding shared by server authorization and browser review. */
export function assistantToolArgumentReference(arguments_: JsonObject): string {
  return `args-sha256-${sha256Text(canonicalJson(arguments_))}`;
}

/** Return authorized review data only when it matches this proposal's immutable binding. */
export function reviewedToolArguments(state: ConversationState, proposal: ConversationApprovalProposalRecord): JsonObject | null {
  if (proposal.reviewed_arguments.type === "redacted_json") return proposal.reviewed_arguments.value as JsonObject;
  const call = state.tool_calls.find(candidate => candidate.turn_id === proposal.turn_id &&
    candidate.tool_call_id === proposal.tool_call_id && candidate.name === proposal.tool_name);
  if (!call?.arguments) return null;
  const arguments_ = call.arguments as JsonObject;
  return proposal.reviewed_arguments.argument_ref === assistantToolArgumentReference(arguments_) ? arguments_ : null;
}
