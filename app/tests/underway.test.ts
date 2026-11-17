import { type BusPack } from "../src/lib/buses";
import type { BusBands } from "../src/lib/busOdds";
import { type Commute, planCommute } from "../src/lib/commute";
import { parseRows, type Shuttle } from "../src/lib/shuttles";

const pack: BusPack = {
  format: "commuteer-bus-pack/1", start: "2026-10-28", days: 2, services: ["11"],
  routes: [["466", "466", "Bus Éireann"]],
  stops: [["B", "Town", 53.5652, -7.7662], ["A", "Station", 53.4268, -7.9352]],
  trips: [["late", 0, 0, "Station", [[0, 10, 1301, 1301], [1, 13, 1323, 1323]]]],
};
const shuttle: Shuttle = {
  id: "work", name: "Staff shuttle", days: [0, 1, 2, 3, 4, 5, 6], waitMin: 5, travelMin: 10,
  rows: parseRows("21:15 Yard\n21:30 Pickup *\n22:30 Yard\n22:45 Pickup *"),
};
const commute: Commute = { legs: [{ kind: "shuttle", id: "work", from: "Yard", to: "Pickup" }, { kind: "bus", from: "B", to: "A" }], walkMin: 5 };
const spread = [-3, -2, -1, 0, 1, 2, 3];
const bands: BusBands = {
  format: "commuteer-bus-bands/1", generated: "", days: 1, rows: 1, probs: [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95],
  buckets: [{ maxLeadMin: null, live: spread, timetable: spread, n: 1 }], routes: {},
};
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    feed_timestamp: Date.now() / 1000, trips: { late: { date: "20261028", canceled: false, stops: [[10, "B", 0, 0, false]] } },
  }))));
});
afterEach(() => { vi.unstubAllGlobals(); });

it("keeps a shuttle you are already on, with its onward bus", async () => {
  const plan = await planCommute(commute, pack, [shuttle], new Date(2026, 9, 28, 21, 20), 4, { stage: "start" }, bands);
  const c = plan.underway[0];
  expect(c.underway).toBe(true);
  expect(c.stage).toBe("first");
  expect(c.first.kind).toBe("shuttle");
  expect(c.first.departS).toBe(1275 * 60);
  expect(c.second?.busInfo?.tripId).toBe("late");
  // Shuttle is fixed, bus can be up to ~3 min early: a 6 min margin is very likely but not certain.
  expect(c.catchChance).toBeGreaterThan(0.9);
  expect(c.second?.departRange).toEqual([1299 * 60, 1303 * 60]); // 10th-90th percentile
});

it("keeps the final bus you are on after it leaves", async () => {
  const plan = await planCommute(commute, pack, [shuttle], new Date(2026, 9, 28, 21, 50), 4, { stage: "start" }, bands);
  const c = plan.underway.find((x) => x.stage === "second");
  expect(c?.second?.busInfo?.tripId).toBe("late");
  expect(c?.first.kind).toBe("walk");
  expect(plan.connections.every((x) => x.second?.busInfo?.tripId !== "late" || x.stage === "second")).toBe(true);
});

it("drops trips once they have arrived", async () => {
  const plan = await planCommute(commute, pack, [shuttle], new Date(2026, 9, 28, 22, 10), 4, { stage: "start" }, bands);
  expect(plan.underway).toEqual([]);
});
