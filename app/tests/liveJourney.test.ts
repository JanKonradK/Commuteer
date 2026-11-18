import { describe, expect, it } from "vitest";
import type { BusPack } from "../src/lib/buses";
import type { Connection, LegTrip } from "../src/lib/commute";
import { journeyJson } from "../src/lib/liveJourney";

const pack = { stops: [["s1", "Ballymahon", 53.56, -7.76], ["s2", "Athlone", 53.42, -7.93]],
  trips: [["T1", 0, 0, "Athlone", [[0, 4, 0, 0], [1, 9, 0, 0]]]] } as unknown as BusPack;
const leg = (o: Partial<LegTrip>): LegTrip => ({ kind: "shuttle", label: "Center Parcs shuttle", departS: 0, arriveS: 0,
  scheduledDepartS: 0, scheduledArriveS: 0, live: false, canceled: false, ...o });
const places: [string, string, string, string] = ["West Yard", "Inny", "Ballymahon", "Athlone"];
const noon = new Date(2026, 10, 17, 12, 0).getTime();
const at = (h: number, m = 0) => h * 3600 + m * 60;

describe("journeyJson", () => {
  const c = {
    first: leg({ departS: at(18, 30), arriveS: at(18, 40), scheduledDepartS: at(18, 30), scheduledArriveS: at(18, 40) }),
    second: leg({ kind: "bus", label: "466", departS: at(19, 17), arriveS: at(19, 40), scheduledDepartS: at(19, 14),
      scheduledArriveS: at(19, 37), live: true,
      busInfo: { tripId: "T1", serviceDate: "20261117", fromSeq: 4, toSeq: 9 } as LegTrip["busInfo"] }),
    stage: "start",
  } as unknown as Connection;

  it("sends both legs with live estimates and where to get off", () => {
    const j = JSON.parse(journeyJson(c, places, pack, 5, noon)!);
    expect(j.walkMin).toBe(5);
    expect(j.legs).toHaveLength(2);
    const bus = j.legs[1];
    expect(bus).toMatchObject({ label: "Bus 466", tripId: "T1", fromSeq: 4, toSeq: 9, toName: "Athlone", delayS: 180, live: true });
    expect(bus.estArriveMs - bus.arriveMs).toBe(180_000);
    expect([bus.toLat, bus.toLon]).toEqual([53.42, -7.93]);
    expect(new Date(j.legs[0].departMs).getHours()).toBe(18);
  });

  it("is null once the journey is over", () => {
    expect(journeyJson(c, places, pack, 5, new Date(2026, 10, 17, 21, 0).getTime())).toBeNull();
  });

  it("skips the first leg when you are already on the second", () => {
    const j = JSON.parse(journeyJson({ ...c, stage: "second" } as Connection, places, pack, 5, noon)!);
    expect(j.legs.map((l: { label: string }) => l.label)).toEqual(["Bus 466"]);
  });
});
