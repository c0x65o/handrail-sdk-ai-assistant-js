/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  CONVERSATION_EVENT_VERSION,
  InMemoryConversationEventStore,
  createConversationRuntime,
  createConversationStore,
  createConversationSyncCoordinator,
  parseConversationEvent,
  parseNormalizedUsageReceipt,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type AuthoritativeAttribution,
  type ConversationClientId,
  type ConversationEvent,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeSendMessageInput,
  type ConversationStore,
  type ConversationSyncAdapter,
  type ConversationSyncSubscription,
  type ConversationSyncUpdate,
  type ConversationTransport,
  type TurnObservation,
  type TurnObservationResult,
} from "../src/index.js";
import {
  ConversationProvider,
  MessageList,
  type ConversationProviderProps,
  useConversationActions,
  useConversationSelector,
  useConversationSnapshot,
  useConversationStore,
} from "../src/react/index.js";

afterEach(() => cleanup());

class RemoteUpdateStream implements AsyncIterable<ConversationSyncUpdate> {
  private readonly values: ConversationSyncUpdate[] = [];
  private readonly readers: Array<(
    result: IteratorResult<ConversationSyncUpdate>,
  ) => void> = [];
  private closed = false;

  push(update: ConversationSyncUpdate): void {
    const reader = this.readers.shift();
    if (reader === undefined) this.values.push(update);
    else reader({ done: false, value: update });
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ConversationSyncUpdate> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

class DeterministicCanonicalLog extends InMemoryConversationEventStore {
  private readonly updateStreams = new Set<RemoteUpdateStream>();

  override async append(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult> {
    const result = await super.append(input);
    if (result.status === "appended") {
      const update: ConversationSyncUpdate = {
        status: "events",
        events: result.entries.map(({ event }) => event),
        revision: result.latestRevision,
        latestRevision: result.latestRevision,
        hasMore: false,
      };
      for (const stream of this.updateStreams) stream.push(update);
    }
    return result;
  }

  createSyncAdapter(): ConversationSyncAdapter {
    return {
      pullSnapshot: async () => ({
        status: "unauthorized",
        message: "Canonical-log fixture does not use snapshots",
      }),
      readSince: async ({ conversationId, afterRevision, limit }) => {
        const page = await this.read({
          conversationId,
          ...(afterRevision === null ? {} : { after: { revision: afterRevision } }),
          ...(limit === undefined ? {} : { limit }),
        });
        return {
          status: "events",
          events: page.entries.map(({ event }) => event),
          revision: page.entries.at(-1)?.event.revision ?? afterRevision,
          latestRevision: page.latestRevision,
          hasMore: page.hasMore,
        };
      },
      appendMutations: async () => ({
        status: "unauthorized",
        message: "Runtime writes directly to the canonical-log fixture",
      }),
      subscribeSince: async () => {
        const updates = new RemoteUpdateStream();
        this.updateStreams.add(updates);
        const subscription: ConversationSyncSubscription = {
          updates,
          close: () => {
            this.updateStreams.delete(updates);
            updates.close();
          },
        };
        return { status: "subscribed", subscription };
      },
      publishPresence: async () => ({
        status: "unauthorized",
        message: "Presence not used",
      }),
      subscribePresence: async () => ({
        status: "unauthorized",
        message: "Presence not used",
      }),
    };
  }
}

interface PairedRequest {
  readonly model: string;
}

const pairedAttribution: AuthoritativeAttribution = {
  organization: { id: "org_paired", source: "server_derived", trust: "authoritative" },
  project: { id: "project_paired", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "test",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function pairedFrame(
  type: string,
  sequence: number,
  fields: Record<string, unknown> = {},
): unknown {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "request_paired",
    trace_id: "trace_paired",
    sequence,
    ...fields,
  };
}

function pairedUsageReceipt(conversationId: ConversationId, turnId: string) {
  return parseNormalizedUsageReceipt({
    version: 1,
    usage_receipt_id: "usage_paired_1",
    conversation_id: conversationId,
    turn_id: turnId,
    logical_request_id: "logical_paired_1",
    trace_id: "trace_paired",
    attempt: { id: "attempt_paired_0", index: 0 },
    continuation: { id: "continuation_paired_0", index: 0 },
    provider_id: "offline-fixture",
    model_id: "fixture-model",
    attribution: pairedAttribution,
    source: "provider",
    terminal_status: "completed",
    tokens: {
      input_tokens: { status: "reported", value: 4 },
      cached_input_tokens: { status: "reported", value: 0 },
      output_tokens: { status: "reported", value: 3 },
      reasoning_tokens: { status: "reported", value: 0 },
      total_tokens: { status: "reported", value: 7 },
    },
    provider_cost: { status: "unavailable" },
  });
}

function controlledPairedObservation(
  usageReceipt: ReturnType<typeof pairedUsageReceipt>,
): {
  readonly observation: TurnObservation<unknown>;
  readonly paused: Promise<void>;
  readonly release: () => void;
} {
  let release!: () => void;
  let markPaused!: () => void;
  let resolveResult!: (result: TurnObservationResult) => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  const checkpoint = {
    lastAppliedEventId: "request_paired:3",
    lastAppliedCursor: "request_paired:3",
    lastAppliedRevision: 3,
  };
  const observation: TurnObservation<unknown> = {
    events: {
      async *[Symbol.asyncIterator]() {
        yield pairedFrame("response.started", 0, { attribution: pairedAttribution });
        yield pairedFrame("response.text.delta", 1, { delta: "Hello " });
        markPaused();
        await released;
        yield pairedFrame("response.text.delta", 2, { delta: "from the canonical log" });
        yield pairedFrame("response.completed", 3, { outcome: "stop" });
        resolveResult({ status: "completed", checkpoint, usageReceipt });
      },
    },
    result,
    disconnect() {
      release();
      resolveResult({ status: "disconnected", checkpoint });
    },
  };
  return { observation, paused, release };
}

function offlinePairedTransport(observation?: TurnObservation<unknown>) {
  const startTurn = vi.fn<ConversationTransport<unknown, PairedRequest>["startTurn"]>(
    async (input) => {
      if (observation === undefined) {
        throw new Error("No offline observation configured");
      }
      return {
        ok: true,
        value: {
          conversationId: input.conversationId,
          turnId: "transport_turn_paired",
          mutationId: input.mutationId,
          observation,
        },
      };
    },
  );
  const transport: ConversationTransport<unknown, PairedRequest> = {
    capabilities: {
      authoritativeCancellation: { supported: false },
      documentInput: { supported: false },
      attachmentUpload: { supported: false },
      presence: { supported: false },
      synchronization: { supported: false },
    },
    startTurn,
    resumeTurn: async () => {
      throw new Error("Offline fixture does not resume turns");
    },
  };
  return { transport, startTurn };
}

function remoteSyncAdapter(updates: RemoteUpdateStream): ConversationSyncAdapter {
  const subscription: ConversationSyncSubscription = {
    updates,
    close: () => updates.close(),
  };
  return {
    async pullSnapshot() {
      return { status: "unauthorized", message: "No snapshot expected" };
    },
    async readSince() {
      return {
        status: "events",
        events: [],
        revision: null,
        latestRevision: null,
        hasMore: false,
      };
    },
    async appendMutations() {
      return { status: "unauthorized", message: "Read-only test adapter" };
    },
    async subscribeSince() {
      return { status: "subscribed", subscription };
    },
    async publishPresence() {
      return { status: "unauthorized", message: "Presence not used" };
    },
    async subscribePresence() {
      return { status: "unauthorized", message: "Presence not used" };
    },
  };
}

function event(
  revision: number,
  payload: ConversationEvent["payload"],
  conversationId = "conversation_react",
): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: `event_${conversationId}_${revision}`,
    conversation_id: conversationId,
    revision,
    occurred_at: `2026-08-27T12:00:${String(revision).padStart(2, "0")}.000Z`,
    actor: { type: "assistant" },
    source: { type: "runtime" },
    payload,
  });
}

function titleEvent(
  revision: number,
  title: string,
  conversationId?: string,
): ConversationEvent {
  return event(
    revision,
    { type: "conversation.title_updated", title },
    conversationId,
  );
}

function fakeRuntime<TRequest>(store: ConversationStore) {
  const destroy = vi.fn();
  const sendMessage = vi.fn<ConversationRuntime<TRequest>["sendMessage"]>();
  const resumeTurn = vi.fn<ConversationRuntime<TRequest>["resumeTurn"]>();
  const stopObserving = vi.fn<ConversationRuntime<TRequest>["stopObserving"]>();
  const cancelTurn = vi.fn<ConversationRuntime<TRequest>["cancelTurn"]>();
  const restoreActiveTurn = vi.fn<ConversationRuntime<TRequest>["restoreActiveTurn"]>();
  const runtime: ConversationRuntime<TRequest> = {
    store,
    getSnapshot: store.getSnapshot,
    observe(observer) {
      return store.subscribe(() => observer(store.getSnapshot()));
    },
    sendMessage,
    resumeTurn,
    stopObserving,
    cancelTurn,
    restoreActiveTurn,
    destroy,
  };
  return { runtime, destroy, sendMessage };
}

describe("ConversationProvider and hooks", () => {
  it("fails with an actionable error when a hook has no provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function MissingProvider() {
      useConversationStore();
      return null;
    }

    expect(() => render(<MissingProvider />)).toThrow(
      /useConversationStore must be used within a <ConversationProvider>/u,
    );
    consoleError.mockRestore();
  });

