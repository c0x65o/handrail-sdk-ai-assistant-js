import { createRoot } from "react-dom/client";
import { ConversationWorkspace, ConversationRuntimeRegistry, InMemoryConversationCatalog,
  InMemoryConversationEventStore, createConversationRuntime, parseConversationEvent,
  createAttachmentUploader, type ConversationId } from "../../dist/index.js";
import { HandrailChatWorkspace } from "../../dist/react-styled/index.js";

// Synthetic component fixture. Server singleton/authorization are tested in PGlite.
void (async () => {
  const context = { account: "synthetic" };
  const catalog = new InMemoryConversationCatalog<typeof context>({ authorize: () => "allow",
    createConversationId: () => "single" as ConversationId });
  const row = (await catalog.create({ authorizationContext: context, title: "Hidden legacy title", idempotencyKey: "seed" as never })).descriptor;
  const events = new InMemoryConversationEventStore();
  let revision = 0;
  const append = async (payload: unknown) => events.append({ conversationId: row.conversationId,
    expectedRevision: revision === 0 ? null : revision as never,
    events: [parseConversationEvent({ version: 1, conversation_id: row.conversationId, event_id: `event-${++revision}`,
      revision, occurred_at: new Date().toISOString(), actor: { type: "system" }, source: { type: "runtime" }, payload })] });
  await append({ type: "message.created", message_id: "old", role: "assistant",
    content: [{ type: "text", text: "Your saved conversation is ready." }] });
  const clear = catalog.clear.bind(catalog);
  catalog.clear = async input => {
    const result = await clear(input);
    if (result.status === "cleared") await append({ type: "conversation.cleared" });
    return result;
  };
  const workspace = new ConversationWorkspace(new ConversationRuntimeRegistry({ catalog, authorize: () => "allow",
    createRuntime: ({ conversationId }) => createConversationRuntime({ conversationId, clientId: "browser" as never,
      eventStore: events, transport: {} as never }) }));
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("unused"); } });
  createRoot(document.getElementById("root")!).render(<HandrailChatWorkspace threads={false} showConversationTitle
    workspace={workspace} title="Family Assistant" layout="page"
    theme={{ colors: { accent: "#ad6844", background: "#fffcf6", panel: "#f8f2e8", text: "#4b433a" } }}
    catalogOptions={{ catalog, authorizationContext: context }}
    composerForConversation={() => ({ uploader, conversationId: row.conversationId, createRequest: () => ({}) })}
    attachmentsEnabled={false} approvals={false} transcription={false}/>);
})();
