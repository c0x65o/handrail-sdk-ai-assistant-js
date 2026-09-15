import type { ConversationSyncMutationRejected } from "./types.js";

const messages: Record<ConversationSyncMutationRejected["code"], string> = {
  invalid_mutation: "This message could not be saved. Review it before sending again.",
  attachment_expired: "A file upload expired before the message was saved. Select the file again.",
  attachment_unavailable: "A selected file is no longer available. Select the file again.",
  attachment_changed: "A selected file does not match its saved upload. Select the file again.",
  attachment_invalid: "A selected file is invalid or unsupported. Select a supported file and try again.",
};

/** Typed rejection before admission. Only fixed, display-safe messages cross
 * the synchronization boundary; storage exceptions remain private. */
export class ConversationSyncMutationRejectedError extends Error {
  constructor(readonly code: ConversationSyncMutationRejected["code"]) {
    super(messages[code]);
    if (!Object.hasOwn(messages, code)) throw new TypeError("Invalid mutation rejection code");
  }
  toResult(): ConversationSyncMutationRejected {
    return Object.freeze({ status: "rejected", code: this.code, message: messages[this.code] });
  }
}
