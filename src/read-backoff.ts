/** Read-only polling backoff. Does not retry mutations or grant admission. */
export class ReadBackoff {
  private failures = 0;
  private until = 0;
  generation = 0;
  terminal = false;
  get remaining(): number { return Math.max(0, this.until - Date.now()); }
  succeeded(generation = this.generation): void {
    // An older successful read cannot erase a newer concurrent failure/hint.
    if (generation !== this.generation) return;
    this.failures = 0; this.until = 0; this.terminal = false;
  }
  failed(cause: unknown): void {
    this.generation++;
    const error = cause && typeof cause === "object" ? cause as { retryable?: boolean; retryAfterMs?: number } : {};
    this.terminal ||= error.retryable === false;
    const hint = typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
      ? Math.min(2_147_483_647, Math.max(0, error.retryAfterMs)) : 0;
    this.until = Math.max(this.until, Date.now() + Math.max(hint, Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5))));
  }
}
