import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import type { ConversationEvent, ConversationTurnId } from "../conversation/events.js";
import type { ConversationState } from "../conversation/state.js";
import type { ConversationPresentationState, ConversationPresentationSelector as ConversationStoreSelector,
  ConversationPresentationRuntime as ConversationRuntime, ConversationPresentationTurnResult as ConversationRuntimeTurnResult } from "../conversation/presentation.js";
import type {
  ConversationStore,
  ConversationStoreEquality,
} from "../conversation/store.js";
import type {
  ConversationRuntimeSendMessageInput,
} from "../runtime.js";
import {
  ConversationContext,
  type ConversationReadableStore,
} from "./context.js";

export interface ConversationActions<TRequest = unknown> {
  applyEvent(event: ConversationEvent): Promise<ConversationState>;
  applyEvents(events: readonly ConversationEvent[]): Promise<ConversationState>;
  sendMessage(
    input: ConversationRuntimeSendMessageInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult>;
  resumeTurn(turnId: ConversationTurnId): Promise<ConversationRuntimeTurnResult>;
  restoreActiveTurn(): Promise<ConversationRuntimeTurnResult | null>;
  readonly cancelTurn: ConversationRuntime<TRequest>["cancelTurn"];
}

type ConversationMutableStore = ConversationReadableStore & Pick<
  ConversationStore,
  "applyEvent" | "applyEvents"
>;

/** Return the store supplied by the nearest ConversationProvider. */
export function useConversationStore(): ConversationReadableStore {
  return useConversationBinding("useConversationStore").store;
}

/** Subscribe to immutable presentation state. `partial` marks a loaded window. */
export function useConversationSnapshot(): ConversationPresentationState {
  const store = useConversationStore();
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(notify),
    [store],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}

/** Subscribe only to the selected portion of the conversation snapshot. */
export function useConversationSelector<Selected>(
  selector: ConversationStoreSelector<Selected>,
  isEqual: ConversationStoreEquality<Selected> = Object.is,
): Selected {
  const store = useConversationStore();
  const cache = useRef<{
    readonly snapshot: ConversationPresentationState;
    readonly selector: ConversationStoreSelector<Selected>;
    readonly selection: Selected;
  } | null>(null);

  const getSelectedSnapshot = useCallback((): Selected => {
    const snapshot = store.getSnapshot();
    const previous = cache.current;
    if (previous !== null && previous.snapshot === snapshot && previous.selector === selector) {
      return previous.selection;
    }

    const selection = selector(snapshot);
    const stableSelection = previous !== null && isEqual(previous.selection, selection)
      ? previous.selection
      : selection;
    cache.current = { snapshot, selector, selection: stableSelection };
    return stableSelection;
  }, [isEqual, selector, store]);
  const subscribe = useCallback(
    (notify: () => void) => store.select(selector, () => notify(), isEqual),
    [isEqual, selector, store],
  );

  return useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}

/**
 * Return stable action callbacks for the nearest provider. Actions throw an
 * actionable error when the provider source lacks the required capability.
 */
export function useConversationActions<TRequest = unknown>(): ConversationActions<TRequest> {
  const binding = useConversationBinding("useConversationActions");
  return useMemo(() => {
    const runtime = binding.runtime as ConversationRuntime<TRequest> | null;
    const requireMutableStore = (): ConversationMutableStore => {
      if (hasMutationCapabilities(binding.store)) return binding.store;
      throw new Error(
        "@handrail/ai-assistant/react: useConversationActions applyEvent/applyEvents " +
          "require <ConversationProvider store={store}> with a mutable " +
          "ConversationStore, a runtime, or an owned factory returning either.",
      );
    };
    const requireRuntime = (): ConversationRuntime<TRequest> => {
      if (runtime !== null) return runtime;
      throw new Error(
        "@handrail/ai-assistant/react: useConversationActions runtime actions require " +
          "<ConversationProvider runtime={runtime}> or an owned runtime factory.",
      );
    };

    return Object.freeze({
      applyEvent: (event: ConversationEvent) => requireMutableStore().applyEvent(event),
      applyEvents: (events: readonly ConversationEvent[]) =>
        requireMutableStore().applyEvents(events),
      sendMessage: (input: ConversationRuntimeSendMessageInput<TRequest>) =>
        requireRuntime().sendMessage(input),
      resumeTurn: (turnId: ConversationTurnId) =>
        requireRuntime().resumeTurn(turnId),
      restoreActiveTurn: () => requireRuntime().restoreActiveTurn(),
      cancelTurn: (turnId: ConversationTurnId, reason: Parameters<ConversationRuntime<TRequest>["cancelTurn"]>[1]) =>
        requireRuntime().cancelTurn(turnId, reason),
    });
  }, [binding]);
}

function hasMutationCapabilities(
  store: ConversationReadableStore,
): store is ConversationMutableStore {
  return "applyEvent" in store && typeof store.applyEvent === "function" &&
    "applyEvents" in store && typeof store.applyEvents === "function";
}

function useConversationBinding(hookName: string) {
  const binding = useContext(ConversationContext);
  if (binding === null) {
    throw new Error(
      `@handrail/ai-assistant/react: ${hookName} must be used within a ` +
        "<ConversationProvider>. Pass a store, runtime, or owned create factory.",
    );
  }
  return binding;
}
