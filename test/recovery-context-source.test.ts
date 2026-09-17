import { expect, it, vi } from "vitest";
import { RecoveryContextSourceScanner } from "../src/server/recovery-context-source.js";

it("visits identities beyond the legacy prefix in bounded pages and re-resolves retained work", async () => {
  const keys = Array.from({ length: 161 }, (_, index) => `account-${index}`);
  let role = "writer";
  const accepted: string[] = [];
  const resolvers = new Map<string, (signal: AbortSignal) => Promise<{ key: string; role: string } | null>>();
  const page = vi.fn(async ({ cursor, limit }: { cursor: string | null; limit: number }) => {
    const offset = Number(cursor ?? 0), next = offset + limit;
    return { keys: keys.slice(offset, next), cursor: next < keys.length ? String(next) : null };
  });
  const resolve = vi.fn(async (key: string) => ({ key, role }));
  const scanner = new RecoveryContextSourceScanner({ page, resolve }, (context, fresh) => {
    accepted.push(context.key); resolvers.set(context.key, fresh); return true;
  });
  for (let index = 0; index < 6; index++) await scanner.scan();
  expect(accepted).toEqual(keys);
  expect(page.mock.calls.map(([input]) => input.cursor)).toEqual([null, "32", "64", "96", "128", "160"]);
  expect(page.mock.calls.every(([input]) => input.limit === 32)).toBe(true);
  role = "reader";
  expect(await resolvers.get("account-160")!(new AbortController().signal)).toEqual({ key: "account-160", role: "reader" });
  await scanner.scan();
  expect(page.mock.calls.at(-1)?.[0].cursor).toBeNull();
  await scanner.stop();
});

it("coalesces held source reads, retries a full queue and joins an aborted lookup", async () => {
  let release!: () => void, full = true;
  const held = new Promise<void>(done => { release = done; });
  const page = vi.fn(async (_input: { cursor: string | null }) => {
    void _input;
    await held; return { keys: ["account"], cursor: "next" };
  });
  const scanner = new RecoveryContextSourceScanner({ page, resolve: async key => key }, () => !full);
  const first = scanner.scan(), second = scanner.scan();
  expect(page).toHaveBeenCalledOnce(); release(); await Promise.all([first, second]);
  full = false; await scanner.scan();
  expect(page.mock.calls.map(([input]) => input.cursor)).toEqual([null, null]);
  await scanner.stop();

  let signalled = false;
  const accept = vi.fn(() => true);
  const stopping = new RecoveryContextSourceScanner({ page: async () => ({ keys: ["revoked"], cursor: null }),
    resolve: (_key, signal) => new Promise<null>(done => signal.addEventListener("abort", () => {
      signalled = true; done(null);
    }, { once: true })) }, accept);
  const pending = stopping.scan();
  await Promise.resolve();
  const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await stopping.stop(); await failed;
  expect(signalled).toBe(true); expect(accept).not.toHaveBeenCalled();
});

it.each([
  { keys: Array.from({ length: 33 }, (_, index) => String(index)), cursor: null },
  { keys: ["a", "a"], cursor: null },
  { keys: ["a"], cursor: "x".repeat(4097) },
])("rejects invalid source pages before resolving saved work", async result => {
  const resolve = vi.fn(async () => null);
  const scanner = new RecoveryContextSourceScanner({ page: async () => result, resolve }, () => true);
  await expect(scanner.scan()).rejects.toThrow("invalid page");
  expect(resolve).not.toHaveBeenCalled(); await scanner.stop();
});
