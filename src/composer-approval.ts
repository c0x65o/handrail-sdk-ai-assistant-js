import type { ChatRequest } from "./protocol.js";

export type ComposerApprovalMode = "required" | "automatic";

/** A user preference, never an authorization grant. Hosts still enforce actor permissions. */
export function withComposerApprovalMode(request: ChatRequest, mode: ComposerApprovalMode): ChatRequest {
  if (mode !== "required" && mode !== "automatic") throw new TypeError("Invalid composer approval mode");
  return { ...request, metadata: { ...request.metadata, handrail_approval_mode: mode } };
}

/** Read from the retained user request, before provider execution. Invalid values fail closed. */
export function composerApprovalModeFromRequest(request: Pick<ChatRequest, "metadata">): ComposerApprovalMode | undefined {
  const mode = request.metadata?.handrail_approval_mode;
  if (mode === undefined) return undefined;
  if (mode !== "required" && mode !== "automatic") throw new TypeError("Invalid composer approval mode");
  return mode;
}
