import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type FormHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LiHTMLAttributes,
  type ReactNode,
} from "react";

import {
  ConversationCatalogError,
  ConversationLocalErasureError,
  DEFAULT_CONVERSATION_CATALOG_ORDER,
  type ArchiveConversationResult,
  type ClearConversationResult,
  type ConversationCatalog,
  type ConversationCatalogAuthorizationAction,
  type ConversationCatalogCursor,
  type ConversationCatalogDescriptor,
  type ConversationCatalogIdempotencyKey,
  type ConversationCatalogLifecycleFilter,
  type ConversationCatalogMetadata,
  type ConversationCatalogOrder,
  type ConversationCatalogCapabilities,
  type ConversationCatalogVersion,
  type CreateConversationResult,
  type PermanentlyDeleteConversationResult,
  type RenameConversationResult,
  type RestoreConversationResult,
} from "../conversation/catalog.js";
import { ConversationRuntimeRegistryError } from "../conversation/runtime-registry.js";
import type { ConversationId } from "../conversation/events.js";
import type { PrimitiveRender } from "./primitives.js";

export type ConversationPickerOperation =
  | "create"
  | "open"
  | "rename"
  | "clear"
  | "archive"
  | "restore"
  | "permanent_delete";

export type ConversationPickerErrorCode =
  | "local_cleanup_failed"
  | "invalid_input"
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "forbidden"
  | "unsupported"
  | "unavailable"
  | "confirmation_required"
  | "runtime_unavailable"
  | "unknown";

/** Bounded public failure state. It intentionally has no cause or host details. */
export interface ConversationPickerError {
  readonly code: ConversationPickerErrorCode;
  readonly operation: ConversationCatalogAuthorizationAction | "open";
  readonly message: string;
  readonly retryable: boolean;
  /** Only retries device cleanup after a confirmed remote deletion. */
  readonly retryCleanup?: () => Promise<void>;
}

export interface ConversationPickerOperationState {
  readonly operation: ConversationPickerOperation;
  readonly conversationId: ConversationId | null;
}

export interface ConversationPickerIdempotencyRequest {
  readonly operation: Exclude<ConversationPickerOperation, "open">;
  readonly conversationId?: ConversationId;
}

export type ConversationPickerIdempotencyKeyFactory = (
  request: ConversationPickerIdempotencyRequest,
) => ConversationCatalogIdempotencyKey;

export interface ConversationPickerConfirmationRequest {
  readonly operation: "clear" | "archive" | "permanent_delete";
  readonly descriptor: ConversationCatalogDescriptor;
}

export type ConversationPickerConfirmation = (
  request: ConversationPickerConfirmationRequest,
) => boolean | Promise<boolean>;

export interface ConversationPickerOpenInput<TAuthorizationContext, TRuntime> {
  readonly authorizationContext: TAuthorizationContext;
  readonly descriptor: ConversationCatalogDescriptor;
  readonly runtime: TRuntime | undefined;
  readonly signal: AbortSignal;
}

export type ConversationPickerOpenHandler<TAuthorizationContext, TRuntime> = (
  input: ConversationPickerOpenInput<TAuthorizationContext, TRuntime>,
) => void | (() => void) | Promise<void | (() => void)>;

/** Structural subset accepted from ConversationRuntimeRegistry without owning one. */
export interface ConversationPickerRuntimeRegistry<TAuthorizationContext, TRuntime = unknown> {
  open(input: {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
  }): Promise<TRuntime>;
  release(conversationId: ConversationId): Promise<boolean>;
  clear(input: {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
    readonly expectedVersion: ConversationCatalogVersion;
    readonly idempotencyKey: ConversationCatalogIdempotencyKey;
  }): Promise<ClearConversationResult>;
  archive(input: {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
    readonly expectedVersion: ConversationCatalogVersion;
    readonly idempotencyKey: ConversationCatalogIdempotencyKey;
  }): Promise<ArchiveConversationResult>;
  restore(input: {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
    readonly expectedVersion: ConversationCatalogVersion;
    readonly idempotencyKey: ConversationCatalogIdempotencyKey;
  }): Promise<RestoreConversationResult>;
  permanentlyDelete(input: {
    readonly authorizationContext: TAuthorizationContext;
    readonly conversationId: ConversationId;
    readonly expectedVersion: ConversationCatalogVersion;
    readonly idempotencyKey: ConversationCatalogIdempotencyKey;
  }): Promise<PermanentlyDeleteConversationResult>;
}

export interface UseConversationPickerOptions<TAuthorizationContext, TRuntime = unknown> {
  readonly authorizationContext: TAuthorizationContext;
  readonly catalog: ConversationCatalog<TAuthorizationContext>;
  readonly confirm?: ConversationPickerConfirmation;
  readonly idempotencyKeyFactory?: ConversationPickerIdempotencyKeyFactory;
  readonly initialSelectedConversationId?: ConversationId | null;
  readonly lifecycle?: ConversationCatalogLifecycleFilter;
  readonly onOpen?: ConversationPickerOpenHandler<TAuthorizationContext, TRuntime>;
  readonly onSelectionChange?: (
    conversationId: ConversationId | null,
    descriptor: ConversationCatalogDescriptor | null,
  ) => void;
  readonly order?: ConversationCatalogOrder;
  readonly pageSize?: number;
  readonly runtimeRegistry?: ConversationPickerRuntimeRegistry<TAuthorizationContext, TRuntime>;
}

export interface ConversationPickerCreateInput {
  readonly conversationId?: ConversationId;
  readonly title?: string;
  readonly metadata?: ConversationCatalogMetadata;
  readonly idempotencyKey?: ConversationCatalogIdempotencyKey;
}

