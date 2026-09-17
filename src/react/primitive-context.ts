import type { ConversationPresentationState as ConversationState } from "../conversation/presentation.js";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

import type { } from "../conversation/state.js";
import type {
  PresenceController,
  PresenceControllerSnapshot,
} from "../presence/controller.js";
import { ConversationContext } from "./context.js";
import type { ConversationComposerResult } from "./use-conversation-composer.js";

export interface PrimitiveContextValue {
  readonly composer: ConversationComposerResult | null;
  readonly presence: PresenceController | null;
  readonly presenceSnapshot: PresenceControllerSnapshot | null;
  readonly state: ConversationState | undefined;
}

export const PrimitiveContext = createContext<PrimitiveContextValue | null>(null);

const subscribeToNothing = () => () => undefined;
const getNoState = () => undefined;

/** Resolve explicit, ChatRoot, or ConversationProvider state in that order. */
export function useResolvedState(
  explicit?: ConversationState,
): ConversationState | undefined {
  const primitives = useContext(PrimitiveContext);
  const binding = useContext(ConversationContext);
  const subscribe = useCallback(
    (listener: () => void) => binding?.store.subscribe(listener) ?? (() => undefined),
    [binding],
  );
  const getSnapshot = useCallback(
    () => binding?.store.getSnapshot(),
    [binding],
  );
  const providerState = useSyncExternalStore(
    binding === null ? subscribeToNothing : subscribe,
    binding === null ? getNoState : getSnapshot,
    binding === null ? getNoState : getSnapshot,
  );
  return explicit ?? primitives?.state ?? providerState;
}
