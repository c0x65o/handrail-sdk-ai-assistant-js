/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationCatalogError,
  ConversationLocalErasureError,
  DEFAULT_CONVERSATION_CATALOG_ORDER,
  type ConversationCatalog,
  type ConversationCatalogCursor,
  type ConversationCatalogDescriptor,
  type ConversationCatalogIdempotencyKey,
  type ConversationCatalogVersion,
  type ConversationId,
} from "../src/index.js";
import {
  ConversationPickerArchive,
  ConversationPickerClear,
  ConversationPickerCreateForm,
  ConversationPickerEmpty,
  ConversationPickerErrorMessage,
  ConversationPickerItem,
  ConversationPickerList,
  ConversationPickerLoading,
  ConversationPickerLoadMore,
  ConversationPickerPermanentDelete,
  ConversationPickerRenameForm,
  ConversationPickerRestore,
  ConversationPickerRoot,
  ConversationPickerSelect,
  useConversationPicker,
  type ConversationPickerController,
  type ConversationPickerConfirmation,
  type ConversationPickerIdempotencyKeyFactory,
  type ConversationPickerOpenHandler,
  type ConversationPickerRuntimeRegistry,
  type UseConversationPickerOptions,
} from "../src/react/index.js";

afterEach(() => cleanup());

