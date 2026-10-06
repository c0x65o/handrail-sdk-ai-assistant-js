import { afterEach, expect, it, vi } from "vitest";
import { createHandrailAiClient, type HandrailAiClientBootstrapOptions } from "../src/client/bootstrap.js";
import { pollingGateway } from "./fixtures/polling-gateway.js";

type Timings = Pick<HandrailAiClientBootstrapOptions<unknown, unknown, unknown>,
  "activityPollingMilliseconds" | "synchronizationPollingMilliseconds" | "idleSynchronizationPollingMilliseconds">;
const clients: Awaited<ReturnType<typeof createHandrailAiClient>>[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); vi.useRealTimers(); });
async function fixture(timings: Timings = {}) {
  const gateway = pollingGateway();
  const client = await createHandrailAiClient({ baseUrl: "https://fixture.test/assistant", fetch: gateway.fetch, ...timings,
    restoreActiveTurns: false, conversations: { mode: "multiple", clientId: "test" as never, authorize: () => "allow" } });
  clients.push(client);
  await client.workspace!.open({ conversationId: "chat" as never, authorizationContext: {} });
  return { client, gateway };
}

it.each([
  { timings: {}, active: 1000, idle: 15000, activity: 5000 },
  { timings: { synchronizationPollingMilliseconds: 3000, idleSynchronizationPollingMilliseconds: 9000,
    activityPollingMilliseconds: 7000 }, active: 3000, idle: 9000, activity: 7000 },
])("honors successful visible/hidden/running polling and defaults: $timings", async ({ timings, active, idle, activity }) => {
  vi.useFakeTimers();
  const { client, gateway } = await fixture(timings);
  // Settle initial display selection/related reads, then sample a full regular interval.
  await vi.advanceTimersByTimeAsync(active);
  const controls = gateway.count("control"), changes = gateway.count("changes");
  await vi.advanceTimersByTimeAsync(active - 1);
  expect(gateway.count("control")).toBe(controls);
  await vi.advanceTimersByTimeAsync(1);
  expect(gateway.count("control")).toBe(controls + 1);
  expect(gateway.count("changes")).toBe(changes + 1);
  client.workspace!.setVisible(false);
  await vi.advanceTimersByTimeAsync(0);
  const hiddenControls = gateway.count("control"), hiddenChanges = gateway.count("changes");
  await vi.advanceTimersByTimeAsync(idle - 1);
  expect(gateway.count("control")).toBe(hiddenControls);
  await vi.advanceTimersByTimeAsync(1);
  expect(gateway.count("control")).toBe(hiddenControls + 1);
  expect(gateway.count("changes")).toBe(hiddenChanges);
  // Even hidden, an active turn selects the regular interval after the next read.
  gateway.setRunning(true);
  await vi.advanceTimersByTimeAsync(idle);
  const runningControls = gateway.count("control");
  await vi.advanceTimersByTimeAsync(active - 1);
  expect(gateway.count("control")).toBe(runningControls);
  await vi.advanceTimersByTimeAsync(1);
  expect(gateway.count("control")).toBe(runningControls + 1);
  const activityReads = gateway.reads.filter(read => read.operation === "activity");
  expect(activityReads.length).toBeGreaterThan(2);
  expect(activityReads.slice(1).every((read, index) => read.at - activityReads[index]!.at === activity)).toBe(true);
  await client.dispose();
  const stopped = gateway.reads.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(gateway.reads).toHaveLength(stopped);
});

it("retains the Retry-After minimum above configured activity and display intervals", async () => {
  vi.useFakeTimers();
  const { gateway } = await fixture({ activityPollingMilliseconds: 500, synchronizationPollingMilliseconds: 500,
    idleSynchronizationPollingMilliseconds: 1000 });
  await vi.advanceTimersByTimeAsync(500);
  gateway.throttle.add("control"); gateway.throttle.add("activity");
  await vi.advanceTimersByTimeAsync(500);
  const controls = gateway.count("control"), activity = gateway.count("activity");
  await vi.advanceTimersByTimeAsync(19999);
  expect(gateway.count("control")).toBe(controls); expect(gateway.count("activity")).toBe(activity);
  await vi.advanceTimersByTimeAsync(1);
  expect(gateway.count("control")).toBe(controls + 1); expect(gateway.count("activity")).toBe(activity + 1);
});

it.each(["activityPollingMilliseconds", "synchronizationPollingMilliseconds", "idleSynchronizationPollingMilliseconds"] as const)(
  "uses existing bootstrap validation for %s", async option => {
    vi.useFakeTimers();
    const minimum = option === "activityPollingMilliseconds" ? 500 : 100;
    for (const value of [0, minimum - 1, 300001, 1000.5, NaN, Infinity]) {
      await expect(fixture({ [option]: value })).rejects.toThrow(option === "activityPollingMilliseconds"
        ? "intervalMilliseconds must be between 500 and 300000" : "Invalid conversation polling interval");
    }
    for (const value of [minimum, 300000]) await fixture({ [option]: value });
  });
