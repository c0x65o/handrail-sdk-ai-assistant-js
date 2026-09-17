import { createHash } from "node:crypto";
import type { ConversationMessageRecord } from "../conversation/state.js";

/** Internal equality token for already validated canonical input. Length/type
 * framing preserves scalar identity without serializing an entire transcript.
 * UTF-16 chunks also distinguish lone surrogates (UTF-8 replacement does not).
 * This is not a persisted fingerprint format or an untrusted-object parser. */
export function savedInputFingerprint(input: {
  readonly messages: readonly ConversationMessageRecord[];
  readonly inputMessageIds: readonly string[];
}): string {
  const hash = createHash("sha256");
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      hash.update(`s${value.length}:`);
      for (let index = 0; index < value.length; index += 8_192) {
        hash.update(value.slice(index, index + 8_192), "utf16le");
      }
    } else if (Array.isArray(value)) {
      hash.update(`a${value.length}:`);
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      const keys = Object.keys(value).sort();
      hash.update(`o${keys.length}:`);
      for (const key of keys) { visit(key); visit((value as Record<string, unknown>)[key]); }
    } else {
      hash.update(`${typeof value}:${String(value)};`);
    }
  };
  visit(input);
  return hash.digest("hex");
}