  it("rejects undefined or ambiguously combined provider sources", () => {
    const store = createConversationStore();
    const { runtime } = fakeRuntime<unknown>(store);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalidSources: readonly Record<string, unknown>[] = [
      {},
      { store: undefined },
      { runtime: undefined },
      { create: undefined },
      { store, runtime: undefined },
      { runtime, store: undefined },
      { store, create: () => store },
      { runtime, create: () => store },
      { store, runtime, create: () => store },
    ];

    for (const sourceProps of invalidSources) {
      expect(() =>
        render(
          <ConversationProvider
            {...(sourceProps as unknown as ConversationProviderProps)}
          />,
        )
      ).toThrow(/requires `create` alone/u);
    }
    consoleError.mockRestore();
  });

  it("selectively rerenders while observing every external store update", async () => {
    const store = createConversationStore();
    let titleRenders = 0;
    let snapshotRenders = 0;

    function SelectedTitle() {
      titleRenders += 1;
      return <span data-testid="title">{useConversationSelector((state) => state.title)}</span>;
    }
    function Revision() {
      snapshotRenders += 1;
      return <span data-testid="revision">{useConversationSnapshot().revision ?? 0}</span>;
    }

    render(
      <ConversationProvider store={store}>
        <SelectedTitle />
        <Revision />
      </ConversationProvider>,
    );
    expect(titleRenders).toBe(1);
    expect(snapshotRenders).toBe(1);

    await act(() =>
      store.applyEvent(
        event(1, {
          type: "conversation.metadata_updated",
          metadata: { streamed: true },
        }),
      ),
    );
    expect(screen.getByTestId("revision").textContent).toBe("1");
    expect(titleRenders).toBe(1);
    expect(snapshotRenders).toBe(2);

    await act(() => store.applyEvent(titleEvent(2, "Streaming complete")));
    expect(screen.getByTestId("title").textContent).toBe("Streaming complete");
    expect(titleRenders).toBe(2);
    expect(snapshotRenders).toBe(3);
  });

