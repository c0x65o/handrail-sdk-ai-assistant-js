import { expect, it, vi } from "vitest";
import { IdleContextRegistry } from "../src/server/idle-contexts.js";

it("bounds idle context retention while protecting concurrent requests and active workers", () => {
  let time = 0;
  const busy = new Set(["worker"]), retire = vi.fn();
  const registry = new IdleContextRegistry({ now: () => time, maximumIdle: 2, idleMilliseconds: 100,
    canRetire: key => !busy.has(key), retire });
  registry.touch("worker");
  const first = registry.retain("request"), second = registry.retain("request");
  for (const key of ["a", "b", "c"]) { time++; registry.retain(key)(); }
  expect(retire.mock.calls).toEqual([["a"]]);
  first(); first(); // Release is idempotent; the other request still owns its pin.
  time = 150; registry.sweep();
  expect(retire.mock.calls).toEqual([["a"], ["b"], ["c"]]);
  second(); busy.clear(); time = 251; registry.sweep();
  expect(new Set(retire.mock.calls.flat())).toEqual(new Set(["a", "b", "c", "worker", "request"]));
  registry.retain("request")();
  expect(retire).toHaveBeenCalledTimes(5); // A retired identity may be freshly constructed.
});