it("removes a confirmed deletion and offers a device-only retry when cleanup fails", async () => {
  const cleanupLocal = vi.fn(async () => {});
  cleanupLocal.mockRejectedValueOnce(new Error("still unavailable"));
  const catalog = createCatalog({ permanentlyDelete: vi.fn(async input => {
    throw new ConversationLocalErasureError({ operation: "permanent_delete", status: "deleted",
      conversationId: input.conversationId, deletedVersion: input.expectedVersion }, cleanupLocal);
  }) });
  render(<Harness catalog={catalog} authorizationContext={{ subject: "owner" }} confirm={async () => true} />);
  await waitFor(() => expect(latestController.items).toHaveLength(1));
  await act(() => latestController.permanentlyDeleteConversation({ descriptor: latestController.items[0]!, idempotencyKey: "delete-device" as never }));
  expect(latestController.items).toHaveLength(0);
  expect(screen.getByRole("alert").textContent).toContain("conversation was deleted");
  fireEvent.click(screen.getByRole("button", { name: "Retry device cleanup" }));
  await waitFor(() => expect(cleanupLocal).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((screen.getByRole("button", { name: "Retry device cleanup" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Retry device cleanup" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(cleanupLocal).toHaveBeenCalledTimes(2); expect(catalog.permanentlyDelete).toHaveBeenCalledOnce();
});

interface Authorization {
  readonly subject: string;
}

const supported = Object.freeze({ supported: true as const });
const capabilities = Object.freeze({
  rename: supported,
  clear: supported,
  archive: supported,
  restore: supported,
  permanentDelete: supported,
});

function descriptor(
  id: string,
  title = id,
  version = 1,
  lifecycle: "active" | "archived" = "active",
): ConversationCatalogDescriptor {
  const base = {
    conversationId: id as ConversationId,
    title,
    createdAt: "2026-08-29T00:00:00.000Z" as never,
    updatedAt: `2026-08-29T00:00:0${Math.min(version, 9)}.000Z` as never,
    version: version as ConversationCatalogVersion,
    metadata: Object.freeze({}),
  };
  return lifecycle === "archived"
    ? Object.freeze({
      ...base,
      lifecycle: "archived" as const,
      archivedAt: "2026-08-29T00:01:00.000Z" as never,
    })
    : Object.freeze({ ...base, lifecycle: "active" as const, archivedAt: null });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function page(
  items: readonly ConversationCatalogDescriptor[],
  nextCursor: ConversationCatalogCursor | null = null,
) {
  return Object.freeze({
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    order: DEFAULT_CONVERSATION_CATALOG_ORDER,
  });
}

function createCatalog(
  overrides: Partial<ConversationCatalog<Authorization>> = {},
): ConversationCatalog<Authorization> {
  const first = descriptor("conversation_a", "Alpha");
  return {
    capabilities,
    list: vi.fn<ConversationCatalog<Authorization>["list"]>(async () => page([first])),
    create: vi.fn<ConversationCatalog<Authorization>["create"]>(async () => ({
      operation: "create",
      status: "created",
      descriptor: first as Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
    })),
    get: vi.fn<ConversationCatalog<Authorization>["get"]>(async () => ({
      operation: "get", status: "found", descriptor: first,
    })),
    rename: vi.fn<ConversationCatalog<Authorization>["rename"]>(async () => ({
      operation: "rename", status: "updated", descriptor: first,
    })),
    clear: vi.fn<ConversationCatalog<Authorization>["clear"]>(async () => ({
      operation: "clear",
      status: "cleared",
      descriptor: first as Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
    })),
    archive: vi.fn<ConversationCatalog<Authorization>["archive"]>(async () => ({
      operation: "archive",
      status: "archived",
      descriptor: descriptor(first.conversationId, first.title ?? "", 2, "archived") as
        Extract<ConversationCatalogDescriptor, { lifecycle: "archived" }>,
    })),
    restore: vi.fn<ConversationCatalog<Authorization>["restore"]>(async () => ({
      operation: "restore",
      status: "restored",
      descriptor: first as Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
    })),
    permanentlyDelete: vi.fn<ConversationCatalog<Authorization>["permanentlyDelete"]>(async () => ({
      operation: "permanent_delete",
      status: "deleted",
      conversationId: first.conversationId,
      deletedVersion: first.version,
    })),
    ...overrides,
  };
}

let latestController: ConversationPickerController;

function Harness<T>(props: UseConversationPickerOptions<Authorization, T>) {
  const controller = useConversationPicker(props);
  latestController = controller;
  return (
    <ConversationPickerRoot controller={controller} aria-label="Conversation history">
      <ConversationPickerLoading />
      <ConversationPickerErrorMessage />
      <ConversationPickerEmpty />
      <ConversationPickerList />
      <ConversationPickerLoadMore />
    </ConversationPickerRoot>
  );
}

function CompositionHarness<T>(
  props: UseConversationPickerOptions<Authorization, T> & {
    readonly renderContent: (controller: ConversationPickerController) => ReactNode;
  },
) {
  const { renderContent, ...options } = props;
  const controller = useConversationPicker(options);
  latestController = controller;
  return (
    <ConversationPickerRoot controller={controller}>
      {renderContent(controller)}
    </ConversationPickerRoot>
  );
}

describe("useConversationPicker", () => {
  it("loads and appends cursor pages deterministically without duplicate or reordered rows", async () => {
    const authorizationContext = Object.freeze({ subject: "owner" });
    const firstPage = deferred<ReturnType<typeof page>>();
    const secondPage = deferred<ReturnType<typeof page>>();
    const list = vi.fn()
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise);
    const catalog = createCatalog({ list });
    const open = vi.fn(async () => undefined);
    render(<Harness catalog={catalog} authorizationContext={authorizationContext} onOpen={open} />);

    expect(screen.getByRole("status").textContent).toBe("Loading conversations…");
    expect(screen.getByRole("button", { name: "Load more conversations" }).hasAttribute("disabled"))
      .toBe(true);
    firstPage.resolve(page([
      descriptor("conversation_a", "Alpha"),
      descriptor("conversation_b", "Beta"),
    ], "cursor_2" as ConversationCatalogCursor));
    await waitFor(() => expect(screen.queryByText("Loading conversations…")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open conversation: Alpha" }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Load more conversations" }));
    expect(screen.getByRole("status").textContent).toBe("Loading more conversations…");
    secondPage.resolve(page([
      descriptor("conversation_b", "Duplicate beta"),
      descriptor("conversation_c", "Gamma"),
    ]));

    await waitFor(() => expect(within(screen.getByRole("list", { name: "Conversations" }))
      .getAllByRole("listitem").map((item) => item.getAttribute("data-conversation-id")))
      .toEqual(["conversation_a", "conversation_b", "conversation_c"]));
    expect(screen.getByRole("button", { name: "Open conversation: Alpha" })
      .getAttribute("aria-current")).toBe("true");
    expect(list.mock.calls[1]?.[0]).toEqual({
      authorizationContext,
      lifecycle: "active",
      pageSize: 50,
      order: DEFAULT_CONVERSATION_CATALOG_ORDER,
      cursor: "cursor_2",
    });
  });

  it("keeps selection through refresh and clears it only when an exhausted result omits it", async () => {
    const selected = descriptor("conversation_a", "Alpha");
    const list = vi.fn()
      .mockResolvedValueOnce(page([selected]))
      .mockResolvedValueOnce(page([descriptor("conversation_a", "Renamed alpha", 2)]))
      .mockResolvedValueOnce(page([descriptor("conversation_b", "Beta")]));
    render(<Harness catalog={createCatalog({ list })} authorizationContext={{ subject: "owner" }} />);
    await screen.findByRole("button", { name: "Open conversation: Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation: Alpha" }));
    await waitFor(() => expect(latestController.selectedConversationId).toBe(selected.conversationId));

    await act(async () => latestController.refresh());
    expect(latestController.selectedConversationId).toBe(selected.conversationId);
    expect(latestController.selectedConversation?.title).toBe("Renamed alpha");
    await act(async () => latestController.refresh());
    expect(latestController.selectedConversationId).toBeNull();
  });

  it("distinguishes empty, refreshing, and initial loading states", async () => {
    const refreshed = deferred<ReturnType<typeof page>>();
    const list = vi.fn()
      .mockResolvedValueOnce(page([]))
      .mockReturnValueOnce(refreshed.promise);
    render(<Harness catalog={createCatalog({ list })} authorizationContext={{ subject: "owner" }} />);
    await screen.findByText("No conversations.");
    expect(screen.getByRole("status").textContent).toBe("No conversations.");
    const refreshPromise = latestController.refresh();
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("Refreshing conversations…"));
    expect(latestController.isInitialLoading).toBe(false);
    expect(latestController.isRefreshing).toBe(true);
    refreshed.resolve(page([]));
    await act(async () => refreshPromise);
    expect(screen.getByRole("status").textContent).toBe("No conversations.");
  });

  it("dispatches every operation with exact auth, identity, version, and idempotency values", async () => {
    const authorizationContext = Object.freeze({ subject: "exact-owner" });
    const current = descriptor("conversation_exact", "Exact", 7);
    const created = descriptor("conversation_created", "Created", 1);
    const renamed = descriptor(current.conversationId, "Renamed", 8);
    const create = vi.fn<ConversationCatalog<Authorization>["create"]>(async () => ({
      operation: "create" as const,
      status: "created" as const,
      descriptor: created as Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
    }));
    const rename = vi.fn<ConversationCatalog<Authorization>["rename"]>(async () => ({
      operation: "rename" as const,
      status: "updated" as const,
      descriptor: renamed,
    }));
    const catalog = createCatalog({ list: vi.fn(async () => page([current])), create, rename });
    const runtimeRegistry = {
      open: vi.fn<ConversationPickerRuntimeRegistry<Authorization, { runtime: boolean }>["open"]>(
        async () => ({ runtime: true }),
      ),
      release: vi.fn(async () => true),
      clear: vi.fn(async (input) => ({
        operation: "clear" as const,
        status: "cleared" as const,
        descriptor: descriptor(input.conversationId, "Exact", 8) as
          Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
      })),
      archive: vi.fn(async (input) => ({
        operation: "archive" as const,
        status: "archived" as const,
        descriptor: descriptor(input.conversationId, "Exact", 8, "archived") as
          Extract<ConversationCatalogDescriptor, { lifecycle: "archived" }>,
      })),
      restore: vi.fn(async (input) => ({
        operation: "restore" as const,
        status: "restored" as const,
        descriptor: descriptor(input.conversationId, "Exact", 8) as
          Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
      })),
      permanentlyDelete: vi.fn(async (input) => ({
        operation: "permanent_delete" as const,
        status: "deleted" as const,
        conversationId: input.conversationId,
        deletedVersion: input.expectedVersion,
      })),
    } satisfies ConversationPickerRuntimeRegistry<Authorization, { runtime: boolean }>;
    const factoryKey = "factory-create" as ConversationCatalogIdempotencyKey;
    const keyFactory = vi.fn<ConversationPickerIdempotencyKeyFactory>(() => factoryKey);
    const confirm = vi.fn<ConversationPickerConfirmation>(async () => true);
    const onOpen = vi.fn<ConversationPickerOpenHandler<Authorization, { runtime: boolean }>>(
      async () => undefined,
    );
    render(
      <Harness
        catalog={catalog}
        authorizationContext={authorizationContext}
        runtimeRegistry={runtimeRegistry}
        idempotencyKeyFactory={keyFactory}
        confirm={confirm}
        onOpen={onOpen}
      />,
    );
    await screen.findByText("Exact");

    await act(async () => latestController.createConversation({
      conversationId: created.conversationId,
      title: "Created",
      metadata: { category: "safe" },
    }));
    expect(create.mock.calls[0]?.[0]).toEqual({
      authorizationContext,
      conversationId: created.conversationId,
      title: "Created",
      metadata: { category: "safe" },
      idempotencyKey: factoryKey,
    });
    expect(keyFactory.mock.calls[0]?.[0]).toEqual({
      operation: "create",
      conversationId: created.conversationId,
    });

    const renameKey = "rename-exact" as ConversationCatalogIdempotencyKey;
    await act(async () => latestController.renameConversation({
      descriptor: current,
      title: "Renamed",
      idempotencyKey: renameKey,
    }));
    expect(rename.mock.calls[0]?.[0]).toEqual({
      authorizationContext,
      conversationId: current.conversationId,
      expectedVersion: current.version,
      idempotencyKey: renameKey,
      title: "Renamed",
    });

    await act(async () => latestController.openConversation(current));
    expect(runtimeRegistry.open.mock.calls[0]?.[0]).toEqual({
      authorizationContext,
      conversationId: current.conversationId,
    });
    expect(onOpen.mock.calls[0]?.[0]?.authorizationContext).toBe(authorizationContext);
    expect(onOpen.mock.calls[0]?.[0]?.descriptor).toBe(current);
    expect(onOpen.mock.calls[0]?.[0]?.runtime).toEqual({ runtime: true });

    const lifecycleCases = [
      ["clearConversation", "clear", "clear-exact"],
      ["archiveConversation", "archive", "archive-exact"],
      ["restoreConversation", "restore", "restore-exact"],
      ["permanentlyDeleteConversation", "permanentlyDelete", "delete-exact"],
    ] as const;
    for (const [controllerMethod, registryMethod, keyValue] of lifecycleCases) {
      const key = keyValue as ConversationCatalogIdempotencyKey;
      await act(async () => latestController[controllerMethod]({
        descriptor: current,
        idempotencyKey: key,
      }));
      expect(runtimeRegistry[registryMethod].mock.calls[0]?.[0]).toEqual({
        authorizationContext,
        conversationId: current.conversationId,
        expectedVersion: current.version,
        idempotencyKey: key,
      });
    }
    expect(confirm.mock.calls.map((call) => call[0].operation)).toEqual([
      "clear",
      "archive",
      "permanent_delete",
    ]);
  });

  it("does not mutate when confirmation is cancelled and disables unsupported actions", async () => {
    const current = descriptor("conversation_limited", "Limited");
    const archive = vi.fn();
    const catalog = createCatalog({
      capabilities: {
        ...capabilities,
        archive: { supported: false, reason: "policy_disabled" },
      },
      list: vi.fn(async () => page([current])),
      archive,
    });
    const confirm = vi.fn(async () => false);
    render(
      <Harness catalog={catalog} authorizationContext={{ subject: "owner" }} confirm={confirm} />,
    );
    await screen.findByText("Limited");
    await act(async () => latestController.clearConversation({
      descriptor: current,
      idempotencyKey: "clear-cancelled" as ConversationCatalogIdempotencyKey,
    }));
    expect(catalog.clear).not.toHaveBeenCalled();

    cleanup();
    const controller = { ...latestController, operation: null };
    render(
      <ConversationPickerRoot controller={controller}>
        <ConversationPickerItem descriptor={current}>
          <ConversationPickerArchive idempotencyKey={"archive-key" as ConversationCatalogIdempotencyKey} />
        </ConversationPickerItem>
      </ConversationPickerRoot>,
    );
    const button = screen.getByRole("button", { name: "Archive conversation: Limited" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(archive).not.toHaveBeenCalled();
  });

  it("normalizes unknown failures and never renders authorization or native error details", async () => {
    const authorizationContext = { subject: "secret-subject" };
    const list = vi.fn(async () => {
      throw new Error("provider secret-subject token abc");
    });
    render(<Harness catalog={createCatalog({ list })} authorizationContext={authorizationContext} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The conversation operation could not be completed.");
    expect(document.body.textContent).not.toContain("secret-subject");
    expect(document.body.textContent).not.toContain("provider");
  });

  it("renders stable safe catalog failures without their context", async () => {
    const list = vi.fn(async () => {
      throw new ConversationCatalogError("forbidden", "list");
    });
    render(<Harness catalog={createCatalog({ list })} authorizationContext={{ subject: "private" }} />);
    expect((await screen.findByRole("alert")).textContent)
      .toBe("The conversation catalog operation is not permitted.");
  });

  it("ignores stale list and mutation results when injected inputs switch", async () => {
    const staleList = deferred<ReturnType<typeof page>>();
    const staleRename = deferred<Awaited<ReturnType<ConversationCatalog<Authorization>["rename"]>>>();
    const oldRow = descriptor("conversation_old", "Old", 1);
    const newRow = descriptor("conversation_new", "New", 1);
    const oldCatalog = createCatalog({
      list: vi.fn(() => staleList.promise),
      rename: vi.fn(() => staleRename.promise),
    });
    const newCatalog = createCatalog({ list: vi.fn(async () => page([newRow])) });
    const view = render(
      <Harness catalog={oldCatalog} authorizationContext={{ subject: "old" }} />,
    );
    view.rerender(<Harness catalog={newCatalog} authorizationContext={{ subject: "new" }} />);
    await screen.findByText("New");
    staleList.resolve(page([oldRow]));
    await act(async () => Promise.resolve());
    expect(screen.queryByText("Old")).toBeNull();

    view.rerender(<Harness catalog={oldCatalog} authorizationContext={{ subject: "old-again" }} />);
    staleList.resolve(page([oldRow]));
    // A fresh deferred list is unnecessary for the mutation race; invoke against the row directly.
    const mutationPromise = latestController.renameConversation({
      descriptor: oldRow,
      title: "Stale renamed",
      idempotencyKey: "stale-rename" as ConversationCatalogIdempotencyKey,
    });
    view.rerender(<Harness catalog={newCatalog} authorizationContext={{ subject: "new-again" }} />);
    staleRename.resolve({
      operation: "rename",
      status: "updated",
      descriptor: descriptor(oldRow.conversationId, "Stale renamed", 2),
    });
    await act(async () => mutationPromise);
    await screen.findByText("New");
    expect(screen.queryByText("Stale renamed")).toBeNull();
  });

  it("cancels stale open work and releases picker-owned runtimes on switch and unmount", async () => {
    const first = descriptor("conversation_a", "Alpha");
    const second = descriptor("conversation_b", "Beta");
    const firstOpen = deferred<{ id: string }>();
    const open = vi.fn((input: { conversationId: ConversationId }) =>
      input.conversationId === first.conversationId
        ? firstOpen.promise
        : Promise.resolve({ id: input.conversationId }));
    const release = vi.fn(async () => true);
    const runtimeRegistry = {
      open,
      release,
      clear: vi.fn(),
      archive: vi.fn(),
      restore: vi.fn(),
      permanentlyDelete: vi.fn(),
    } as unknown as ConversationPickerRuntimeRegistry<Authorization, { id: string }>;
    const cleanupOpen = vi.fn();
    const onOpen = vi.fn<ConversationPickerOpenHandler<Authorization, { id: string }>>(
      async () => cleanupOpen,
    );
    const view = render(
      <Harness
        catalog={createCatalog({ list: vi.fn(async () => page([first, second])) })}
        authorizationContext={{ subject: "owner" }}
        runtimeRegistry={runtimeRegistry}
        onOpen={onOpen}
      />,
    );
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Open conversation: Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Open conversation: Beta" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(onOpen.mock.calls[0]?.[0]?.descriptor.conversationId).toBe(second.conversationId);
    expect(release).toHaveBeenCalledWith(first.conversationId);
    firstOpen.resolve({ id: "late-alpha" });
    await act(async () => Promise.resolve());
    expect(onOpen).toHaveBeenCalledOnce();

    view.unmount();
    expect(cleanupOpen).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(second.conversationId);
  });

  it("ignores late open and mutation completion after unmount", async () => {
    const current = descriptor("conversation_late", "Late");
    const openResult = deferred<{ id: string }>();
    const renameResult = deferred<Awaited<ReturnType<ConversationCatalog<Authorization>["rename"]>>>();
    const release = vi.fn(async () => true);
    const registry = {
      open: vi.fn(() => openResult.promise),
      release,
      clear: vi.fn(),
      archive: vi.fn(),
      restore: vi.fn(),
      permanentlyDelete: vi.fn(),
    } as unknown as ConversationPickerRuntimeRegistry<Authorization, { id: string }>;
    const onOpen = vi.fn();
    const view = render(
      <Harness
        catalog={createCatalog({
          list: vi.fn(async () => page([current])),
          rename: vi.fn(() => renameResult.promise),
        })}
        authorizationContext={{ subject: "owner" }}
        runtimeRegistry={registry}
        onOpen={onOpen}
      />,
    );
    await screen.findByText("Late");
    void latestController.openConversation(current);
    void latestController.renameConversation({
      descriptor: current,
      title: "Too late",
      idempotencyKey: "late-key" as ConversationCatalogIdempotencyKey,
    });
    view.unmount();
    openResult.resolve({ id: "late" });
    renameResult.resolve({
      operation: "rename",
      status: "updated",
      descriptor: descriptor(current.conversationId, "Too late", 2),
    });
    await act(async () => Promise.resolve());
    expect(onOpen).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(current.conversationId);
  });
});

describe("ConversationPicker primitives", () => {
  it("uses semantic controls, labels, current state, native props, refs, and render overrides", async () => {
    const current = descriptor("conversation_semantic", "Semantic");
    const listRef = createRef<HTMLUListElement>();
    const itemRef = createRef<HTMLLIElement>();
    const selectRef = createRef<HTMLButtonElement>();
    const click = vi.fn();
    const catalog = createCatalog({ list: vi.fn(async () => page([current])) });
    render(
      <CompositionHarness
        catalog={catalog}
        authorizationContext={{ subject: "owner" }}
        renderContent={() => (
          <ConversationPickerList
            ref={listRef}
            data-host="list"
            render={(props, ref) => <ul {...props} ref={ref} data-rendered="list" />}
          >
            <ConversationPickerItem
              ref={itemRef}
              descriptor={current}
              data-host="item"
              render={(props, ref) => <li {...props} ref={ref} data-rendered="item" />}
            >
              <ConversationPickerSelect
                ref={selectRef}
                data-host="select"
                onClick={click}
                render={(props, ref) => <button {...props} ref={ref} data-rendered="select" />}
              />
            </ConversationPickerItem>
          </ConversationPickerList>
        )}
      />,
    );
    await screen.findByText("Semantic");
    const list = screen.getByRole("list", { name: "Conversations" });
    const item = screen.getByRole("listitem", { name: "Semantic" });
    const select = screen.getByRole("button", { name: "Open conversation: Semantic" });
    fireEvent.click(select);
    expect(click).toHaveBeenCalledOnce();
    expect(list.getAttribute("data-host")).toBe("list");
    expect(list.getAttribute("data-rendered")).toBe("list");
    expect(item.getAttribute("data-host")).toBe("item");
    expect(select.getAttribute("data-host")).toBe("select");
    expect(listRef.current).toBe(list);
    expect(itemRef.current).toBe(item);
    expect(selectRef.current).toBe(select);
    expect(select.tabIndex).toBe(0);
  });

  it("wires native create and rename forms and restores focus after mutations", async () => {
    const current = descriptor("conversation_forms", "Before", 3);
    const renamed = descriptor(current.conversationId, "After", 4);
    const create = vi.fn<ConversationCatalog<Authorization>["create"]>(async () => ({
      operation: "create" as const,
      status: "created" as const,
      descriptor: descriptor("conversation_created", "Created") as
        Extract<ConversationCatalogDescriptor, { lifecycle: "active" }>,
    }));
    const rename = vi.fn<ConversationCatalog<Authorization>["rename"]>(async () => ({
      operation: "rename" as const,
      status: "updated" as const,
      descriptor: renamed,
    }));
    render(
      <CompositionHarness
        catalog={createCatalog({ list: vi.fn(async () => page([current])), create, rename })}
        authorizationContext={{ subject: "owner" }}
        idempotencyKeyFactory={({ operation }) => `${operation}-factory` as ConversationCatalogIdempotencyKey}
        renderContent={() => <>
          <ConversationPickerCreateForm />
          <ConversationPickerItem descriptor={current}>
            <ConversationPickerRenameForm
              idempotencyKey={"rename-form" as ConversationCatalogIdempotencyKey}
            />
          </ConversationPickerItem>
        </>}
      />,
    );
    await screen.findByDisplayValue("Before");
    fireEvent.change(screen.getByRole("textbox", { name: "Conversation title" }), {
      target: { value: "Created" },
    });
    const createButton = screen.getByRole("button", { name: "Create conversation" });
    fireEvent.click(createButton);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement).toBe(createButton));

    const renameInput = screen.getByRole("textbox", { name: "Rename conversation" });
    fireEvent.change(renameInput, { target: { value: "After" } });
    const renameButton = screen.getByRole("button", { name: "Save conversation title" });
    fireEvent.click(renameButton);
    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    expect(rename.mock.calls[0]?.[0]?.expectedVersion).toBe(current.version);
    expect(rename.mock.calls[0]?.[0]?.idempotencyKey).toBe("rename-form");
    await waitFor(() => expect(document.activeElement).toBe(renameButton));
  });

  it("restores focus to the next safe control after a row-removing mutation", async () => {
    const first = descriptor("conversation_first", "First");
    const second = descriptor("conversation_second", "Second");
    const catalog = createCatalog({
      list: vi.fn(async () => page([first, second])),
      archive: vi.fn<ConversationCatalog<Authorization>["archive"]>(async () => ({
        operation: "archive",
        status: "archived",
        descriptor: descriptor(first.conversationId, "First", 2, "archived") as
          Extract<ConversationCatalogDescriptor, { lifecycle: "archived" }>,
      })),
    });
    render(
      <CompositionHarness
        catalog={catalog}
        authorizationContext={{ subject: "owner" }}
        confirm={() => true}
        renderContent={() => (
          <ConversationPickerList
            renderItem={(row) => (
              <ConversationPickerItem key={row.conversationId} descriptor={row}>
                <ConversationPickerSelect />
                <ConversationPickerArchive
                  idempotencyKey={`archive-${row.conversationId}` as ConversationCatalogIdempotencyKey}
                />
              </ConversationPickerItem>
            )}
          />
        )}
      />,
    );
    await screen.findByText("First");
    const archive = screen.getByRole("button", { name: "Archive conversation: First" });
    fireEvent.click(archive);
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Archive conversation: First",
    })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open conversation: Second" }),
    ));
  });

  it("server-renders unstyled semantic composition without running catalog work", () => {
    const current = descriptor("conversation_ssr", "Server rendered");
    const controller = {
      items: [current],
      selectedConversationId: current.conversationId,
      selectedConversation: current,
      isInitialLoading: false,
      isRefreshing: false,
      isLoadingMore: false,
      hasMore: true,
      nextCursor: "next" as ConversationCatalogCursor,
      error: null,
      operation: null,
      capabilities,
      refresh: async () => undefined,
      loadMore: async () => undefined,
      openConversation: async () => undefined,
      createConversation: async () => undefined,
      renameConversation: async () => undefined,
      clearConversation: async () => undefined,
      archiveConversation: async () => undefined,
      restoreConversation: async () => undefined,
      permanentlyDeleteConversation: async () => undefined,
      clearError: () => undefined,
    } satisfies ConversationPickerController;
    const markup = renderToString(
      <ConversationPickerRoot controller={controller}>
        <ConversationPickerList />
        <ConversationPickerLoadMore />
        <ConversationPickerCreateForm />
      </ConversationPickerRoot>,
    );
    expect(markup).toContain("<ul");
    expect(markup).toContain("<li");
    expect(markup).toContain("<button");
    expect(markup).toContain("<form");
    expect(markup).toContain("aria-current=\"true\"");
    expect(markup).not.toMatch(/<style|class=/u);
  });

  it("exposes clear, archive, restore, and delete as labeled native buttons", async () => {
    const current = descriptor("conversation_actions", "Actions");
    const archived = descriptor("conversation_archived", "Archived", 2, "archived");
    const controller = {
      items: [current, archived],
      selectedConversationId: null,
      selectedConversation: null,
      isInitialLoading: false,
      isRefreshing: false,
      isLoadingMore: false,
      hasMore: false,
      nextCursor: null,
      error: null,
      operation: null,
      capabilities,
      refresh: vi.fn(async () => undefined),
      loadMore: vi.fn(async () => undefined),
      openConversation: vi.fn(async () => undefined),
      createConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      clearConversation: vi.fn(async () => undefined),
      archiveConversation: vi.fn(async () => undefined),
      restoreConversation: vi.fn(async () => undefined),
      permanentlyDeleteConversation: vi.fn(async () => undefined),
      clearError: vi.fn(),
    } satisfies ConversationPickerController;
    render(
      <ConversationPickerRoot controller={controller}>
        <ConversationPickerItem descriptor={current}>
          <ConversationPickerClear />
          <ConversationPickerArchive />
          <ConversationPickerPermanentDelete />
        </ConversationPickerItem>
        <ConversationPickerItem descriptor={archived}>
          <ConversationPickerRestore />
        </ConversationPickerItem>
      </ConversationPickerRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear conversation: Actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive conversation: Actions" }));
    fireEvent.click(screen.getByRole("button", {
      name: "Permanently delete conversation: Actions",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Restore conversation: Archived" }));
    expect(controller.clearConversation).toHaveBeenCalledWith({ descriptor: current });
    expect(controller.archiveConversation).toHaveBeenCalledWith({ descriptor: current });
    expect(controller.permanentlyDeleteConversation).toHaveBeenCalledWith({ descriptor: current });
    expect(controller.restoreConversation).toHaveBeenCalledWith({ descriptor: archived });
  });
});
