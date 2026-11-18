import { describe, expect, it } from "vitest";
import { choose } from "../src/Weather";
import { type WeatherHour, stayLonger } from "../src/lib/weather";

const H = 3_600_000;
const hour = (i: number, rainChance: number, rainMm: number): WeatherHour => ({
  at: i * H, tempC: 8, feelsC: 6, rainChance, rainMm, windKmh: 10, gustKmh: 20, code: 3, isDay: false,
});

describe("choose", () => {
  const hours = [hour(0, 90, 2), hour(1, 80, 1.5), hour(2, 10, 0), hour(3, 5, 0)];
  const next = stayLonger(hours, 0, 8).hours;

  it("suggests a later trip only when its wait is clearly better", () => {
    const pick = choose(next, hours, [{ leaveMs: 0.2 * H, waitMs: 1.2 * H }, { leaveMs: 2.1 * H, waitMs: 3.3 * H }]);
    expect(pick?.leaveMs).toBe(2.1 * H);
  });

  it("keeps the next trip when later ones are no better", () => {
    expect(choose(next, hours, [{ leaveMs: 1.5 * H, waitMs: 2.2 * H }, { leaveMs: 2.5 * H, waitMs: 3.2 * H }])).toBeNull();
  });

  it("falls back to the best hour without trips", () => {
    expect(choose(next, hours, [])?.at).toBe(3 * H);
  });
});
