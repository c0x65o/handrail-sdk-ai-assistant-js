/** Retained editor/snapshot content, not a JavaScript heap-size estimate. */
export const DRAFT_TEXT_LIMITS = Object.freeze({ textBytes: 65536, retainedBytes: 512 * 1024, retainedValues: 32, retainedReferences: 128 });
export class DraftTextCapacityError extends TypeError {
  constructor(readonly reason: "text" | "account") {
    super(reason === "text"
      ? "A draft can contain up to 64 KiB of text. Shorten this edit or attach a document."
      : "Drafts and active sends have reached this account’s text limit. Finish a send or clear another draft before adding more text.");
    this.name = "DraftTextCapacityError";
  }
}
export function draftTextBytes(text: string): number {
  // Reject a huge paste before allocating a second, encoded copy of its body.
  if (typeof text !== "string" || text.length > DRAFT_TEXT_LIMITS.textBytes) throw new DraftTextCapacityError("text");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > DRAFT_TEXT_LIMITS.textBytes) throw new DraftTextCapacityError("text");
  return bytes;
}
interface Value { readonly bytes: number; references: number }
interface Held { readonly owner: object; readonly text: string }
class DraftTextPool {
  private readonly values = new Map<object, Map<string, Value>>();
  private readonly tokens = new Map<object, Held>();
  private bytes = 0;
  private count = 0;
  replace(owner: object, token: object, text: string): void {
    const bytes = draftTextBytes(text), old = this.tokens.get(token);
    if (old?.text === text && old.owner === owner) return;
    const oldValue = old && this.values.get(old.owner)?.get(old.text);
    const replacingLast = oldValue?.references === 1;
    const nextValue = this.values.get(owner)?.get(text);
    const adding = Boolean(text && !nextValue);
    if (text && !old && this.tokens.size >= DRAFT_TEXT_LIMITS.retainedReferences ||
        this.bytes - (replacingLast ? oldValue.bytes : 0) + (adding ? bytes : 0) > DRAFT_TEXT_LIMITS.retainedBytes ||
        this.count - (replacingLast ? 1 : 0) + (adding ? 1 : 0) > DRAFT_TEXT_LIMITS.retainedValues) throw new DraftTextCapacityError("account");
    this.release(token);
    if (!text) return;
    const values = this.values.get(owner) ?? new Map<string, Value>();
    const current = values.get(text);
    if (current) current.references++;
    else { values.set(text, { bytes, references: 1 }); this.bytes += bytes; this.count++; }
    this.values.set(owner, values); this.tokens.set(token, { owner, text });
  }
  release(token: object): void {
    const held = this.tokens.get(token); if (!held) return;
    this.tokens.delete(token);
    const values = this.values.get(held.owner)!, value = values.get(held.text)!;
    if (--value.references === 0) { values.delete(held.text); this.bytes -= value.bytes; this.count--; }
    if (values.size === 0) this.values.delete(held.owner);
  }
}
// A standard bootstrap shares one scoped local-state store across its sessions.
// Weak keys neither mix accounts nor keep an unused account service alive.
const pools = new WeakMap<object, DraftTextPool>();
/** Internal owner shared by headless controllers and legacy standalone hooks.
 * Equal text within one owner shares a reservation; callbacks holding an older
 * value retain it independently until their actual future settles. */
export class DraftTextRetentionOwner {
  private readonly editor = {};
  private readonly pool: DraftTextPool;
  constructor(scope: object) {
    const pool = pools.get(scope) ?? new DraftTextPool(); pools.set(scope, pool); this.pool = pool;
  }
  replace(text: string): void { this.pool.replace(this, this.editor, text); }
  retain(text: string): () => void {
    const token = {}; this.pool.replace(this, token, text);
    return () => this.pool.release(token);
  }
  clear(): void { this.pool.release(this.editor); }
}