export interface ConversationPickerRenameInput {
  readonly descriptor: ConversationCatalogDescriptor;
  readonly title: string;
  readonly idempotencyKey?: ConversationCatalogIdempotencyKey;
}

export interface ConversationPickerMutationInput {
  readonly descriptor: ConversationCatalogDescriptor;
  readonly idempotencyKey?: ConversationCatalogIdempotencyKey;
}

export interface ConversationPickerController {
  readonly items: readonly ConversationCatalogDescriptor[];
  readonly selectedConversationId: ConversationId | null;
  readonly selectedConversation: ConversationCatalogDescriptor | null;
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isLoadingMore: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: ConversationCatalogCursor | null;
  readonly error: ConversationPickerError | null;
  readonly operation: ConversationPickerOperationState | null;
  readonly capabilities: ConversationCatalogCapabilities;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  openConversation(descriptor: ConversationCatalogDescriptor): Promise<void>;
  createConversation(input: ConversationPickerCreateInput): Promise<void>;
  renameConversation(input: ConversationPickerRenameInput): Promise<void>;
  clearConversation(input: ConversationPickerMutationInput): Promise<void>;
  archiveConversation(input: ConversationPickerMutationInput): Promise<void>;
  restoreConversation(input: ConversationPickerMutationInput): Promise<void>;
  permanentlyDeleteConversation(input: ConversationPickerMutationInput): Promise<void>;
  clearError(): void;
}

const GENERIC_ERROR = "The conversation operation could not be completed.";
const CONFIRMATION_ERROR = "This conversation operation requires host confirmation.";