  it("observes authoritative remote updates from a sync view store exactly once", async () => {
    const conversationId = "conversation_react_sync" as ConversationId;
    const updates = new RemoteUpdateStream();
    const coordinator = createConversationSyncCoordinator({
      conversationId,
      eventStore: new InMemoryConversationEventStore(),
      adapter: remoteSyncAdapter(updates),
    });
    await coordinator.start();
    let selectedRenders = 0;
    let primitiveRenders = 0;
    let observedStore: ReturnType<typeof useConversationStore> | undefined;
    let actions: ReturnType<typeof useConversationActions> | undefined;

    function SelectedMessageCount() {
      selectedRenders += 1;
      observedStore = useConversationStore();
      actions = useConversationActions();
      const count = useConversationSelector((state) => state.messages.length);
      return <span data-testid="sync-count">{count}</span>;
    }

    const view = render(
      <ConversationProvider store={coordinator.store}>
        <SelectedMessageCount />
        <MessageList
          data-testid="sync-messages"
          render={(props, ref) => {
            primitiveRenders += 1;
            return <div {...props} ref={ref} />;
          }}
        />
      </ConversationProvider>,
    );
    expect(observedStore).toBe(coordinator.store);
    expect(selectedRenders).toBe(1);
    expect(primitiveRenders).toBe(1);

    const remoteEvent = event(1, {
      type: "message.created",
      message_id: "message_remote" as never,
      role: "assistant",
      content: [{ type: "text", text: "Authoritative remote message" }],
    }, conversationId);
    updates.push({
      status: "events",
      events: [remoteEvent],
      revision: remoteEvent.revision,
      latestRevision: remoteEvent.revision,
      hasMore: false,
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(coordinator.store.getSnapshot().revision).toBe(1);
      });
    });

