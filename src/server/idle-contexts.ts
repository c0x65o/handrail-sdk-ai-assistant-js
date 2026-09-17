/** Retains a small idle working set. Active requests, construction and workers
 * keep their exact context; cache retirement never cancels admitted work. */
export class IdleContextRegistry {
  readonly #entries = new Map<string, { pins: number; touchedAt: number }>();
  constructor(readonly options: {
    maximumIdle?: number; idleMilliseconds?: number; now?: () => number;
    canRetire: (key: string) => boolean; retire: (key: string) => void;
  }) {}
  retain(key: string): () => void {
    const entry = this.#entries.get(key) ?? { pins: 0, touchedAt: this.#now() };
    entry.pins++; entry.touchedAt = this.#now(); this.#entries.set(key, entry);
    let released = false;
    return () => {
      if (released) return; released = true;
      entry.pins--; entry.touchedAt = this.#now(); this.sweep();
    };
  }
  touch(key: string): void {
    const entry = this.#entries.get(key) ?? { pins: 0, touchedAt: this.#now() };
    entry.touchedAt = this.#now(); this.#entries.set(key, entry);
  }
  #now() { return this.options.now?.() ?? Date.now(); }
  sweep(): void {
    const idle = [...this.#entries].filter(([key, entry]) => entry.pins === 0 && this.options.canRetire(key))
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
    let remaining = idle.length;
    for (const [key, entry] of idle) {
      if (remaining <= (this.options.maximumIdle ?? 32) && this.#now() - entry.touchedAt < (this.options.idleMilliseconds ?? 60_000)) continue;
      this.options.retire(key); this.#entries.delete(key); remaining--;
    }
  }
}
