import { describe, expect, it } from "vitest";
import { type TripStop, whereBus, whereText } from "../src/lib/whereBus";

// Four stops due east, ~700 m apart.
const stops: TripStop[] = [0, 1, 2, 3].map((i) => ({ name: `S${i}`, seq: i + 1, lat: 53.4, lon: -7.9 + i * 0.01 }));
const at = (lon: number, t = 0) => ({ lat: 53.4, lon, t, bearing: null });

describe("whereBus", () => {
  it("is at a stop when within 60 m", () => {
    const w = whereBus(stops, at(-7.89), 4, 20_000)!;
    expect(w.atStop?.name).toBe("S1");
    expect(w.stopsTo).toBe(2);
    expect(w.ageS).toBe(20);
    expect(whereText(w, "board")).toBe("At S1 · 2 stops away");
  });

  it("counts the next stop as 1 when it is yours", () => {
    const w = whereBus(stops, at(-7.885), 3, 0)!;
    expect(w.atStop).toBeNull();
    expect(w.next?.name).toBe("S2");
    expect(w.stopsTo).toBe(1);
    expect(whereText(w, "board")).toBe("Heading to S2 · your stop is next");
  });

  it("knows when the bus has passed your stop", () => {
    const w = whereBus(stops, at(-7.875), 2, 0)!;
    expect(w.stopsTo).toBeLessThan(0);
    expect(whereText(w, "board")).toContain("passed your stop");
  });

  it("counts stops to go when riding", () => {
    const w = whereBus(stops, at(-7.895), 4, 0)!;
    expect(whereText(w, "alight")).toBe("Heading to S1 · 3 stops to go");
  });

  it("flags a bus far from the route", () => {
    const w = whereBus(stops, { lat: 53.5, lon: -7.9, t: 0, bearing: null }, 4, 0)!;
    expect(whereText(w, "board")).toBe("Off the usual route");
  });
});