    expect(screen.getByTestId("sync-count").textContent).toBe("1");
    expect(screen.getByTestId("sync-messages").textContent).toContain(
      "Authoritative remote message",
    );
    expect(selectedRenders).toBe(2);
    expect(primitiveRenders).toBe(2);

    expect(actions).toBeDefined();
    expect(() => actions?.applyEvent(remoteEvent)).toThrow(/mutable ConversationStore/u);
    expect(() => actions?.applyEvents([remoteEvent])).toThrow(/mutable ConversationStore/u);
    expect(() => actions?.sendMessage({ content: "hello", request: undefined })).toThrow(
      /runtime actions require/u,
    );
    expect(() => actions?.resumeTurn("turn_remote" as never)).toThrow(
      /runtime actions require/u,
    );
    expect(() => actions?.restoreActiveTurn()).toThrow(/runtime actions require/u);

    view.unmount();
    const create = vi.fn(() => coordinator.store);
    const ownedView = render(
      <ConversationProvider create={create}>
        <SelectedMessageCount />
      </ConversationProvider>,
    );
    ownedView.unmount();
    await act(async () => Promise.resolve());
    expect(create).toHaveBeenCalledOnce();
    expect(coordinator.store.getSnapshot().revision).toBe(1);
    await coordinator.destroy();
  });

  it("converges paired sync reads and runtime actions through one canonical log", async () => {
    const conversationId = "conversation_react_paired_sync" as ConversationId;
    const canonicalLog = new DeterministicCanonicalLog();
    const receipt = pairedUsageReceipt(conversationId, "turn_paired_2");
    const controlled = controlledPairedObservation(receipt);
    const { transport, startTurn } = offlinePairedTransport(controlled.observation);
    let nextId = 0;
    let nextTime = 0;
    const runtime = await createConversationRuntime({
      conversationId,
      clientId: "client_paired" as ConversationClientId,
      transport,
      eventStore: canonicalLog,
      createId: (kind) => `${kind}_paired_${++nextId}`,
      now: () =>
        `2026-08-27T13:00:${String(++nextTime).padStart(2, "0")}.000Z`,
    });
    const coordinator = createConversationSyncCoordinator({
      conversationId,
      eventStore: canonicalLog,
      adapter: canonicalLog.createSyncAdapter(),
    });
    await coordinator.start();
    let observedStore: ReturnType<typeof useConversationStore> | undefined;
    let actions: ReturnType<typeof useConversationActions<PairedRequest>> | undefined;

    function PairedConsumer() {
      observedStore = useConversationStore();
      actions = useConversationActions<PairedRequest>();
      const count = useConversationSelector((state) => state.messages.length);
      const revision = useConversationSelector((state) => state.revision);
      const turnStatus = useConversationSelector(
        (state) => state.turns.at(-1)?.status ?? "none",
      );
      const receiptCount = useConversationSelector(
        (state) => state.usage_receipt_links.length,
      );
      return (
        <>
          <span data-testid="paired-sync-count">{count}</span>
          <span data-testid="paired-sync-revision">{revision ?? 0}</span>
          <span data-testid="paired-sync-turn-status">{turnStatus}</span>
          <span data-testid="paired-sync-receipts">{receiptCount}</span>
        </>
      );
    }

    const view = render(
      <ConversationProvider store={coordinator.store} runtime={runtime}>
        <PairedConsumer />
        <MessageList
          data-testid="paired-sync-messages"
          render={(props, ref) => <div {...props} ref={ref} />}
        />
      </ConversationProvider>,
    );
    expect(observedStore).toBe(coordinator.store);
    expect(screen.getByTestId("paired-sync-count").textContent).toBe("0");

    const otherDeviceEvent = parseConversationEvent({
      version: CONVERSATION_EVENT_VERSION,
      event_id: "event_other_device_1",
      conversation_id: conversationId,
      revision: 1,
      occurred_at: "2026-08-27T12:59:59.000Z",
      actor: { type: "user" },
      source: {
        type: "client",
        client_id: "client_other_device",
        device_id: "device_other",
      },
      payload: {
        type: "message.created",
        message_id: "message_other_device",
        role: "user",
        content: [{ type: "text", text: "Message from another device" }],
      },
    });
    await canonicalLog.append({
      conversationId,
      expectedRevision: null,
      events: [otherDeviceEvent],
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(coordinator.store.getSnapshot().revision).toBe(1);
      });
    });

    expect(screen.getByTestId("paired-sync-count").textContent).toBe("1");
    expect(screen.getByTestId("paired-sync-messages").textContent).toContain(
      "Message from another device",
    );

    const input: ConversationRuntimeSendMessageInput<PairedRequest> = {
      content: "Local follow-up",
      request: { model: "fixture-model" },
    };
    let sending!: ReturnType<NonNullable<typeof actions>["sendMessage"]>;
    await act(async () => {
      sending = actions!.sendMessage(input);
      await controlled.paused;
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(coordinator.store.getSnapshot().revision).toBe(7);
      });
    });

    expect(screen.getByTestId("paired-sync-messages").textContent).toContain(
      "Local follow-up",
    );
    expect(screen.getByTestId("paired-sync-messages").textContent).toContain("Hello ");
    expect(screen.getByTestId("paired-sync-turn-status").textContent).toBe("running");
    expect(screen.getByTestId("paired-sync-receipts").textContent).toBe("0");

    controlled.release();
    await act(async () => {
      await sending;
      await vi.waitFor(() => {
        expect(coordinator.store.getSnapshot().revision).toBe(10);
      });
    });

    expect(startTurn).toHaveBeenCalledOnce();
    expect(screen.getByTestId("paired-sync-revision").textContent).toBe("10");
    expect(screen.getByTestId("paired-sync-turn-status").textContent).toBe("completed");
    expect(screen.getByTestId("paired-sync-receipts").textContent).toBe("1");
    const renderedMessages = screen.getByTestId("paired-sync-messages").textContent ?? "";
    expect(renderedMessages.split("Message from another device")).toHaveLength(2);
    expect(renderedMessages.split("Local follow-up")).toHaveLength(2);
    expect(renderedMessages.split("Hello from the canonical log")).toHaveLength(2);

    const history = await canonicalLog.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.revision)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    expect(history.entries.map(({ event }) => event.payload.type)).toEqual([
      "message.created",
      "message.created",
      "turn.started",
      "turn.attempt_started",
      "turn.status_changed",
      "turn.status_changed",
      "message.text_appended",
      "message.text_appended",
      "usage.receipt_linked",
      "turn.completed",
    ]);
    expect(new Set(history.entries.map(({ event }) => event.event_id)).size).toBe(10);
    const firstProjection = coordinator.store.getSnapshot();
    expect(firstProjection.messages).toHaveLength(3);
    expect(firstProjection.turns).toMatchObject([{ status: "completed", outcome: "stop" }]);
    expect(firstProjection.usage_receipt_links).toMatchObject([{
      turn_id: "turn_paired_2",
      usage_receipt_id: "usage_paired_1",
    }]);
    expect(runtime.getSnapshot()).toEqual(firstProjection);

    view.unmount();
    runtime.destroy();
    await coordinator.destroy();

    const restartedTransport = offlinePairedTransport();
    const restartedRuntime = await createConversationRuntime({
      conversationId,
      clientId: "client_paired_restart" as ConversationClientId,
      transport: restartedTransport.transport,
      eventStore: canonicalLog,
    });
    const restartedCoordinator = createConversationSyncCoordinator({
      conversationId,
      eventStore: canonicalLog,
      adapter: canonicalLog.createSyncAdapter(),
    });
    await restartedCoordinator.start();

    expect(restartedRuntime.getSnapshot()).toEqual(firstProjection);
    expect(restartedCoordinator.store.getSnapshot()).toEqual(firstProjection);
    expect(restartedTransport.startTurn).not.toHaveBeenCalled();

    restartedRuntime.destroy();
    await restartedCoordinator.destroy();
  });

  it("rejects paired stores and runtimes for different conversations before sending", () => {
    const store = createConversationStore("conversation_store" as ConversationId);
    const runtimeStore = createConversationStore("conversation_runtime" as ConversationId);
    const { runtime, sendMessage } = fakeRuntime<unknown>(runtimeStore);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      render(<ConversationProvider store={store} runtime={runtime} />)
    ).toThrow(
      /must belong to the same conversation; store belongs to conversation_store and runtime belongs to conversation_runtime/u,
    );
    expect(sendMessage).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("keeps action identity stable and preserves the runtime request type", async () => {
    interface Request {
      readonly model: string;
      readonly temperature?: number;
    }
    const store = createConversationStore();
    const { runtime, sendMessage } = fakeRuntime<Request>(store);
    const seenActions: unknown[] = [];

    function Consumer() {
      const actions = useConversationActions<Request>();
      useConversationSnapshot();
      seenActions.push(actions);
      expectTypeOf(actions.sendMessage).parameter(0).toEqualTypeOf<
        ConversationRuntimeSendMessageInput<Request>
      >();
      return null;
    }

    render(
      <ConversationProvider runtime={runtime}>
        <Consumer />
      </ConversationProvider>,
    );
    await act(() => store.applyEvent(titleEvent(1, "Updated")));

    expect(new Set(seenActions).size).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("isolates nested providers and their conversations", async () => {
    const outer = createConversationStore();
    const inner = createConversationStore();

    function Title({ testId }: { testId: string }) {
      return <span data-testid={testId}>{useConversationSelector((state) => state.title)}</span>;
    }

    render(
      <ConversationProvider store={outer}>
        <Title testId="outer" />
        <ConversationProvider store={inner}>
          <Title testId="inner" />
        </ConversationProvider>
      </ConversationProvider>,
    );
    await act(() =>
      outer.applyEvent(titleEvent(1, "Outer", "conversation_outer")),
    );
    expect(screen.getByTestId("outer").textContent).toBe("Outer");
    expect(screen.getByTestId("inner").textContent).toBe("");

    await act(() =>
      inner.applyEvent(titleEvent(1, "Inner", "conversation_inner")),
    );
    expect(screen.getByTestId("outer").textContent).toBe("Outer");
    expect(screen.getByTestId("inner").textContent).toBe("Inner");
  });

  it("uses the stable store snapshot during server rendering", async () => {
    const store = createConversationStore();
    await store.applyEvent(titleEvent(1, "Server title"));
    const initialSnapshot = store.getSnapshot();

    function ServerConsumer() {
      const snapshot = useConversationSnapshot();
      expect(snapshot).toBe(initialSnapshot);
      return <span>{snapshot.title}</span>;
    }

    expect(
      renderToString(
        <ConversationProvider store={store}>
          <ServerConsumer />
        </ConversationProvider>,
      ),
    ).toContain("Server title");
  });

  it("creates and destroys an owned store once across StrictMode lifecycle replay", async () => {
    const baseStore = createConversationStore();
    let activeSubscriptions = 0;
    let maximumActiveSubscriptions = 0;
    const destroy = vi.fn(baseStore.destroy);
    const ownedStore: ConversationStore = {
      ...baseStore,
      subscribe(listener) {
        activeSubscriptions += 1;
        maximumActiveSubscriptions = Math.max(
          maximumActiveSubscriptions,
          activeSubscriptions,
        );
        const unsubscribe = baseStore.subscribe(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          activeSubscriptions -= 1;
          unsubscribe();
        };
      },
      destroy,
    };
    const create = vi.fn(() => ownedStore);

    function Consumer() {
      useConversationSnapshot();
      return null;
    }

    const view = render(
      <StrictMode>
        <ConversationProvider create={create}>
          <Consumer />
        </ConversationProvider>
      </StrictMode>,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(maximumActiveSubscriptions).toBe(1);
    expect(activeSubscriptions).toBe(1);
    expect(destroy).not.toHaveBeenCalled();

    view.unmount();
    await act(async () => Promise.resolve());
    expect(activeSubscriptions).toBe(0);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("never destroys an externally supplied runtime", () => {
    const store = createConversationStore();
    const { runtime, destroy } = fakeRuntime<unknown>(store);
    const view = render(
      <ConversationProvider runtime={runtime}>
        <span>External runtime</span>
      </ConversationProvider>,
    );

    view.unmount();
    expect(destroy).not.toHaveBeenCalled();
    expect(store.getSnapshot().revision).toBeNull();
  });

  it("lets two simultaneous presentations observe the same runtime", async () => {
    const store = createConversationStore();
    const { runtime } = fakeRuntime<unknown>(store);

    function Presentation({ children }: { children: ReactNode }) {
      const title = useConversationSelector((state) => state.title);
      return <span data-testid={String(children)}>{title}</span>;
    }

    render(
      <ConversationProvider runtime={runtime}>
        <Presentation>dialog</Presentation>
        <Presentation>drawer</Presentation>
      </ConversationProvider>,
    );
    await act(() => store.applyEvent(titleEvent(1, "Shared runtime")));

    expect(screen.getByTestId("dialog").textContent).toBe("Shared runtime");
    expect(screen.getByTestId("drawer").textContent).toBe("Shared runtime");
  });

  it("reports that runtime actions need a runtime-backed provider", () => {
    const store = createConversationStore();
    let send: (() => void) | undefined;
    function StoreActions() {
      const actions = useConversationActions();
      send = () => {
        void actions.sendMessage({ content: "hello", request: undefined });
      };
      return null;
    }
    render(
      <ConversationProvider store={store}>
        <StoreActions />
      </ConversationProvider>,
    );

    expect(send).toBeDefined();
    expect(() => send?.()).toThrow(/runtime actions require/u);
  });
});
