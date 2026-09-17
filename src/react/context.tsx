import type { ConversationPresentationRuntime as ConversationRuntime } from "../conversation/presentation.js";
import {
  createContext,
  useEffect,
  useId,
  useMemo,
  type ReactNode,
} from "react";

import type { ConversationStore } from "../conversation/store.js";
import type { ConversationPresentationStore } from "../conversation/presentation.js";

/** The read capabilities required by React hooks and primitives. */
export type ConversationReadableStore = ConversationPresentationStore;

export type ConversationProviderFactory<TRequest = unknown> = () =>
  | ConversationReadableStore
  | ConversationRuntime<TRequest>;

interface ConversationBinding<TRequest = unknown> {
  readonly store: ConversationReadableStore;
  readonly runtime: ConversationRuntime<TRequest> | null;
}

interface ConversationProviderBaseProps {
  readonly children?: ReactNode;
}

export interface ConversationStoreProviderProps
  extends ConversationProviderBaseProps {
  /** Externally owned. The provider never destroys this store. */
  readonly store: ConversationReadableStore;
  readonly runtime?: never;
  readonly create?: never;
}

export interface ConversationRuntimeProviderProps<TRequest = unknown>
  extends ConversationProviderBaseProps {
  /** Externally owned. The provider never destroys this runtime. */
  readonly runtime: ConversationRuntime<TRequest>;
  readonly store?: never;
  readonly create?: never;
}

export interface ConversationStoreRuntimeProviderProps<TRequest = unknown>
  extends ConversationProviderBaseProps {
  /** Externally owned. All React reads and subscriptions use this store. */
  readonly store: ConversationReadableStore;
  /** Externally owned. Runtime actions delegate to this runtime. */
  readonly runtime: ConversationRuntime<TRequest>;
  readonly create?: never;
}

export interface ConversationFactoryProviderProps<TRequest = unknown>
  extends ConversationProviderBaseProps {
  /**
   * Creates a provider-owned store or runtime. The provider destroys mutable
   * stores and runtimes after their final unmount, including React StrictMode's
   * development remount cycle. Read-only stores have no lifecycle capability
   * for the provider to invoke.
   */
  readonly create: ConversationProviderFactory<TRequest>;
  readonly store?: never;
  readonly runtime?: never;
}

export type ConversationProviderProps<TRequest = unknown> =
  | ConversationStoreProviderProps
  | ConversationRuntimeProviderProps<TRequest>
  | ConversationStoreRuntimeProviderProps<TRequest>
  | ConversationFactoryProviderProps<TRequest>;

interface OwnedBindingEntry {
  readonly binding: ConversationBinding<unknown>;
  readonly instanceId: string;
  readonly factory: ConversationProviderFactory<unknown>;
  mounts: number;
  cleanupGeneration: number;
  destroyed: boolean;
}

// React deliberately calls render initializers twice in development StrictMode.
// useId is stable across those calls, so this render-lifetime registry prevents
// invoking an owning factory twice. It stores lifecycle metadata only; the
// ConversationStore remains the sole source of conversation state.
const ownedBindings = new WeakMap<
  ConversationProviderFactory<unknown>,
  Map<string, OwnedBindingEntry>
>();

export const ConversationContext = createContext<ConversationBinding<unknown> | null>(
  null,
);

ConversationContext.displayName = "ConversationContext";

