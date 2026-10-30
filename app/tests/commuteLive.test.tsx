import { renderToStaticMarkup } from "react-dom/server";
import type { BusPack } from "../src/lib/buses";
import { type Commute, planCommute } from "../src/lib/commute";
import { parseRows, type Shuttle } from "../src/lib/shuttles";
import { ConnectionCard } from "../src/views/CommuteView";

const now = new Date(2026, 9, 28, 9);
const pack: BusPack = {
  format: "commuteer-bus-pack/1", start: "2026-10-28", days: 1, services: ["1"],
  routes: [["466", "466", "Bus Éireann"], ["470", "470", "Bus Éireann"]],
  stops: [["A", "Start", 53, -7], ["B", "Transfer", 53.1, -7], ["C", "Work", 53.2, -7]],
  trips: [["first", 0, 0, "Transfer", [[0, 1, 550, 550], [1, 2, 576, 576]]]],
};
const shuttle: Shuttle = {
  id: "work", name: "Work shuttle", days: [0, 1, 2, 3, 4, 5, 6], waitMin: 0, travelMin: 10,
  rows: parseRows("09:45 Pickup\n09:55 Work\n10:15 Pickup\n10:25 Work"),
};
const commute: Commute = {
  legs: [{ kind: "bus", from: "A", to: "B" }, { kind: "shuttle", id: "work", from: "Pickup", to: "Work" }], walkMin: 5,
};
function feed(trips: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ feed_timestamp: Date.now() / 1000, trips }))));
}
const update = (delay: number, seq = 2, canceled = false) => ({
  date: "20261028", canceled, stops: [[seq, seq === 1 ? "A" : "B", delay, delay, false]],
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("replaces a missed shuttle after a live bus delay and recalculates the wait", async () => {
  feed({ first: update(12 * 60) });
  const plan = await planCommute(commute, pack, [shuttle], now);
  const c = plan.connections[0];
  expect(c.first.arriveS).toBe(588 * 60); // 09:48, walk until 09:53
  expect(c.second?.departS).toBe(615 * 60); // 10:15
  expect(c.spareMin).toBe(22);
  expect(c.changedFrom?.scheduledDepartS).toBe(585 * 60); // 09:45
  expect(plan.feedAt).toBeGreaterThan(0);
  expect(plan.warnings).toEqual([]);
});

it("uses one feed request for both bus legs and catches a delayed second bus", async () => {
  const twoBus: Commute = { ...commute, legs: [commute.legs[0], { kind: "bus", from: "B", to: "C" }] };
  const buses: BusPack = { ...pack, trips: [...pack.trips,
    ["second", 1, 0, "Work", [[1, 1, 579, 579], [2, 2, 600, 600]]],
    ["later", 1, 0, "Work", [[1, 1, 615, 615], [2, 2, 635, 635]]],
  ] };
  feed({ first: update(0), second: update(5 * 60, 1) });
  const plan = await planCommute(twoBus, buses, [], now);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(plan.connections[0].second?.busInfo?.tripId).toBe("second");
  expect(plan.connections[0].second?.departS).toBe(584 * 60);
  expect(plan.connections[0].spareMin).toBe(3);
});

it("chooses the connection that arrives first, including a later express service", async () => {
  const twoBus: Commute = { ...commute, legs: [commute.legs[0], { kind: "bus", from: "B", to: "C" }] };
  const buses: BusPack = { ...pack, trips: [...pack.trips,
    ["slow", 1, 0, "Work", [[1, 1, 585, 585], [2, 2, 630, 630]]],
    ["express", 1, 0, "Work", [[1, 1, 595, 595], [2, 2, 610, 610]]],
  ] };
  feed({});
  expect((await planCommute(twoBus, buses, [], now)).connections[0].second?.busInfo?.tripId).toBe("express");
});

it("excludes cancelled buses and skipped transfer stops", async () => {
  feed({ first: update(0, 2, true) });
  expect((await planCommute(commute, pack, [shuttle], now)).connections).toEqual([]);
  feed({ first: { date: "20261028", canceled: false, stops: [[2, "B", 0, 0, true]] } });
  expect((await planCommute(commute, pack, [shuttle], now)).connections).toEqual([]);
});

it("keeps a late first bus whose timetable departure is in the past", async () => {
  const late: BusPack = { ...pack, trips: [["first", 0, 0, "Transfer", [[0, 1, 530, 530], [1, 2, 550, 550]]]] };
  feed({ first: update(30 * 60, 1) });
  const c = (await planCommute(commute, late, [shuttle], now)).connections[0];
  expect(c.first.departS).toBe(560 * 60);
  expect(c.second?.departS).toBe(585 * 60);
});

it("does not offer a bus that has already departed", async () => {
  const past: BusPack = { ...pack, trips: [["first", 0, 0, "Transfer", [[0, 1, 538, 538], [1, 2, 560, 560]]]] };
  feed({});
  expect((await planCommute(commute, past, [shuttle], now)).connections).toEqual([]);
});

it("reports feed failures while calculating a timetable route", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
  const plan = await planCommute(commute, pack, [shuttle], now);
  expect(plan.connections[0].second?.departS).toBe(585 * 60);
  expect(plan.connections[0].first.live).toBe(false);
  expect(plan.warnings[0]).toContain("Routes use the timetable");
  expect(plan.feedAt).toBeNull();
});

it("identifies a lost final connection without claiming arrival at work", async () => {
  feed({ first: update(60 * 60) });
  const plan = await planCommute(commute, pack, [shuttle], now);
  expect(plan.connections[0].second).toBeNull();
  const html = renderToStaticMarkup(<ConnectionCard c={plan.connections[0]} pack={pack}
    places={["Start", "Transfer", "Pickup", "Work"]} walkMin={5} now={now.getTime()}
    stale={false} fastest open onToggle={() => {}} />);
  expect(html).toContain("Transfer only");
  expect(html).toContain("No later connection");
  expect(html).not.toContain("min total");
});

it("shows live leg times, the walk, wait, and recalculated journey duration", async () => {
  feed({ first: update(12 * 60) });
  const plan = await planCommute(commute, pack, [shuttle], now);
  const html = renderToStaticMarkup(<ConnectionCard c={plan.connections[0]} pack={pack}
    places={["Start", "Transfer", "Pickup", "Work"]} walkMin={5} now={now.getTime()}
    stale={false} fastest open onToggle={() => {}} />);
  expect(html).toContain("75 min total");
  expect(html).toContain("22 min to spare");
  expect(html).toContain("ready at 09:53");
  expect(html).toContain("Connection changed after live updates");
  expect(html).toContain("Shuttle timetable");
  expect(html).toContain("Stop update");
});
