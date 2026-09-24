/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTurnApprovalMode } from "../src/react/use-turn-approval-mode.js";
afterEach(cleanup);
it("updates the captured turn before the future-message preference and prevents overlapping toggles", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const target = { conversationId: "chat", turnId: "turn" };
  const change = vi.fn(async (input) => { if (input.mode) await gate; return { mode: "required" as const, revision: 2, active: true }; });
  const onChange = vi.fn();
  const hook = renderHook(() => useTurnApprovalMode({ scope: "chat", change, target: () => target, onChange }));
  act(() => { hook.result.current.onChange!("automatic"); hook.result.current.onChange!("required"); });
  await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
  expect(change.mock.calls[1]![0]).toMatchObject({ ...target, mode: "automatic", expectedRevision: 2 });
  expect(onChange).not.toHaveBeenCalled(); expect(hook.result.current.busy).toBe(true);
  release(); await waitFor(() => expect(onChange).toHaveBeenCalledWith("automatic"));
  expect(hook.result.current.busy).toBe(false);
});
it("keeps the preference unchanged on failure and isolates a response after switching accounts", async () => {
  const onChange = vi.fn(), change = vi.fn(async () => { throw new Error("offline"); });
  const hook = renderHook(() => useTurnApprovalMode({ scope: "account", change, target: () => ({ conversationId: "chat", turnId: "turn" }), onChange }));
  act(() => hook.result.current.onChange!("automatic"));
  await waitFor(() => expect(hook.result.current.error).not.toBe(""));
  expect(onChange).not.toHaveBeenCalled();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = vi.fn(async () => { await gate; return { mode: "required" as const, revision: 0, active: true }; });
  const other = renderHook(({ scope }) => useTurnApprovalMode({ scope, change: pending,
    target: () => ({ conversationId: "chat", turnId: "turn" }), onChange }), { initialProps: { scope: "one" } });
  act(() => other.result.current.onChange!("automatic"));
  other.rerender({ scope: "two" }); release();
  await act(async () => { await gate; });
  expect(onChange).not.toHaveBeenCalled();
  expect(pending).toHaveBeenCalledTimes(1);
});
