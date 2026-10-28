import parity from "../src/model/parity-cases.json";
import modelJson from "../src/model/delay-model.json";
import { chanceWithin, DelayModel, erf, type ModelJson } from "../src/lib/model";

const model = new DelayModel(modelJson as ModelJson);

describe("on-device model", () => {
  it("matches PyTorch's outputs on real held-out cases", () => {
    expect(parity.length).toBeGreaterThan(10);
    for (const c of parity) {
      const got = model.predictChange(c.categorical, c.numeric);
      got.forEach((v, i) => expect(v).toBeCloseTo(c.expected_change[i], 2));
    }
  });

  it("keeps percentiles in order", () => {
    for (const c of parity) {
      const [lo, mid, hi] = model.predictArrivalDelay(3, c.categorical, c.numeric);
      expect(lo).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(hi);
    }
  });

  it("handles stations the model never saw", () => {
    const c = parity[0];
    const out = model.predictChange({ ...c.categorical, to_station: "NOWHERE" }, c.numeric);
    out.forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });

  it("erf is accurate", () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
    expect(erf(-2)).toBeCloseTo(-0.9953223, 6);
  });

  it("turns percentiles into a sensible chance", () => {
    expect(chanceWithin([0, 2, 4], 2)).toBeCloseTo(0.5);
    expect(chanceWithin([0, 2, 4], 4)).toBeCloseTo(0.9);
    expect(chanceWithin([0, 2, 4], 100)).toBe(0.95);
    expect(chanceWithin([0, 2, 4], -100)).toBe(0.05);
  });
});