/** Bind one headless conversation store/runtime to a React subtree. */
export function ConversationProvider<TRequest = unknown>(
  props: ConversationProviderProps<TRequest>,
) {
  const instanceId = useId();
  const hasExternalRuntime = "runtime" in props;
  const hasExternalStore = "store" in props;
  const hasFactory = "create" in props;
  const externalRuntime = hasExternalRuntime ? props.runtime : undefined;
  const externalStore = hasExternalStore ? props.store : undefined;
  const factory = hasFactory ? props.create : undefined;
  const hasValidFactorySource = hasFactory && !hasExternalRuntime &&
    !hasExternalStore && factory !== undefined;
  const hasValidExternalSource = !hasFactory &&
    (hasExternalRuntime || hasExternalStore) &&
    (!hasExternalRuntime || externalRuntime !== undefined) &&
    (!hasExternalStore || externalStore !== undefined);
  const ownedEntry = hasValidFactorySource
    ? getOwnedBinding(
        factory as ConversationProviderFactory<unknown>,
        instanceId,
      )
    : null;
  const externalBinding = useMemo<ConversationBinding<unknown> | null>(() => {
    if (!hasValidExternalSource) return null;
    if (externalStore !== undefined) {
      if (externalRuntime !== undefined) {
        assertMatchingConversation(externalStore, externalRuntime);
      }
      return Object.freeze({
        store: externalStore,
        runtime: externalRuntime as ConversationRuntime<unknown> | undefined ?? null,
      });
    }
    if (externalRuntime !== undefined) {
      return Object.freeze({
        store: externalRuntime.store,
        runtime: externalRuntime as ConversationRuntime<unknown>,
      });
    }
    return null;
  }, [externalRuntime, externalStore, hasValidExternalSource]);
  const binding = ownedEntry?.binding ?? externalBinding;

  if ((!hasValidFactorySource && !hasValidExternalSource) || binding === null) {
    throw new TypeError(
      "ConversationProvider requires `create` alone, `store` alone, `runtime` " +
        "alone, or an external `store` and `runtime` pair. Source props must " +
        "be defined, and `create` cannot be combined with `store` or `runtime`.",
    );
  }

  useEffect(() => {
    if (ownedEntry === null) return undefined;
    ownedEntry.mounts += 1;
    ownedEntry.cleanupGeneration += 1;

    return () => {
      ownedEntry.mounts -= 1;
      const cleanupGeneration = ++ownedEntry.cleanupGeneration;
      queueMicrotask(() => {
        if (
          ownedEntry.destroyed ||
          ownedEntry.mounts !== 0 ||
          ownedEntry.cleanupGeneration !== cleanupGeneration
        ) {
          return;
        }
        ownedEntry.destroyed = true;
        const entries = ownedBindings.get(ownedEntry.factory);
        entries?.delete(ownedEntry.instanceId);
        if (entries?.size === 0) ownedBindings.delete(ownedEntry.factory);
        destroyBinding(ownedEntry.binding);
      });
    };
  }, [ownedEntry]);

  return (
    <ConversationContext.Provider value={binding}>
      {props.children}
    </ConversationContext.Provider>
  );
}

function getOwnedBinding(
  factory: ConversationProviderFactory<unknown>,
  instanceId: string,
): OwnedBindingEntry {
  let entries = ownedBindings.get(factory);
  if (entries === undefined) {
    entries = new Map();
    ownedBindings.set(factory, entries);
  }
  const existing = entries.get(instanceId);
  if (existing !== undefined && !existing.destroyed) return existing;

  const binding = bindingFrom(factory());
  const entry: OwnedBindingEntry = {
    binding,
    instanceId,
    factory,
    mounts: 0,
    cleanupGeneration: 0,
    destroyed: false,
  };
  entries.set(instanceId, entry);
  return entry;
}

function bindingFrom(
  source: ConversationReadableStore | ConversationRuntime<unknown>,
): ConversationBinding<unknown> {
  if ("store" in source) {
    return Object.freeze({ store: source.store, runtime: source });
  }
  return Object.freeze({ store: source, runtime: null });
}

function assertMatchingConversation(
  store: ConversationReadableStore,
  runtime: ConversationRuntime<unknown>,
): void {
  const storeConversationId = store.getSnapshot().conversation_id;
  const runtimeConversationId = runtime.store.getSnapshot().conversation_id;
  if (storeConversationId === runtimeConversationId) return;

  throw new TypeError(
    "ConversationProvider `store` and `runtime` must belong to the same " +
      `conversation; store belongs to ${String(storeConversationId)} and ` +
      `runtime belongs to ${String(runtimeConversationId)}.`,
  );
}

function destroyBinding(binding: ConversationBinding<unknown>): void {
  if (binding.runtime !== null) {
    binding.runtime.destroy();
  } else if (hasDestroyCapability(binding.store)) {
    binding.store.destroy();
  }
}

function hasDestroyCapability(
  store: ConversationReadableStore,
): store is ConversationReadableStore & Pick<ConversationStore, "destroy"> {
  return "destroy" in store && typeof store.destroy === "function";
}
