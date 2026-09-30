/** Bound both latency and memory without changing any frame identity. Non-text
 * events are barriers; a quiet provider never holds text beyond one frame. */
export async function* streamBatches<T>(source: AsyncIterable<T>, batchable: (value: T) => boolean,
  maximumItems = 64, milliseconds = 16): AsyncGenerator<readonly T[]> {
  const iterator = source[Symbol.asyncIterator]();
  type Step = { value: IteratorResult<T> } | { error: unknown };
  const next = (): Promise<Step> => Promise.resolve().then(() => iterator.next()).then(value => ({ value }), error => ({ error }));
  let pending = next(), done = false;
  try {
    while (!done) {
      const first = await pending;
      if ("error" in first) throw first.error;
      if (first.value.done) { done = true; break; }
      const batch = [first.value.value];
      if (!batchable(first.value.value)) {
        yield batch;
        pending = next();
        continue;
      }
      pending = next();
      {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); });
        try {
          while (batch.length < maximumItems) {
            const step = await Promise.race([pending, deadline]);
            if (!step || "error" in step || step.value.done || !batchable(step.value.value)) break;
            batch.push(step.value.value); pending = next();
          }
        } finally { clearTimeout(timer); }
      }
      yield batch;
    }
  } finally {
    // A pending read may need its transport disconnected before it can finish.
    if (!done) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

export const isTextFrame = (value: unknown): boolean => !!value && typeof value === "object" &&
  "type" in value && value.type === "response.text.delta";
