// Hourly weather from Open-Meteo (free, no key), scored for someone waiting at a bus stop.

import { load, save } from "./storage";

export interface WeatherHour {
  at: number; // ms epoch, start of the hour
  tempC: number;
  feelsC: number;
  rainChance: number; // 0-100
  rainMm: number; // mm in the hour
  windKmh: number;
  gustKmh: number;
  code: number; // WMO weather code
  isDay: boolean;
}

const HOUR_MS = 3_600_000;
const FRESH_MS = 30 * 60_000;
const STALE_MS = 6 * HOUR_MS;
const TIMEOUT_MS = 8_000;

interface Cached {
  at: number;
  hours: WeatherHour[];
}

const cacheKey = (lat: number, lon: number) => `weather:${lat.toFixed(2)},${lon.toFixed(2)}`;

async function fetchForecast(lat: number, lon: number): Promise<WeatherHour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation," +
    "wind_speed_10m,wind_gusts_10m,weather_code,is_day&timezone=auto&forecast_days=2&timeformat=unixtime";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
    const h = (await res.json()).hourly;
    return (h.time as number[]).map((t, i) => ({
      at: t * 1000,
      tempC: h.temperature_2m[i] ?? 0,
      feelsC: h.apparent_temperature[i] ?? 0,
      rainChance: h.precipitation_probability[i] ?? 0,
      rainMm: h.precipitation[i] ?? 0,
      windKmh: h.wind_speed_10m[i] ?? 0,
      gustKmh: h.wind_gusts_10m[i] ?? 0,
      code: h.weather_code[i] ?? 0,
      isDay: h.is_day[i] === 1,
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** Hourly forecast, cached 30 min; falls back to a cached copy under 6 h old when offline. */
export async function getForecast(lat: number, lon: number, now = Date.now()): Promise<WeatherHour[]> {
  const key = cacheKey(lat, lon);
  const cached = load<Cached | null>(key, null);
  if (cached && now - cached.at < FRESH_MS) return cached.hours;
  try {
    const hours = await fetchForecast(lat, lon);
    save(key, { at: now, hours } satisfies Cached);
    return hours;
  } catch (e) {
    if (cached && now - cached.at < STALE_MS) return cached.hours;
    throw e;
  }
}

/** The forecast hour containing `atMs`, or null outside the forecast. */
export function weatherAt(hours: WeatherHour[], atMs: number): WeatherHour | null {
  return hours.find((h) => atMs >= h.at && atMs < h.at + HOUR_MS) ?? null;
}

export type Tone = "good" | "ok" | "bad";
export interface Misery {
  score: number;
  tone: Tone;
  label: string;
}

/**
 * Misery 0-10 for standing outside:
 *   rain = min(6, 2.5 * mm/h + 2.5 * chance/100)   (dominates)
 *   wind = min(3, (gust - 30) / 10), 0 below 30 km/h gusts
 *   cold = min(2, (5 - feels) / 3), 0 at feels-like >= 5 C
 * score = min(10, rain + wind + cold). Tone: < 2 good, < 5 ok, else bad.
 */
export function misery(h: WeatherHour): Misery {
  const rain = Math.min(6, 2.5 * h.rainMm + (2.5 * h.rainChance) / 100);
  const wind = Math.min(3, Math.max(0, (h.gustKmh - 30) / 10));
  const cold = Math.min(2, Math.max(0, (5 - h.feelsC) / 3));
  const score = Math.round(Math.min(10, rain + wind + cold) * 10) / 10;
  const tone: Tone = score < 2 ? "good" : score < 5 ? "ok" : "bad";
  const wet = h.rainMm >= 0.2 || h.rainChance >= 50;
  const label =
    h.rainMm >= 2.5 ? "Heavy rain"
    : wet && wind >= 1 ? "Wet and windy"
    : wet ? "Light rain likely"
    : wind >= 1 ? "Windy"
    : cold >= 1 ? "Cold"
    : "Dry";
  return { score, tone, label };
}

/** Small emoji set for WMO weather codes. */
export function weatherEmoji(h: WeatherHour): string {
  const c = h.code;
  if (c >= 95) return "⛈";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "🌨";
  if (c >= 51) return "🌧";
  if (c >= 45) return "🌫";
  if (c >= 2) return "☁️";
  return h.isDay ? "☀️" : "🌙";
}

/** e.g. "🌧 7° (feels 3°) · 80% rain · 35 km/h gusts" */
export function describe(h: WeatherHour): string {
  const t = Math.round(h.tempC);
  const f = Math.round(h.feelsC);
  const parts = [`${weatherEmoji(h)} ${t}°${f !== t ? ` (feels ${f}°)` : ""}`];
  if (h.rainChance >= 10) parts.push(`${Math.round(h.rainChance)}% rain`);
  if (h.gustKmh >= 30) parts.push(`${Math.round(h.gustKmh)} km/h gusts`);
  return parts.join(" · ");
}

export interface ScoredHour extends WeatherHour {
  misery: Misery;
}

/** The next `count` hours from `fromMs` (including the current one) with misery, and the least miserable (earliest on tie). */
export function stayLonger(
  hours: WeatherHour[],
  fromMs: number,
  count = 6,
): { hours: ScoredHour[]; bestHour: ScoredHour | null } {
  const next = hours
    .filter((h) => h.at + HOUR_MS > fromMs)
    .slice(0, count)
    .map((h) => ({ ...h, misery: misery(h) }));
  let bestHour: ScoredHour | null = null;
  for (const h of next) if (!bestHour || h.misery.score < bestHour.misery.score) bestHour = h;
  return { hours: next, bestHour };
}
