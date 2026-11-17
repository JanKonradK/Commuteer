import { describe, expect, it } from "vitest";
import { chanceAtMost, chanceCatch, delayDist, loadBands, range80, type BusBands } from "../src/lib/busOdds";

const probs = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
const q = [-2, -1, 0, 1, 2, 3, 4];
const bands: BusBands = {
  format: "commuteer-bus-bands/1", generated: "", days: 1, rows: 1, probs,
  buckets: [
    { maxLeadMin: 10, live: q, timetable: [0, 1, 2, 3, 5, 8, 10], n: 1 },
    { maxLeadMin: null, live: [3, 2, 1, 0, 1, 2, 3], timetable: q, n: 1 },
  ],
  routes: { "466": [{ maxLeadMin: 10, live: [0, 0, 0, 0, 0, 0, 0], timetable: q, n: 1 }] },
};

describe("busOdds", () => {
  it("picks bucket and route, shifts live, enforces monotone", () => {
    expect(delayDist(bands, { route: "20", leadMin: 5, liveDelayMin: 4 }).minutes).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(delayDist(bands, { route: "20", leadMin: 5, liveDelayMin: null }).minutes[6]).toBe(10);
    expect(delayDist(bands, { route: "466", leadMin: 5, liveDelayMin: 1 }).minutes).toEqual(Array(7).fill(1));
    expect(delayDist(bands, { route: "466", leadMin: 30, liveDelayMin: 0 }).minutes).toEqual([3, 3, 3, 3, 3, 3, 3]);
  });

  it("CDF interpolates, extrapolates and clamps", () => {
    const d = { probs, minutes: q };
    expect(chanceAtMost(d, 1)).toBeCloseTo(0.5);
    expect(chanceAtMost(d, 1.5)).toBeCloseTo(0.625);
    expect(chanceAtMost(d, -2.5)).toBeCloseTo(0.025);
    expect(chanceAtMost(d, -10)).toBe(0.02);
    expect(chanceAtMost(d, 50)).toBe(0.98);
    expect(range80(d)).toEqual([-1, 3]);
  });

  it("chance of catching a connection", () => {
    const d = { probs, minutes: q };
    expect(chanceCatch(null, 0, 60, null, 120)).toBe(0.98);
    expect(chanceCatch(null, 0, 60, null, 30)).toBe(0.02);
    expect(chanceCatch(d, 0, 0, null, 60)).toBeCloseTo(0.5); // 1 min slack = median delay
    expect(chanceCatch(null, 0, 0, d, -60)).toBeCloseTo(0.5);
    // same distribution both legs, zero slack: symmetric -> ~50%
    expect(chanceCatch(d, 0, 0, d, 0)).toBeCloseTo(0.5, 1);
    expect(chanceCatch(d, 0, 0, d, 600)).toBe(0.98);
  });

  it("loads the real bands", async () => {
    const b = await loadBands();
    expect(b.format).toBe("commuteer-bus-bands/1");
    expect(b.buckets.at(-1)!.maxLeadMin).toBeNull();
  });
});
