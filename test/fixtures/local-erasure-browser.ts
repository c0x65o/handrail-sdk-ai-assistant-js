import { IndexedDBApplicationConversationPendingStore } from "../../dist/browser/index.js";
import { prepareApplicationConversationSubmission } from "../../dist/client/index.js";

export const createStore = (scope: string) => new IndexedDBApplicationConversationPendingStore({ scope });
export const draftFile = (id: string, conversationId = "chat") => ({ id, selection: {
  source: new Blob([new Uint8Array([11, 22, 33])], { type: "application/pdf" }),
  kind: "document" as const, mediaType: "application/pdf" as const, byteSize: 3, filename: `${id}.pdf`,
  fingerprint: `file:${id}`, idempotencyKey: `upload:${id}`, conversationId,
} });
export const submission = () => prepareApplicationConversationSubmission({
  conversationId: "chat" as never, clientId: "client" as never, revision: 0,
  operationId: "browser-erasure", now: "2026-09-17T00:00:00.000Z",
  input: { content: "Synthetic pending message", request: { text: "Synthetic pending message" } },
});
