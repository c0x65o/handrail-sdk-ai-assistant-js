import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { postgres, type PostgresPoolLike } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { createHandrailAiClient } from "../src/client/index.js";
import { InMemoryConversationCatalog, type ConversationCatalogCapabilities } from "../src/index.js";
import { ConversationPickerRoot, ConversationPickerItem, ConversationPickerArchive, ConversationPickerClear,
  ConversationPickerPermanentDelete, ConversationPickerRestore,
  useConversationPicker } from "../src/react/index.js";
import type { ConversationCatalog, ConversationCatalogDescriptor } from "../src/index.js";

type Context = HandrailAssistantAuthorizationContext;
const supported = { rename: { supported: true }, clear: { supported: true }, archive: { supported: true },
  restore: { supported: true }, permanentDelete: { supported: true } } as const;
const unsupported: ConversationCatalogCapabilities = {
  rename: { supported: false, reason: "not_implemented" }, clear: { supported: false, reason: "storage_limitation" },
  archive: { supported: false, reason: "policy_disabled" }, restore: { supported: false, reason: "not_implemented" },
  permanentDelete: { supported: false, reason: "policy_disabled" },
};
const context = (principalId: string): Context => ({ principalId, tenantId: "tenant", scopeId: "shared",
  attribution: {
    organization: { id: "org", source: "server_derived", trust: "authoritative" },
    project: { id: "project", source: "server_derived", trust: "authoritative" },
    service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
    known_user: { id: principalId, source: "server_derived", trust: "authoritative" },
    session: { id: null, source: "server_derived", trust: "authoritative" },
    automation: { id: null, source: "server_derived", trust: "authoritative" },
  },
});

async function fixture(hostCatalog = true) {
  const target = new InMemoryConversationCatalog<Context>({ authorize: () => "allow" });
  const created = await target.create({ authorizationContext: context("reader"), conversationId: "conversation" as never,
    title: "Shared", idempotencyKey: "create" as never });
  const rename = vi.spyOn(target, "rename");
  let currentCapabilities = unsupported;
  const catalogFor = vi.fn(({ context: authorized }: { context: Context }): ConversationCatalog<Context> => ({
    capabilities: authorized.principalId === "editor" ? supported : currentCapabilities,
    list: target.list.bind(target), create: target.create.bind(target), get: target.get.bind(target),
    rename: target.rename.bind(target), clear: target.clear.bind(target), archive: target.archive.bind(target),
    restore: target.restore.bind(target), permanentlyDelete: target.permanentlyDelete.bind(target),
  }));
  // Negotiation does not exercise persistence; this is the existing injected SQL boundary.
  const pool: PostgresPoolLike = {
    async query<TRow extends Record<string, unknown>>() { return { rows: [] as TRow[], rowCount: 0 }; },
    async connect() { throw new Error("not used"); },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let readerStarted!: () => void;
  const started = new Promise<void>((resolve) => { readerStarted = resolve; });
  const assistant = await createHandrailAssistant({ id: "catalog", persistence: postgres(pool),
    recoverPendingOnContext: false, automaticTitles: false,
    authorize: (request) => {
      const user = request.headers.get("x-user");
      if (!user) throw new Error("unauthenticated");
      return context(user);
    },
    ...(hostCatalog ? { conversationCatalogFor: catalogFor } : {}),
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, async createTransport({ context: authorized }) {
      if (authorized.principalId === "reader") { readerStarted(); await gate; }
      return { capabilities: {
        authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
      }, async startTurn() { throw new Error("not used"); }, async resumeTurn() { throw new Error("not used"); } };
    } },
  });
  const client = (user: string) => createHandrailAiClient({ baseUrl: "https://example.test/ai", startActivityPolling: false,
    fetch: (input, init) => assistant.handle(new Request(input, init)),
    protectedRequest: (input) => ({ ...input, headers: { "x-user": user } }),
  });
  return { assistant, client, started, release, catalogFor, rename, descriptor: created.descriptor,
    setCapabilities: (value: ConversationCatalogCapabilities) => { currentCapabilities = value; } };
}

function Actions({ catalog, descriptor }: { catalog: ConversationCatalog<unknown>; descriptor: ConversationCatalogDescriptor }) {
  const controller = useConversationPicker({ catalog, authorizationContext: undefined, onOpen: async () => undefined });
  return <ConversationPickerRoot controller={controller}>
    <ConversationPickerItem descriptor={descriptor}>
      <ConversationPickerClear /><ConversationPickerArchive />
      <ConversationPickerPermanentDelete />
    </ConversationPickerItem>
    <ConversationPickerItem descriptor={{ ...descriptor, lifecycle: "archived", archivedAt: descriptor.updatedAt }}>
      <ConversationPickerRestore />
    </ConversationPickerItem>
  </ConversationPickerRoot>;
}

describe("assistant host catalog negotiation", () => {
  it("isolates concurrent authenticated negotiations and refreshes actions and reasons for the same identity", async () => {
    const f = await fixture();
    const readerPending = f.client("reader");
    await f.started;
    const editor = await f.client("editor");
    f.release();
    const reader = await readerPending;
    try {
      expect(editor.catalog.capabilities).toEqual(supported);
      expect(reader.capabilities.resources?.conversations).toEqual(unsupported);
      expect(reader.catalog.capabilities).toEqual(unsupported);
      // The existing client and UI consume the actual negotiated capability object.
      const buttons = (catalog: ConversationCatalog<unknown>) =>
        renderToString(<Actions catalog={catalog} descriptor={f.descriptor} />).match(/<button\b[^>]*>/gu)!;
      expect(buttons(reader.catalog)).toHaveLength(4);
      for (const button of buttons(reader.catalog)) expect(button).toContain('disabled=""');
      for (const button of buttons(editor.catalog)) expect(button).not.toContain('disabled=""');
      expect(f.rename).not.toHaveBeenCalled();
      // Mutation authority still comes from this request, even if the body supplies another identity.
      const response = await f.assistant.handle(new Request("https://example.test/ai/conversations/rename", {
        method: "POST", headers: { "x-user": "editor", "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "conversation", expectedVersion: 1, idempotencyKey: "rename",
          title: "Renamed", authorizationContext: context("forged") }),
      }));
      expect(response.status).toBe(200);
      expect(f.rename).toHaveBeenCalledWith(expect.objectContaining({ authorizationContext: context("editor") }));
      f.setCapabilities({ ...unsupported, rename: supported.rename });
      const fresh = await f.client("reader");
      expect(fresh.catalog.capabilities).toEqual({ ...unsupported, rename: supported.rename });
      await fresh.dispose();
      f.catalogFor.mockClear();
      expect((await f.assistant.handle(new Request("https://example.test/ai/capabilities"))).status).toBe(403);
      expect(f.catalogFor).not.toHaveBeenCalled();
    } finally { await reader.dispose(); await editor.dispose(); f.assistant.stopUsageWorker(); }
  });

  it("preserves supported default Postgres catalog negotiation", async () => {
    const f = await fixture(false);
    const client = await f.client("editor");
    try { expect(client.catalog.capabilities).toEqual(supported); }
    finally { await client.dispose(); f.assistant.stopUsageWorker(); }
  });
});
