import { waitForApplicationApproval, type ApplicationApprovalWaitOptions } from "./application-approval-wait.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import type { ResponseToolCallEvent } from "../protocol.js";
import type { ApplicationToolActivityUpdate } from "../tools/executor.js";
import { recordToolLifecycle } from "./tool-lifecycle.js";
import { parseToolRecoverySummary, type ToolRecoverySummary } from "../tools/recovery.js";

export interface HandrailAssistantToolObserver {
  /** Observe a host-owned approval inside an active tool without executing it again. */
  waitForApproval<T>(input: ApplicationApprovalWaitOptions<T> & {
    readonly conversationId: string;
    readonly turnId: string;
  }): Promise<T>;
  /**
   * Migration seam for a host-owned, authorized and idempotent tool executor.
   * Records execution evidence, without changing domain approval or retry policy.
   * Reusing this observer does not deduplicate side effects: the executor must
   * retain its stable call identity in its own execution ledger.
   */
  observe<T>(input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">;
    readonly signal: AbortSignal;
    readonly activity?: ApplicationToolActivityUpdate;
  }, execute: (report: (update: ApplicationToolActivityUpdate) => Promise<void>) => Promise<{
    readonly value: T;
    readonly isError?: boolean;
    readonly recovery?: ToolRecoverySummary;
  }>): Promise<T>;
}

export function createToolActivityObserver(input: {
  readonly events: ConversationEventStore;
  readonly report: (conversationId: string, turnId: string, update: ApplicationToolActivityUpdate) => Promise<void>;
}): HandrailAssistantToolObserver {
  return Object.freeze({
    async waitForApproval<T>(options: ApplicationApprovalWaitOptions<T> & {
      readonly conversationId: string; readonly turnId: string;
    }): Promise<T> {
      let announced = false;
      return waitForApplicationApproval({ ...options, read: async (signal) => {
        if (!announced) {
          await input.report(options.conversationId, options.turnId, { summary: "Waiting for approval to continue" });
          announced = true;
        }
        signal.throwIfAborted();
        const result = await options.read(signal);
        signal.throwIfAborted();
        if (result.status === "settled") {
          await input.report(options.conversationId, options.turnId, { summary: "Approval action settled; continuing" });
        }
        return result;
      } });
    },
    async observe<T>(location: Parameters<HandrailAssistantToolObserver["observe"]>[0], execute: (
      report: (update: ApplicationToolActivityUpdate) => Promise<void>,
    ) => Promise<{ readonly value: T; readonly isError?: boolean; readonly recovery?: ToolRecoverySummary }>): Promise<T> {
      location.signal.throwIfAborted();
      const { conversationId, turnId, call } = location;
      const identity = { turn_id: turnId as never, tool_call_id: call.tool_call_id as never };
      await recordToolLifecycle(input.events, conversationId,
        { ...identity, type: "tool_call.requested", name: call.name, arguments: call.arguments });
      await recordToolLifecycle(input.events, conversationId, { ...identity, type: "tool_call.discovered" });
      location.signal.throwIfAborted();
      await recordToolLifecycle(input.events, conversationId, { ...identity, type: "tool_call.started" });
      const report = (update: ApplicationToolActivityUpdate) => input.report(conversationId, turnId, update);
      await report(location.activity ?? { summary: `Running ${call.name.replace(/[._-]+/gu, " ")}` });
      let result: { readonly value: T; readonly isError?: boolean; readonly recovery?: ToolRecoverySummary };
      try {
        location.signal.throwIfAborted();
        result = await execute(report);
      } catch (cause) {
        if (!location.signal.aborted) await recordToolLifecycle(input.events, conversationId, {
          ...identity, type: "tool_call.result_recorded",
          content: [{ type: "text", text: "Tool execution failed." }], is_error: true });
        throw cause;
      }
      const recovery = parseToolRecoverySummary(result.recovery);
      await recordToolLifecycle(input.events, conversationId, { ...identity, type: "tool_call.result_recorded",
        content: [{ type: "text", text: result.isError ? "Tool execution failed." : "Tool execution completed." },
          ...(recovery ? [{ type: "json" as const, value: { ...recovery } }] : [])],
        is_error: result.isError ?? false });
      await report({ summary: result.isError ? "Continuing after a tool error" : "Preparing the next step" });
      return result.value;
    },
  });
}
