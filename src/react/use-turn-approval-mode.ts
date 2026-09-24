import { useEffect, useRef, useState } from "react";
import type { ComposerApprovalMode, TurnApprovalModeInput, TurnApprovalModeResult } from "../composer-approval.js";

/** Update the captured request before changing the next-message preference. */
export function useTurnApprovalMode(options: {
  readonly scope: unknown;
  readonly change?: (input: TurnApprovalModeInput) => Promise<TurnApprovalModeResult>;
  readonly target: () => { conversationId: string; turnId: string } | null;
  readonly onChange?: (mode: ComposerApprovalMode) => void;
}) {
  const current = useRef(options); current.current = options;
  const operation = useRef<object | null>(null);
  const [state, setState] = useState({ scope: options.scope, busy: false, error: "" });
  useEffect(() => () => { operation.current = null; }, []);
  const busy = state.scope === options.scope && state.busy;
  const error = state.scope === options.scope ? state.error : "";
  const onChange = options.onChange ? (mode: ComposerApprovalMode) => {
    if (operation.current) return;
    const captured = options, token = {}; operation.current = token;
    setState({ scope: captured.scope, busy: true, error: "" });
    void (async () => {
      try {
        const target = captured.change ? captured.target() : null;
        if (target && captured.change) {
          const saved = await captured.change(target);
          if (operation.current !== token || current.current.scope !== captured.scope || current.current.change !== captured.change) return;
          if (saved.active) await captured.change({ ...target, mode, expectedRevision: saved.revision,
            mutationId: `approval-mode-${crypto.randomUUID()}` });
        }
        if (operation.current === token && current.current.scope === captured.scope && current.current.change === captured.change)
          captured.onChange?.(mode);
      } catch {
        if (operation.current === token && current.current.scope === captured.scope)
          setState({ scope: captured.scope, busy: false, error: "Approval setting could not be updated. Try again." });
        return;
      } finally {
        if (operation.current === token) operation.current = null;
      }
      if (current.current.scope === captured.scope) setState({ scope: captured.scope, busy: false, error: "" });
    })();
  } : undefined;
  return { onChange, busy, error };
}
