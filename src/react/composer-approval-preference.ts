import { useCallback, useState } from "react";
import { withComposerApprovalMode, type ComposerApprovalMode } from "../composer-approval.js";
import type { ChatRequest } from "../protocol.js";

/** Ephemeral account/conversation preference; never stored as an authorization grant. */
export function useComposerApprovalPreference(scope: unknown, options: {
  readonly approvalMode?: ComposerApprovalMode;
  readonly defaultApprovalMode?: ComposerApprovalMode;
  readonly onApprovalModeChange?: (mode: ComposerApprovalMode) => void;
} = {}) {
  const [saved, setSaved] = useState({ scope, mode: options.defaultApprovalMode ?? "required" });
  const approvalMode = options.approvalMode ?? (saved.scope === scope ? saved.mode : options.defaultApprovalMode ?? "required");
  const onApprovalModeChange = options.approvalMode === undefined ? (mode: ComposerApprovalMode) => {
    setSaved({ scope, mode }); options.onApprovalModeChange?.(mode);
  } : options.onApprovalModeChange;
  const decorateRequest = useCallback((request: ChatRequest) => withComposerApprovalMode(request, approvalMode), [approvalMode]);
  return { approvalMode, onApprovalModeChange, decorateRequest };
}
