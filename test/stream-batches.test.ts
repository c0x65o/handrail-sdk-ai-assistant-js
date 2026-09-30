import { expect, it } from "vitest";
import { streamBatches } from "../src/stream-batches.js";

it("bounds bursts and preserves non-text barriers and every original item", async () => {
  const input = ["start", ...Array.from({ length: 140 }, () => "text"), "tool", "text", "done"];
  const output: (readonly string[])[] = [];
  for await (const batch of streamBatches((async function* () { yield* input; })(), value => value === "text")) output.push(batch);
  expect(output.map(batch => batch.length)).toEqual([1, 64, 64, 12, 1, 1, 1]);
  expect(output.flat()).toEqual(input);
});

it("flushes received text before waiting on a quiet provider or reporting its failure", async () => {
  let reject!: (cause: unknown) => void;
  const held = new Promise<never>((_, fail) => { reject = fail; });
  const source = (async function* () { yield "text"; await held; })();
  const batches = streamBatches(source, () => true);
  expect(await batches.next()).toEqual({ done: false, value: ["text"] });
  reject(new Error("disconnected"));
  await expect(batches.next()).rejects.toThrow("disconnected");
});

it("does not advance past a tool or approval barrier before its consumer resumes", async () => {
  let advanced = false;
  const source = (async function* () { yield "tool"; advanced = true; yield "text"; })();
  const batches = streamBatches(source, value => value === "text");
  expect(await batches.next()).toEqual({ done: false, value: ["tool"] });
  await Promise.resolve();
  expect(advanced).toBe(false);
  expect(await batches.next()).toEqual({ done: false, value: ["text"] });
  expect(advanced).toBe(true);
  await batches.return(undefined);
});
