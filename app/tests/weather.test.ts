import { afterEach, beforeEach, describe as group, expect, it, vi } from "vitest";
import { getForecast, misery, stayLonger, weatherAt, type WeatherHour } from "../src/lib/weather";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 17, 12);
const hour = (i: number, o: Partial<WeatherHour> = {}): WeatherHour => ({
  at: T0 + i * H, tempC: 10, feelsC: 9, rainChance: 0, rainMm: 0, windKmh: 10, gustKmh: 15, code: 1, isDay: true, ...o,
});

group("misery", () => {
  it("orders dry < drizzle < heavy rain and wind", () => {
    const dry = misery(hour(0));
    const drizzle = misery(hour(0, { rainMm: 0.3, rainChance: 60, code: 51 }));
    const storm = misery(hour(0, { rainMm: 4, rainChance: 90, gustKmh: 60, code: 63 }));
    expect(dry.score).toBeLessThan(drizzle.score);
    expect(drizzle.score).toBeLessThan(storm.score);
    expect([dry.tone, dry.label]).toEqual(["good", "Dry"]);
    expect(drizzle.label).toBe("Light rain likely");
    expect([storm.tone, storm.label]).toEqual(["bad", "Heavy rain"]);
    expect(misery(hour(0, { feelsC: -1 })).label).toBe("Cold");
  });
});

group("weatherAt", () => {
  const hours = [hour(0), hour(1)];
  it("finds the containing hour: start inclusive, end exclusive", () => {
    expect(weatherAt(hours, T0)).toBe(hours[0]);
    expect(weatherAt(hours, T0 + H - 1)).toBe(hours[0]);
    expect(weatherAt(hours, T0 + H)).toBe(hours[1]);
    expect(weatherAt(hours, T0 - 1)).toBeNull();
    expect(weatherAt(hours, T0 + 2 * H)).toBeNull();
  });
});

group("stayLonger", () => {
  it("returns the next hours and the earliest lowest-misery hour", () => {
    const hours = [
      hour(-1),
      hour(0, { rainMm: 2, rainChance: 90 }),
      hour(1, { rainMm: 1, rainChance: 70 }),
      hour(2),
      hour(3),
      hour(4, { rainMm: 3, rainChance: 100 }),
    ];
    const r = stayLonger(hours, T0 + 20 * 60_000, 4);
    expect(r.hours.map((h) => h.at)).toEqual([T0, T0 + H, T0 + 2 * H, T0 + 3 * H]);
    expect(r.bestHour?.at).toBe(T0 + 2 * H);
  });
});

group("getForecast cache", () => {
  const body = () =>
    new Response(JSON.stringify({
      hourly: {
        time: [T0 / 1000], temperature_2m: [7], apparent_temperature: [3], precipitation_probability: [80],
        precipitation: [1.2], wind_speed_10m: [20], wind_gusts_10m: [35], weather_code: [61], is_day: [1],
      },
    }));
  const fetchMock = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses, caches for 30 min by rounded location, then refetches", async () => {
    fetchMock.mockImplementation(async () => body());
    const a = await getForecast(53.123, -7.456, T0);
    expect(a[0]).toMatchObject({ at: T0, tempC: 7, feelsC: 3, rainChance: 80, gustKmh: 35, isDay: true });
    await getForecast(53.12, -7.46, T0 + 29 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getForecast(53.12, -7.46, T0 + 31 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a cache under 6 h old on failure, throws when older", async () => {
    fetchMock.mockImplementationOnce(async () => body());
    await getForecast(53.12, -7.46, T0);
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await getForecast(53.12, -7.46, T0 + 5 * H)).toHaveLength(1);
    await expect(getForecast(53.12, -7.46, T0 + 7 * H)).rejects.toThrow("offline");
  });
});
