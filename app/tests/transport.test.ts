import { type BusPack, busDepartures, delayAt, groupStops } from "../src/lib/buses";
import { connections, reverse, type Commute } from "../src/lib/commute";
import { busiestPair, parseRows, type Shuttle, shuttleTrips } from "../src/lib/shuttles";

// Wednesday 28 Oct 2026, 09:00 local time.
const NOW = new Date(2026, 9, 28, 9, 0);

const pack: BusPack = {
  format: "commuteer-bus-pack/1",
  start: "2026-10-28",
  days: 3,
  stops: [
    ["ATH1", "Athlone Stn", 53.4268, -7.9352],
    ["ATH2", "Athlone Stn", 53.4267, -7.9351], // other direction, same place
    ["BAL1", "Ballymahon", 53.5653, -7.7664],
    ["FAR", "Ballymahon", 52.0, -8.0], // same name, far away: a different place
  ],
  routes: [["R466", "466", "Bus Éireann"]],
  services: ["111", "011"],
  trips: [
    ["T0910", 0, 0, "Cavan", [[0, 1, 550, 550], [2, 4, 576, 576]]], // 09:10 -> 09:36
    ["T1310", 0, 0, "Cavan", [[1, 1, 790, 790], [2, 4, 816, 816]]], // 13:10 -> 13:36
    ["Tmidnight", 0, 0, "Cavan", [[0, 1, 1450, 1450], [2, 4, 1476, 1476]]], // 24:10 = 00:10 next day
    ["Tnottoday", 0, 1, "Cavan", [[0, 1, 560, 560], [2, 4, 586, 586]]], // service starts tomorrow
    ["Thome", 0, 0, "Athlone", [[2, 1, 660, 660], [0, 4, 686, 686]]], // 11:00 Ballymahon -> Athlone
  ],
};

describe("buses", () => {
  const groups = groupStops(pack);
  const athlone = groups.find((g) => g.name === "Athlone Stn")!;
  const ballymahon = groups.find((g) => g.name === "Ballymahon")!;

  it("merges same-name stops nearby but not far apart", () => {
    expect(athlone.stops).toEqual([0, 1]);
    expect(groups.map((g) => g.name)).toContain("Ballymahon (2)");
  });

  it("lists today's departures in order, skipping services not running", () => {
    const deps = busDepartures(pack, athlone, ballymahon, NOW, 300);
    expect(deps.map((d) => d.tripId)).toEqual(["T0910", "T1310"]);
    expect(deps[0].arriveS - deps[0].departS).toBe(26 * 60);
  });

  it("includes trips scheduled after midnight", () => {
    const late = new Date(2026, 9, 28, 23, 50);
    expect(busDepartures(pack, athlone, ballymahon, late, 60).map((d) => d.tripId)).toContain("Tmidnight");
  });

  it("propagates live delays forward along the trip", () => {
    const live = {
      date: "20261028",
      canceled: false,
      stops: [
        [1, "ATH1", null, 120, false],
        [3, "X", 300, 300, false],
      ] as [number, string, number | null, number | null, boolean][],
    };
    expect(delayAt(live, 1, "departure")).toBe(120);
    expect(delayAt(live, 4, "arrival")).toBe(300); // last update before seq 4
    expect(delayAt(live, 0, "arrival")).toBeNull();
  });
});

const shuttle: Shuttle = {
  id: "cp",
  name: "Shuttle",
  days: [0, 1, 2, 3, 4, 5, 6],
  waitMin: 5,
  travelMin: 10,
  rows: parseRows(`MORNING SHIFT
09:15 Inny Kayak Club
09:30 West Yard
09:45 Inny Kayak Club
10:00 West Yard
BREAK
12:00 Inny Kayak Club (Drop Off Only)
12.30 Longford
13:00 West Yard`),
};

describe("shuttles", () => {
  it("parses times, ignores headings and marks drop-off-only stops", () => {
    expect(shuttle.rows).toHaveLength(7);
    expect(shuttle.rows.find((r) => r.time === "12:00")).toMatchObject({ stop: "Inny Kayak Club", dropOffOnly: true });
    expect(shuttle.rows.find((r) => r.time === "12:30")?.stop).toBe("Longford");
  });

  it("finds trips, using travel time for direct hops and skipping drop-off-only boardings", () => {
    const trips = shuttleTrips(shuttle, "Inny Kayak Club", "West Yard", NOW, 0);
    expect(trips.map((t) => [t.departS / 60, t.arriveS / 60])).toEqual([
      [555, 565], // 09:15 -> 09:25 (10 min travel)
      [585, 595],
    ]);
  });

  it("doesn't chain across a shift change", () => {
    const shifts: Shuttle = {
      ...shuttle,
      rows: parseRows(`13:30 Inny Kayak Club
13:45 West Yard
14:00 HK Yard
15:00 HK Yard
15:15 Inny Kayak Club`),
    };
    expect(shuttleTrips(shifts, "West Yard", "Inny Kayak Club", NOW, 0)).toEqual([]);
  });

  it("defaults to the most common hop", () => {
    expect(busiestPair(shuttle)).toEqual(["Inny Kayak Club", "West Yard"]);
  });

  it("respects running days", () => {
    expect(shuttleTrips({ ...shuttle, days: [0] }, "Inny Kayak Club", "West Yard", NOW, 0)).toEqual([]);
  });
});

describe("connections", () => {
  const commute: Commute = {
    walkMin: 5,
    legs: [
      { kind: "bus", from: "ATH1", to: "BAL1" },
      { kind: "shuttle", id: "cp", from: "Inny Kayak Club", to: "West Yard" },
    ],
  };

  it("connects each bus to the first shuttle you can still catch", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ trips: {} }))) as typeof fetch;
    const cs = await connections(commute, pack, [shuttle], NOW);
    const first = cs[0];
    expect(first.first.label).toBe("466");
    // Bus arrives 09:36, +5 walk = 09:41 -> the 09:45 shuttle with 4 minutes to spare.
    expect(first.second?.departS).toBe(585 * 60);
    expect(first.spareMin).toBe(4);
  });

  it("only shows the latest first leg that makes each second leg", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ trips: {} }))) as typeof fetch;
    // Home: the 09:30 and 10:00 shuttles both make the 11:00 bus; only the 10:00 is worth showing.
    const home = reverse(commute);
    const early = new Date(2026, 9, 28, 9, 20);
    const cs = await connections(home, pack, [shuttle], early);
    const toBus = cs.filter((c) => c.second?.label === "466");
    expect(toBus).toHaveLength(1);
    expect(toBus[0].first.departS).toBe(600 * 60); // 10:00 shuttle
  });

  it("reverses the journey for the trip home", () => {
    const back = reverse(commute);
    expect(back.legs[0]).toMatchObject({ kind: "shuttle", from: "West Yard", to: "Inny Kayak Club" });
    expect(back.legs[1]).toMatchObject({ kind: "bus", from: "BAL1", to: "ATH1" });
  });
});