function safeError(
  error: unknown,
  operation: ConversationCatalogAuthorizationAction | "open",
): ConversationPickerError {
  if (error instanceof ConversationLocalErasureError) {
    return Object.freeze({ code: "local_cleanup_failed", operation, message: error.message, retryable: true, retryCleanup: error.retry });
  }
  if (error instanceof ConversationCatalogError) {
    return Object.freeze({
      code: error.code,
      operation,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof ConversationRuntimeRegistryError) {
    return Object.freeze({
      code: error.retryable ? "runtime_unavailable" :
        error.code === "policy_denied" ? "forbidden" : "runtime_unavailable",
      operation,
      message: error.message,
      retryable: error.retryable,
    });
  }
  return Object.freeze({
    code: "unknown",
    operation,
    message: GENERIC_ERROR,
    retryable: false,
  });
}

function confirmationError(
  operation: "clear" | "archive" | "permanent_delete",
): ConversationPickerError {
  return Object.freeze({
    code: "confirmation_required",
    operation,
    message: CONFIRMATION_ERROR,
    retryable: false,
  });
}

function uniqueRows(
  current: readonly ConversationCatalogDescriptor[],
  incoming: readonly ConversationCatalogDescriptor[],
  append: boolean,
): readonly ConversationCatalogDescriptor[] {
  const rows: ConversationCatalogDescriptor[] = append ? [...current] : [];
  const ids = new Set(rows.map((row) => row.conversationId));
  for (const row of incoming) {
    if (!ids.has(row.conversationId)) {
      ids.add(row.conversationId);
      rows.push(row);
    }
  }
  return Object.freeze(rows);
}

function lifecycleMatches(
  descriptor: ConversationCatalogDescriptor,
  lifecycle: ConversationCatalogLifecycleFilter,
): boolean {
  return lifecycle === "all" || descriptor.lifecycle === lifecycle;
}

interface OwnedOpen<TRuntime> {
  readonly conversationId: ConversationId;
  readonly controller: AbortController;
  readonly registry: ConversationPickerRuntimeRegistry<unknown, TRuntime> | undefined;
  cleanup: (() => void) | undefined;
}

/** Headless catalog, selection, lifecycle, and host-open controller. */
export function useConversationPicker<TAuthorizationContext, TRuntime = unknown>(
  options: UseConversationPickerOptions<TAuthorizationContext, TRuntime>,
): ConversationPickerController {
  const {
    authorizationContext,
    catalog,
    confirm,
    idempotencyKeyFactory,
    initialSelectedConversationId = null,
    lifecycle = "active",
    onOpen,
    onSelectionChange,
    order: inputOrder = DEFAULT_CONVERSATION_CATALOG_ORDER,
    pageSize = 50,
    runtimeRegistry,
  } = options;
  const [items, setItems] = useState<readonly ConversationCatalogDescriptor[]>([]);
  const [selectedConversationId, setSelectedConversationId] =
    useState<ConversationId | null>(initialSelectedConversationId);
  const [isInitialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<ConversationCatalogCursor | null>(null);
  const [error, setError] = useState<ConversationPickerError | null>(null);
  const [operation, setOperation] = useState<ConversationPickerOperationState | null>(null);
  const generation = useRef(0);
  const listRequest = useRef(0);
  const mutationRequest = useRef(0);
  const itemsRef = useRef(items);
  const selectedIdRef = useRef(selectedConversationId);
  const ownedOpen = useRef<OwnedOpen<TRuntime> | null>(null);
  const order = useMemo<ConversationCatalogOrder>(() => Object.freeze({
    field: inputOrder.field,
    direction: inputOrder.direction,
  }), [inputOrder.direction, inputOrder.field]);
  itemsRef.current = items;
  selectedIdRef.current = selectedConversationId;

  const publishSelection = useCallback((
    conversationId: ConversationId | null,
    descriptor: ConversationCatalogDescriptor | null,
  ) => {
    selectedIdRef.current = conversationId;
    setSelectedConversationId(conversationId);
    onSelectionChange?.(conversationId, descriptor);
  }, [onSelectionChange]);

  const cancelOwnedOpen = useCallback((except?: ConversationId) => {
    const owned = ownedOpen.current;
    if (owned === null || owned.conversationId === except) return;
    ownedOpen.current = null;
    owned.controller.abort();
    owned.cleanup?.();
    if (owned.registry !== undefined) {
      void owned.registry.release(owned.conversationId).catch(() => undefined);
    }
  }, []);

  const cancelOwnedOpenFor = useCallback((conversationId: ConversationId) => {
    if (ownedOpen.current?.conversationId === conversationId) cancelOwnedOpen();
  }, [cancelOwnedOpen]);

  const resolveKey = useCallback((
    operationName: Exclude<ConversationPickerOperation, "open">,
    conversationId: ConversationId | undefined,
    explicit: ConversationCatalogIdempotencyKey | undefined,
  ): ConversationCatalogIdempotencyKey => {
    if (explicit !== undefined) return explicit;
    if (idempotencyKeyFactory === undefined) throw new TypeError("idempotency key required");
    return idempotencyKeyFactory(Object.freeze({
      operation: operationName,
      ...(conversationId === undefined ? {} : { conversationId }),
    }));
  }, [idempotencyKeyFactory]);

  const applyListResult = useCallback((
    incoming: readonly ConversationCatalogDescriptor[],
    append: boolean,
    resultHasMore: boolean,
    cursor: ConversationCatalogCursor | null,
  ) => {
    const rows = uniqueRows(itemsRef.current, incoming, append);
    itemsRef.current = rows;
    setItems(rows);
    setHasMore(resultHasMore);
    setNextCursor(cursor);
    const selectedId = selectedIdRef.current;
    if (selectedId !== null && !resultHasMore &&
      !rows.some((row) => row.conversationId === selectedId)) {
      cancelOwnedOpen();
      publishSelection(null, null);
    }
  }, [cancelOwnedOpen, publishSelection]);

  const requestPage = useCallback(async (
    append: boolean,
    cursor: ConversationCatalogCursor | undefined,
    requestGeneration = generation.current,
    initial = false,
  ): Promise<void> => {
    const request = ++listRequest.current;
    if (append) setLoadingMore(true);
    else if (initial) setInitialLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const result = await catalog.list({
        authorizationContext,
        lifecycle,
        pageSize,
        order,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (generation.current !== requestGeneration || listRequest.current !== request) return;
      applyListResult(result.items, append, result.hasMore, result.nextCursor);
    } catch (caught) {
      if (generation.current !== requestGeneration || listRequest.current !== request) return;
      setError(safeError(caught, "list"));
    } finally {
      if (generation.current === requestGeneration && listRequest.current === request) {
        setInitialLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [applyListResult, authorizationContext, catalog, lifecycle, order, pageSize]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    listRequest.current += 1;
    mutationRequest.current += 1;
    cancelOwnedOpen();
    itemsRef.current = [];
    setItems([]);
    setHasMore(false);
    setNextCursor(null);
    setError(null);
    setInitialLoading(true);
    setRefreshing(false);
    setLoadingMore(false);
    setOperation(null);
    void requestPage(false, undefined, requestGeneration, true);
    return () => {
      generation.current += 1;
      listRequest.current += 1;
      mutationRequest.current += 1;
      cancelOwnedOpen();
    };
  }, [
    authorizationContext,
    cancelOwnedOpen,
    catalog,
    lifecycle,
    order.direction,
    order.field,
    pageSize,
    requestPage,
  ]);

  const refresh = useCallback(async () => {
    await requestPage(false, undefined);
  }, [requestPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore || nextCursor === null || isLoadingMore) return;
    await requestPage(true, nextCursor);
  }, [hasMore, isLoadingMore, nextCursor, requestPage]);

  const openConversation = useCallback(async (
    descriptor: ConversationCatalogDescriptor,
  ) => {
    if (ownedOpen.current?.conversationId === descriptor.conversationId &&
      !ownedOpen.current.controller.signal.aborted) {
      publishSelection(descriptor.conversationId, descriptor);
      return;
    }
    const requestGeneration = generation.current;
    const request = ++mutationRequest.current;
    cancelOwnedOpen(descriptor.conversationId);
    publishSelection(descriptor.conversationId, descriptor);
    setError(null);
    setOperation({ operation: "open", conversationId: descriptor.conversationId });
    const controller = new AbortController();
    const owned: OwnedOpen<TRuntime> = {
      conversationId: descriptor.conversationId,
      controller,
      registry: runtimeRegistry as
        ConversationPickerRuntimeRegistry<unknown, TRuntime> | undefined,
      cleanup: undefined,
    };
    ownedOpen.current = owned;
    try {
      const runtime = runtimeRegistry === undefined
        ? undefined
        : await runtimeRegistry.open({ authorizationContext, conversationId: descriptor.conversationId });
      if (generation.current !== requestGeneration || mutationRequest.current !== request ||
        ownedOpen.current !== owned || controller.signal.aborted) {
        if (runtimeRegistry !== undefined) {
          await runtimeRegistry.release(descriptor.conversationId).catch(() => undefined);
        }
        return;
      }
      const cleanup = await onOpen?.(Object.freeze({
        authorizationContext,
        descriptor,
        runtime,
        signal: controller.signal,
      }));
      if (typeof cleanup === "function") owned.cleanup = cleanup;
      if (generation.current !== requestGeneration || mutationRequest.current !== request ||
        ownedOpen.current !== owned || controller.signal.aborted) {
        cleanup?.();
        if (runtimeRegistry !== undefined) {
          await runtimeRegistry.release(descriptor.conversationId).catch(() => undefined);
        }
        return;
      }
      setOperation(null);
    } catch (caught) {
      if (generation.current !== requestGeneration || mutationRequest.current !== request ||
        ownedOpen.current !== owned) return;
      ownedOpen.current = null;
      controller.abort();
      owned.cleanup?.();
      if (runtimeRegistry !== undefined) {
        await runtimeRegistry.release(descriptor.conversationId).catch(() => undefined);
      }
      setOperation(null);
      setError(safeError(caught, "open"));
    }
  }, [authorizationContext, cancelOwnedOpen, onOpen, publishSelection, runtimeRegistry]);

  const replaceDescriptor = useCallback((descriptor: ConversationCatalogDescriptor) => {
    const current = itemsRef.current;
    let found = false;
    const next = current.flatMap((row) => {
      if (row.conversationId !== descriptor.conversationId) return [row];
      found = true;
      return lifecycleMatches(descriptor, lifecycle) ? [descriptor] : [];
    });
    if (!found && lifecycleMatches(descriptor, lifecycle)) next.unshift(descriptor);
    const frozen = Object.freeze(next);
    itemsRef.current = frozen;
    setItems(frozen);
    if (selectedIdRef.current === descriptor.conversationId) {
      if (lifecycleMatches(descriptor, lifecycle)) publishSelection(descriptor.conversationId, descriptor);
      else {
        cancelOwnedOpen();
        publishSelection(null, null);
      }
    }
  }, [cancelOwnedOpen, lifecycle, publishSelection]);

  const runMutation = useCallback(async <TResult,>(
    operationName: Exclude<ConversationPickerOperation, "open">,
    conversationId: ConversationId | null,
    execute: () => Promise<TResult>,
    apply: (result: TResult) => void,
    existingRequest?: { readonly generation: number; readonly request: number },
  ): Promise<void> => {
    const requestGeneration = existingRequest?.generation ?? generation.current;
    const request = existingRequest?.request ?? ++mutationRequest.current;
    setError(null);
    setOperation({ operation: operationName, conversationId });
    try {
      const result = await execute();
      if (generation.current !== requestGeneration || mutationRequest.current !== request) return;
      apply(result);
      setOperation(null);
    } catch (caught) {
      if (generation.current !== requestGeneration || mutationRequest.current !== request) return;
      if (operationName === "permanent_delete" && caught instanceof ConversationLocalErasureError &&
          caught.result.conversationId === conversationId) apply(caught.result as TResult);
      setOperation(null);
      setError(safeError(caught, operationName));
    }
  }, []);

  const createConversation = useCallback(async (input: ConversationPickerCreateInput) => {
    let key: ConversationCatalogIdempotencyKey;
    try {
      key = resolveKey("create", input.conversationId, input.idempotencyKey);
    } catch (caught) {
      setError(safeError(caught, "create"));
      return;
    }
    await runMutation<CreateConversationResult>(
      "create",
      input.conversationId ?? null,
      () => catalog.create({
        authorizationContext,
        idempotencyKey: key,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }),
      (result) => replaceDescriptor(result.descriptor),
    );
  }, [authorizationContext, catalog, replaceDescriptor, resolveKey, runMutation]);

  const renameConversation = useCallback(async (input: ConversationPickerRenameInput) => {
    let key: ConversationCatalogIdempotencyKey;
    try {
      key = resolveKey("rename", input.descriptor.conversationId, input.idempotencyKey);
    } catch (caught) {
      setError(safeError(caught, "rename"));
      return;
    }
    await runMutation<RenameConversationResult>(
      "rename",
      input.descriptor.conversationId,
      () => catalog.rename({
        authorizationContext,
        conversationId: input.descriptor.conversationId,
        expectedVersion: input.descriptor.version,
        idempotencyKey: key,
        title: input.title,
      }),
      (result) => replaceDescriptor(result.descriptor),
    );
  }, [authorizationContext, catalog, replaceDescriptor, resolveKey, runMutation]);

  const confirmDestructive = useCallback(async (
    operationName: "clear" | "archive" | "permanent_delete",
    descriptor: ConversationCatalogDescriptor,
  ): Promise<{
    readonly confirmed: boolean;
    readonly error: ConversationPickerError | null;
  }> => {
    if (confirm === undefined) {
      return { confirmed: false, error: confirmationError(operationName) };
    }
    try {
      return {
        confirmed: await confirm(Object.freeze({ operation: operationName, descriptor })),
        error: null,
      };
    } catch (caught) {
      return { confirmed: false, error: safeError(caught, operationName) };
    }
  }, [confirm]);

  const clearConversation = useCallback(async (input: ConversationPickerMutationInput) => {
    if (!catalog.capabilities.clear.supported) return;
    const requestGeneration = generation.current;
    const request = ++mutationRequest.current;
    setError(null);
    setOperation({ operation: "clear", conversationId: input.descriptor.conversationId });
    const confirmation = await confirmDestructive("clear", input.descriptor);
    if (generation.current !== requestGeneration || mutationRequest.current !== request) return;
    if (confirmation.error !== null) setError(confirmation.error);
    if (!confirmation.confirmed) {
      setOperation(null);
      return;
    }
    cancelOwnedOpenFor(input.descriptor.conversationId);
    let key: ConversationCatalogIdempotencyKey;
    try {
      key = resolveKey("clear", input.descriptor.conversationId, input.idempotencyKey);
    } catch (caught) {
      setOperation(null);
      setError(safeError(caught, "clear"));
      return;
    }
    await runMutation<ClearConversationResult>(
      "clear",
      input.descriptor.conversationId,
      () => (runtimeRegistry ?? catalog).clear({
        authorizationContext,
        conversationId: input.descriptor.conversationId,
        expectedVersion: input.descriptor.version,
        idempotencyKey: key,
      }),
      (result) => replaceDescriptor(result.descriptor),
      { generation: requestGeneration, request },
    );
  }, [authorizationContext, cancelOwnedOpenFor, catalog, confirmDestructive, replaceDescriptor, resolveKey, runMutation, runtimeRegistry]);

  const archiveConversation = useCallback(async (input: ConversationPickerMutationInput) => {
    if (!catalog.capabilities.archive.supported) return;
    const requestGeneration = generation.current;
    const request = ++mutationRequest.current;
    setError(null);
    setOperation({ operation: "archive", conversationId: input.descriptor.conversationId });
    const confirmation = await confirmDestructive("archive", input.descriptor);
    if (generation.current !== requestGeneration || mutationRequest.current !== request) return;
    if (confirmation.error !== null) setError(confirmation.error);
    if (!confirmation.confirmed) {
      setOperation(null);
      return;
    }
    cancelOwnedOpenFor(input.descriptor.conversationId);
    let key: ConversationCatalogIdempotencyKey;
    try {
      key = resolveKey("archive", input.descriptor.conversationId, input.idempotencyKey);
    } catch (caught) {
      setOperation(null);
      setError(safeError(caught, "archive"));
      return;
    }
    await runMutation<ArchiveConversationResult>(
      "archive",
      input.descriptor.conversationId,
      () => (runtimeRegistry ?? catalog).archive({
        authorizationContext,
        conversationId: input.descriptor.conversationId,
        expectedVersion: input.descriptor.version,
        idempotencyKey: key,
      }),
      (result) => replaceDescriptor(result.descriptor),
      { generation: requestGeneration, request },
    );
  }, [authorizationContext, cancelOwnedOpenFor, catalog, confirmDestructive, replaceDescriptor, resolveKey, runMutation, runtimeRegistry]);

  const restoreConversation = useCallback(async (input: ConversationPickerMutationInput) => {
    if (!catalog.capabilities.restore.supported) return;
    cancelOwnedOpenFor(input.descriptor.conversationId);
    let key: ConversationCatalogIdempotencyKey;
    try {
      key = resolveKey("restore", input.descriptor.conversationId, input.idempotencyKey);
    } catch (caught) {
      setError(safeError(caught, "restore"));
      return;
    }
    await runMutation<RestoreConversationResult>(
      "restore",
      input.descriptor.conversationId,
      () => (runtimeRegistry ?? catalog).restore({
        authorizationContext,
        conversationId: input.descriptor.conversationId,
        expectedVersion: input.descriptor.version,
        idempotencyKey: key,
      }),
      (result) => replaceDescriptor(result.descriptor),
    );
  }, [authorizationContext, cancelOwnedOpenFor, catalog, replaceDescriptor, resolveKey, runMutation, runtimeRegistry]);

  const permanentlyDeleteConversation = useCallback(async (
    input: ConversationPickerMutationInput,
  ) => {
    if (!catalog.capabilities.permanentDelete.supported) return;
    const requestGeneration = generation.current;
    const request = ++mutationRequest.current;
    setError(null);
    setOperation({
      operation: "permanent_delete",
      conversationId: input.descriptor.conversationId,
    });
    const confirmation = await confirmDestructive("permanent_delete", input.descriptor);
    if (generation.current !== requestGeneration || mutationRequest.current !== request) return;
    if (confirmation.error !== null) setError(confirmation.error);
    if (!confirmation.confirmed) {
      setOperation(null);
      return;
    }
    cancelOwnedOpenFor(input.descriptor.conversationId);
    let key: ConversationCatalogIdempotencyKey;
    try {
      key = resolveKey(
        "permanent_delete",
        input.descriptor.conversationId,
        input.idempotencyKey,
      );
    } catch (caught) {
      setOperation(null);
      setError(safeError(caught, "permanent_delete"));
      return;
    }
    await runMutation<PermanentlyDeleteConversationResult>(
      "permanent_delete",
      input.descriptor.conversationId,
      () => (runtimeRegistry ?? catalog).permanentlyDelete({
        authorizationContext,
        conversationId: input.descriptor.conversationId,
        expectedVersion: input.descriptor.version,
        idempotencyKey: key,
      }),
      (result) => {
        const rows = Object.freeze(itemsRef.current.filter((row) =>
          row.conversationId !== result.conversationId));
        itemsRef.current = rows;
        setItems(rows);
        if (selectedIdRef.current === result.conversationId) {
          cancelOwnedOpen();
          publishSelection(null, null);
        }
      },
      { generation: requestGeneration, request },
    );
  }, [authorizationContext, cancelOwnedOpen, cancelOwnedOpenFor, catalog, confirmDestructive, publishSelection, resolveKey, runMutation, runtimeRegistry]);

  const selectedConversation = items.find((item) =>
    item.conversationId === selectedConversationId) ?? null;
  return useMemo(() => ({
    items,
    selectedConversationId,
    selectedConversation,
    isInitialLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    nextCursor,
    error,
    operation,
    capabilities: catalog.capabilities,
    refresh,
    loadMore,
    openConversation,
    createConversation,
    renameConversation,
    clearConversation,
    archiveConversation,
    restoreConversation,
    permanentlyDeleteConversation,
    clearError: () => setError(null),
  }), [
    archiveConversation,
    catalog.capabilities,
    clearConversation,
    createConversation,
    error,
    hasMore,
    isInitialLoading,
    isLoadingMore,
    isRefreshing,
    items,
    loadMore,
    nextCursor,
    openConversation,
    operation,
    permanentlyDeleteConversation,
    refresh,
    renameConversation,
    restoreConversation,
    selectedConversation,
    selectedConversationId,
  ]);
}

const ConversationPickerContext = createContext<ConversationPickerController | null>(null);
const ConversationPickerItemContext = createContext<ConversationCatalogDescriptor | null>(null);

function usePicker(explicit?: ConversationPickerController): ConversationPickerController {
  const context = useContext(ConversationPickerContext);
  const picker = explicit ?? context;
  if (picker === null) throw new TypeError("A ConversationPicker controller is required.");
  return picker;
}

function useDescriptor(explicit?: ConversationCatalogDescriptor): ConversationCatalogDescriptor {
  const context = useContext(ConversationPickerItemContext);
  const descriptor = explicit ?? context;
  if (descriptor === null) throw new TypeError("A conversation descriptor is required.");
  return descriptor;
}

function restoreActionFocus(element: HTMLElement, fallback?: HTMLElement | null): void {
  globalThis.setTimeout(() => {
    if (element.isConnected && !element.matches(":disabled")) {
      element.focus();
      return;
    }
    const list = fallback?.isConnected
      ? fallback
      : document.querySelector<HTMLElement>("[data-conversation-picker-list]");
    const next = list?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)");
    (next ?? list)?.focus();
  }, 0);
}

export interface ConversationPickerRootProps extends HTMLAttributes<HTMLDivElement> {
  readonly controller: ConversationPickerController;
  readonly render?: PrimitiveRender<HTMLDivElement, HTMLAttributes<HTMLDivElement>>;
}

export const ConversationPickerRoot = forwardRef<HTMLDivElement, ConversationPickerRootProps>(
  function ConversationPickerRoot({ controller, render, ...props }, forwardedRef) {
    const nativeProps: HTMLAttributes<HTMLDivElement> = {
      ...props,
      "aria-busy": props["aria-busy"] ?? Boolean(
        controller.isInitialLoading || controller.isRefreshing ||
        controller.isLoadingMore || controller.operation,
      ),
    };
    return (
      <ConversationPickerContext.Provider value={controller}>
        {render
          ? render(nativeProps, forwardedRef)
          : <div {...nativeProps} ref={forwardedRef} />}
      </ConversationPickerContext.Provider>
    );
  },
);

export type ConversationPickerItemRenderer = (
  descriptor: ConversationCatalogDescriptor,
  index: number,
) => ReactNode;

export interface ConversationPickerListNativeProps extends HTMLAttributes<HTMLUListElement> {
  "data-conversation-picker-list"?: string;
}

export interface ConversationPickerListProps
  extends Omit<ConversationPickerListNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller?: ConversationPickerController;
  readonly render?: PrimitiveRender<HTMLUListElement, ConversationPickerListNativeProps>;
  readonly renderItem?: ConversationPickerItemRenderer;
}

export const ConversationPickerList = forwardRef<HTMLUListElement, ConversationPickerListProps>(
  function ConversationPickerList(
    { children, controller: explicit, render, renderItem, ...props },
    forwardedRef,
  ) {
    const controller = usePicker(explicit);
    const content = children ?? controller.items.map((descriptor, index) =>
      renderItem?.(descriptor, index) ?? (
        <ConversationPickerItem key={descriptor.conversationId} descriptor={descriptor} />
      ));
    const nativeProps: ConversationPickerListNativeProps = {
      ...props,
      children: content,
      "aria-label": props["aria-label"] ?? "Conversations",
      "aria-busy": props["aria-busy"] ?? Boolean(
        controller.isInitialLoading || controller.isRefreshing || controller.isLoadingMore,
      ),
      "data-conversation-picker-list": "",
      tabIndex: props.tabIndex ?? -1,
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <ul {...nativeProps} ref={forwardedRef} />;
  },
);

export interface ConversationPickerItemNativeProps extends LiHTMLAttributes<HTMLLIElement> {
  "data-conversation-id"?: string;
  "data-conversation-lifecycle"?: string;
}

export interface ConversationPickerItemProps
  extends Omit<ConversationPickerItemNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly descriptor: ConversationCatalogDescriptor;
  readonly render?: PrimitiveRender<HTMLLIElement, ConversationPickerItemNativeProps>;
}

export const ConversationPickerItem = forwardRef<HTMLLIElement, ConversationPickerItemProps>(
  function ConversationPickerItem({ children, descriptor, render, ...props }, forwardedRef) {
    const nativeProps: ConversationPickerItemNativeProps = {
      ...props,
      children: children ?? <ConversationPickerSelect />,
      "aria-label": props["aria-label"] ?? descriptor.title ?? "Untitled conversation",
      "data-conversation-id": descriptor.conversationId,
      "data-conversation-lifecycle": descriptor.lifecycle,
    };
    return (
      <ConversationPickerItemContext.Provider value={descriptor}>
        {render
          ? render(nativeProps, forwardedRef)
          : <li {...nativeProps} ref={forwardedRef} />}
      </ConversationPickerItemContext.Provider>
    );
  },
);

export interface ConversationPickerSelectProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly controller?: ConversationPickerController;
  readonly descriptor?: ConversationCatalogDescriptor;
  readonly render?: PrimitiveRender<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>;
}

export const ConversationPickerSelect = forwardRef<HTMLButtonElement, ConversationPickerSelectProps>(
  function ConversationPickerSelect(
    { children, controller: explicit, descriptor: explicitDescriptor, onClick, render, ...props },
    forwardedRef,
  ) {
    const controller = usePicker(explicit);
    const descriptor = useDescriptor(explicitDescriptor);
    const selected = controller.selectedConversationId === descriptor.conversationId;
    const opening = controller.operation?.operation === "open" &&
      controller.operation.conversationId === descriptor.conversationId;
    const label = descriptor.title ?? "Untitled conversation";
    const nativeProps: ButtonHTMLAttributes<HTMLButtonElement> = {
      ...props,
      type: props.type ?? "button",
      children: children ?? label,
      "aria-label": props["aria-label"] ?? `Open conversation: ${label}`,
      "aria-current": props["aria-current"] ?? (selected ? "true" : undefined),
      "aria-pressed": props["aria-pressed"] ?? selected,
      "aria-busy": props["aria-busy"] ?? opening,
      disabled: props.disabled ?? opening,
      onClick: (event) => {
        onClick?.(event);
        if (!event.defaultPrevented) void controller.openConversation(descriptor);
      },
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <button {...nativeProps} ref={forwardedRef} />;
  },
);

interface PickerConditionalProps extends HTMLAttributes<HTMLParagraphElement> {
  readonly controller?: ConversationPickerController;
  readonly render?: PrimitiveRender<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>;
}

function conditionalParagraph(
  visible: boolean,
  defaultChildren: ReactNode,
  props: PickerConditionalProps,
  forwardedRef: ForwardedRef<HTMLParagraphElement>,
): ReactNode {
  const { children, controller, render, ...rest } = props;
  void controller;
  if (!visible) return null;
  const nativeProps: HTMLAttributes<HTMLParagraphElement> = {
    ...rest,
    children: children ?? defaultChildren,
  };
  return render ? render(nativeProps, forwardedRef) : <p {...nativeProps} ref={forwardedRef} />;
}

export const ConversationPickerLoading = forwardRef<HTMLParagraphElement, PickerConditionalProps>(
  function ConversationPickerLoading(props, forwardedRef) {
    const controller = usePicker(props.controller);
    return conditionalParagraph(
      controller.isInitialLoading || controller.isRefreshing || controller.isLoadingMore,
      controller.isInitialLoading
        ? "Loading conversations…"
        : controller.isLoadingMore ? "Loading more conversations…" : "Refreshing conversations…",
      { role: "status", "aria-live": "polite", ...props },
      forwardedRef,
    );
  },
);

export const ConversationPickerErrorMessage = forwardRef<
  HTMLParagraphElement,
  PickerConditionalProps
>(function ConversationPickerErrorMessage(props, forwardedRef) {
  const controller = usePicker(props.controller);
  const current = useRef(controller); current.current = controller;
  const [retrying, setRetrying] = useState<ConversationPickerError | null>(null);
  const error = controller.error;
  return conditionalParagraph(
    error !== null,
    error?.retryCleanup ? <>{error.message} <button type="button" disabled={retrying === error}
      onClick={() => {
        setRetrying(error);
        void error.retryCleanup!().then(() => {
          if (current.current.error === error) current.current.clearError();
        }).catch(() => { /* Preserve the actionable local cleanup error. */ }).finally(() => setRetrying(value => value === error ? null : value));
      }}>Retry device cleanup</button></> : error?.message,
    { role: "alert", ...props },
    forwardedRef,
  );
});

export const ConversationPickerEmpty = forwardRef<HTMLParagraphElement, PickerConditionalProps>(
  function ConversationPickerEmpty(props, forwardedRef) {
    const controller = usePicker(props.controller);
    return conditionalParagraph(
      !controller.isInitialLoading && !controller.isRefreshing && !controller.isLoadingMore &&
        controller.error === null && controller.items.length === 0,
      "No conversations.",
      { role: "status", ...props },
      forwardedRef,
    );
  },
);

export interface ConversationPickerLoadMoreProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly controller?: ConversationPickerController;
  readonly render?: PrimitiveRender<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>;
}

export const ConversationPickerLoadMore = forwardRef<
  HTMLButtonElement,
  ConversationPickerLoadMoreProps
>(function ConversationPickerLoadMore(
  { children, controller: explicit, onClick, render, ...props },
  forwardedRef,
) {
  const controller = usePicker(explicit);
  const nativeProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    ...props,
    type: props.type ?? "button",
    children: children ?? "Load more conversations",
    "aria-label": props["aria-label"] ?? "Load more conversations",
    "aria-busy": props["aria-busy"] ?? controller.isLoadingMore,
    disabled: props.disabled ?? (!controller.hasMore || controller.isLoadingMore),
    onClick: (event) => {
      onClick?.(event);
      if (!event.defaultPrevented) void controller.loadMore();
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <button {...nativeProps} ref={forwardedRef} />;
});

export interface ConversationPickerCreateFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "children"> {
  readonly children?: ReactNode;
  readonly controller?: ConversationPickerController;
  readonly conversationId?: ConversationId;
  readonly idempotencyKey?: ConversationCatalogIdempotencyKey;
  readonly inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "name">;
  readonly metadata?: ConversationCatalogMetadata;
  readonly render?: PrimitiveRender<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>;
}

export const ConversationPickerCreateForm = forwardRef<
  HTMLFormElement,
  ConversationPickerCreateFormProps
>(function ConversationPickerCreateForm(
  {
    children,
    controller: explicit,
    conversationId,
    idempotencyKey,
    inputProps,
    metadata,
    onSubmit,
    render,
    ...props
  },
  forwardedRef,
) {
  const controller = usePicker(explicit);
  const busy = controller.operation?.operation === "create";
  const content = children ?? <>
    <label>
      Conversation title
      <input {...inputProps} name="title" disabled={inputProps?.disabled ?? busy} />
    </label>
    <button type="submit" disabled={busy}>Create conversation</button>
  </>;
  const nativeProps: FormHTMLAttributes<HTMLFormElement> = {
    ...props,
    children: content,
    "aria-label": props["aria-label"] ?? "Create conversation",
    "aria-busy": props["aria-busy"] ?? busy,
    onSubmit: (event) => {
      onSubmit?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      const focus = event.currentTarget.querySelector<HTMLElement>("button[type=submit]") ??
        event.currentTarget;
      const fallback = event.currentTarget;
      const title = new FormData(event.currentTarget).get("title");
      void controller.createConversation({
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(metadata === undefined ? {} : { metadata }),
        ...(typeof title === "string" && title.trim() !== "" ? { title } : {}),
      }).finally(() => restoreActionFocus(focus, fallback));
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <form {...nativeProps} ref={forwardedRef} />;
});

export interface ConversationPickerRenameFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "children"> {
  readonly children?: ReactNode;
  readonly controller?: ConversationPickerController;
  readonly descriptor?: ConversationCatalogDescriptor;
  readonly idempotencyKey?: ConversationCatalogIdempotencyKey;
  readonly inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "defaultValue">;
  readonly render?: PrimitiveRender<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>;
}

export const ConversationPickerRenameForm = forwardRef<
  HTMLFormElement,
  ConversationPickerRenameFormProps
>(function ConversationPickerRenameForm(
  { children, controller: explicit, descriptor: explicitDescriptor, idempotencyKey,
    inputProps, onSubmit, render, ...props },
  forwardedRef,
) {
  const controller = usePicker(explicit);
  const descriptor = useDescriptor(explicitDescriptor);
  const busy = controller.operation?.operation === "rename" &&
    controller.operation.conversationId === descriptor.conversationId;
  const content = children ?? <>
    <label>
      Rename conversation
      <input
        {...inputProps}
        name="title"
        defaultValue={descriptor.title ?? ""}
        disabled={inputProps?.disabled ?? busy}
      />
    </label>
    <button type="submit" disabled={busy}>Save conversation title</button>
  </>;
  const nativeProps: FormHTMLAttributes<HTMLFormElement> = {
    ...props,
    children: content,
    "aria-label": props["aria-label"] ?? `Rename ${descriptor.title ?? "conversation"}`,
    "aria-busy": props["aria-busy"] ?? busy,
    onSubmit: (event: FormEvent<HTMLFormElement>) => {
      onSubmit?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      const focus = event.currentTarget.querySelector<HTMLElement>("button[type=submit]") ??
        event.currentTarget;
      const fallback = event.currentTarget;
      const title = new FormData(event.currentTarget).get("title");
      if (typeof title !== "string") return;
      void controller.renameConversation({
        descriptor,
        title,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }).finally(() => restoreActionFocus(focus, fallback));
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <form {...nativeProps} ref={forwardedRef} />;
});

type LifecycleOperation = "clear" | "archive" | "restore" | "permanent_delete";

export interface ConversationPickerActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly controller?: ConversationPickerController;
  readonly descriptor?: ConversationCatalogDescriptor;
  readonly idempotencyKey?: ConversationCatalogIdempotencyKey;
  readonly render?: PrimitiveRender<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>;
}

function actionButton(
  operationName: LifecycleOperation,
  defaultLabel: string,
  props: ConversationPickerActionProps,
  forwardedRef: ForwardedRef<HTMLButtonElement>,
): ReactNode {
  const {
    children,
    controller: explicit,
    descriptor: explicitDescriptor,
    idempotencyKey,
    onClick,
    render,
    ...rest
  } = props;
  const controller = usePicker(explicit);
  const descriptor = useDescriptor(explicitDescriptor);
  const capability = operationName === "permanent_delete"
    ? controller.capabilities.permanentDelete
    : controller.capabilities[operationName];
  const busy = controller.operation?.operation === operationName &&
    controller.operation.conversationId === descriptor.conversationId;
  const nativeProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    ...rest,
    type: rest.type ?? "button",
    children: children ?? defaultLabel,
    "aria-label": rest["aria-label"] ?? `${defaultLabel}: ${descriptor.title ?? "Untitled conversation"}`,
    "aria-busy": rest["aria-busy"] ?? busy,
    disabled: rest.disabled ?? (!capability.supported || busy),
    onClick: (event) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      const focus = event.currentTarget;
      const fallback = focus.closest<HTMLElement>("[data-conversation-picker-list]");
      const input = {
        descriptor,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      };
      const promise = operationName === "clear"
        ? controller.clearConversation(input)
        : operationName === "archive"
          ? controller.archiveConversation(input)
          : operationName === "restore"
            ? controller.restoreConversation(input)
            : controller.permanentlyDeleteConversation(input);
      void promise.finally(() => restoreActionFocus(focus, fallback));
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <button {...nativeProps} ref={forwardedRef} />;
}

export type ConversationPickerClearProps = ConversationPickerActionProps;
export const ConversationPickerClear = forwardRef<HTMLButtonElement, ConversationPickerClearProps>(
  function ConversationPickerClear(props, ref) {
    return actionButton("clear", "Clear conversation", props, ref);
  },
);

export type ConversationPickerArchiveProps = ConversationPickerActionProps;
export const ConversationPickerArchive = forwardRef<
  HTMLButtonElement,
  ConversationPickerArchiveProps
>(function ConversationPickerArchive(props, ref) {
  return actionButton("archive", "Archive conversation", props, ref);
});

export type ConversationPickerRestoreProps = ConversationPickerActionProps;
export const ConversationPickerRestore = forwardRef<
  HTMLButtonElement,
  ConversationPickerRestoreProps
>(function ConversationPickerRestore(props, ref) {
  return actionButton("restore", "Restore conversation", props, ref);
});

export type ConversationPickerPermanentDeleteProps = ConversationPickerActionProps;
export const ConversationPickerPermanentDelete = forwardRef<
  HTMLButtonElement,
  ConversationPickerPermanentDeleteProps
>(function ConversationPickerPermanentDelete(props, ref) {
  return actionButton("permanent_delete", "Permanently delete conversation", props, ref);
});
