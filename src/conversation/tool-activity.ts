import type { ConversationState, ConversationToolCallRecord, ConversationTurnRecord } from "./state.js";
import { parseToolRecoverySummary, type ToolRecoverySummary } from "../tools/recovery.js";

export type ToolActivityStatus = "pending" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "incomplete";
export interface ToolActivityItem {
  readonly toolCallId: string;
  readonly name: string;
  readonly status: ToolActivityStatus;
  readonly recovery?: ToolRecoverySummary;
}
export interface ToolActivitySnapshot {
  readonly turnId: string | null;
  readonly total: number;
  readonly completed: number;
  readonly running: number;
  readonly pending: number;
  readonly awaitingApproval: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly incomplete: number;
  readonly recovered?: number;
  readonly failedAttempts?: number;
  readonly items: readonly ToolActivityItem[];
}

function statusFor(call: ConversationToolCallRecord, turn: ConversationTurnRecord | undefined): ToolActivityStatus {
  if (call.result) return call.result.is_error ? "failed" : "completed";
  if (turn?.status === "cancelled") return "cancelled";
  if (turn?.status === "failed" || turn?.status === "completed" && turn.outcome !== "tool_calls") return "incomplete";
  if (call.started_at) return "running";
  if (call.approval_required_at) return "awaiting_approval";
  return "pending";
}

/** Presentation-neutral counts for one request and its tool-continuation ancestors. No arguments or results are exposed. */
export function projectToolActivity(state: ConversationState, turnId?: string): ToolActivitySnapshot {
  const selected = turnId ?? state.active_turn_id ?? state.turns.at(-1)?.turn_id ?? state.tool_calls.at(-1)?.turn_id ?? null;
  const turns = new Map(state.turns.map((turn) => [String(turn.turn_id), turn]));
  const included = new Set<string>();
  let current: string | null = selected;
  while (current !== null && !included.has(current)) {
    included.add(current);
    current = turns.get(current)?.continuation_of_turn_id ?? null;
  }
  const lastTurn = selected === null ? undefined : turns.get(selected);
  const terminal = lastTurn?.status === "cancelled" || lastTurn?.status === "failed" ||
    lastTurn?.status === "completed" && lastTurn.outcome !== "tool_calls";
  const items = Object.freeze(state.tool_calls.filter((call) => included.has(call.turn_id)).map((call) => {
    const receipt = call.result?.content.flatMap((part) => {
      const value = part.type === "json" ? parseToolRecoverySummary(part.value) : null;
      return value ? [value] : [];
    })[0];
    // A successful later call with the same name alone never proves a previous failure recovered.
    const recovery = receipt && (receipt.status === "failed") === call.result?.is_error ? receipt : null;
    return Object.freeze({ toolCallId: String(call.tool_call_id), name: call.name ?? "Tool",
      status: statusFor(call, terminal ? lastTurn : turns.get(call.turn_id)), ...(recovery ? { recovery } : {}) });
  }));
  const recovered = items.filter((item) => item.recovery?.status === "recovered").length;
  const failedAttempts = items.reduce((total, item) => total + (item.recovery?.failedAttempts ?? 0), 0);
  const count = (status: ToolActivityStatus) => items.filter((item) => item.status === status).length;
  return Object.freeze({ turnId: selected, total: items.length, items,
    ...(recovered ? { recovered } : {}), ...(failedAttempts ? { failedAttempts } : {}),
    completed: count("completed"), running: count("running"), pending: count("pending"),
    awaitingApproval: count("awaiting_approval"), failed: count("failed"), cancelled: count("cancelled"), incomplete: count("incomplete") });
}
