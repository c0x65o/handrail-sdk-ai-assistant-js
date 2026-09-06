export interface IndependentReadCall { readonly name: string; readonly arguments: unknown }
export type IndependentReadResult<T> =
  | { readonly index: number; readonly name: string; readonly ok: true; readonly value: T }
  | { readonly index: number; readonly name: string; readonly ok: false; readonly error: string };

/** Batches only independently authorized reads. Domain writes belong in transactional bulk tools. */
export async function runIndependentReadBatch<T>(options: {
  readonly calls: readonly IndependentReadCall[];
  readonly isReadAllowed: (name: string) => boolean;
  readonly execute: (call: IndependentReadCall, signal: AbortSignal) => Promise<T>;
  readonly signal: AbortSignal;
  readonly parallelism?: number;
}): Promise<readonly IndependentReadResult<T>[]> {
  const parallelism = options.parallelism ?? 3;
  if (options.calls.length < 1 || options.calls.length > 10 || !Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 4) {
    throw new RangeError("Read batches require 1 to 10 calls and parallelism between 1 and 4");
  }
  // Authorize the entire batch before starting any work, and snapshot mutable caller inputs.
  const calls = structuredClone(options.calls);
  if (calls.some((call) => !options.isReadAllowed(call.name))) throw new TypeError("Batch contains an unauthorized read");
  const results: IndependentReadResult<T>[] = [];
  for (let offset = 0; offset < calls.length; offset += parallelism) {
    options.signal.throwIfAborted();
    const group = await Promise.all(calls.slice(offset, offset + parallelism).map(async (call, index): Promise<IndependentReadResult<T>> => {
      try {
        const value = await options.execute(call, options.signal);
        return { index: offset + index, name: call.name, ok: true, value };
      } catch {
        return { index: offset + index, name: call.name, ok: false, error: "Read failed. Retry this read individually for details." };
      }
    }));
    results.push(...group);
  }
  options.signal.throwIfAborted();
  return results;
}
