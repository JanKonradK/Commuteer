// Weather for "should I stay at work a bit longer?": an hourly strip where the best hour to
// wait at the change is lit and hours with a bus carry a bus icon, and a small chip per trip.

import { Icon, type IconName } from "./icons";
import { misery, type ScoredHour, stayLonger, weatherAt, type WeatherHour } from "./lib/weather";

const HOUR_MS = 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
const hh = (ms: number) => `${pad(new Date(ms).getHours())}:00`;

/** WMO weather code to a line icon. */
export function weatherIcon(h: WeatherHour): IconName {
  const c = h.code;
  if (c >= 95) return "storm";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 51) return "rain";
  if (c >= 45) return "fog";
  if (c >= 2) return "cloud";
  return h.isDay ? "sun" : "moon";
}

const rainText = (h: WeatherHour) => `${Math.round(h.rainChance)}% rain`;

/** A trip you could take: when you leave, and when you stand at the change waiting. */
export interface WeatherTrip { leaveMs: number; waitMs: number }

interface Pick { at: number; hour: WeatherHour; leaveMs?: number }

/**
 * The answer to "is staying later worth it?". With trips, compare the wait at the
 * change for each one; a later trip is only suggested when it is clearly better
 * (a full misery point), so small forecast noise does not tempt you to stay.
 */
export function choose(next: ScoredHour[], hours: WeatherHour[], trips: WeatherTrip[]): Pick | null {
  const scored = trips.flatMap((t) => {
    const hour = weatherAt(hours, t.waitMs);
    return hour ? [{ at: hour.at, hour, leaveMs: t.leaveMs, score: misery(hour).score }] : [];
  });
  if (scored.length) {
    const best = scored.reduce((a, b) => (b.score < a.score ? b : a));
    return best.score <= scored[0].score - 1 ? best : null;
  }
  const best = next.reduce((a, b) => (b.misery.score < a.misery.score ? b : a));
  return best !== next[0] && best.misery.score <= next[0].misery.score - 1 ? { at: best.at, hour: best } : null;
}

export function WeatherStrip({ hours, now, trips = [] }: { hours: WeatherHour[]; now: number; trips?: WeatherTrip[] }) {
  const { hours: next } = stayLonger(hours, now, 8);
  if (!next.length) return null;
  const pick = choose(next, hours, trips);
  return (
    <>
      <div className="wx-strip" role="list">
        {next.map((h, i) => {
          const best = pick?.at === h.at && i > 0;
          const bus = trips.some((t) => t.waitMs >= h.at && t.waitMs < h.at + HOUR_MS);
          return (
            <div key={h.at} role="listitem" className={`wx-hour ${h.misery.tone}${best ? " best" : ""}`}
              aria-label={`${hh(h.at)}: ${h.misery.label}, ${Math.round(h.tempC)} degrees, ${rainText(h)}${bus ? ", you could wait for a bus then" : ""}`}>
              <span className="wx-time">{i === 0 ? "Now" : hh(h.at)}</span>
              <span className="wx-icon"><Icon name={weatherIcon(h)} size={20} /></span>
              <span className="wx-temp">{Math.round(h.tempC)}°</span>
              <span className="wx-rain">{Math.round(h.rainChance)}%</span>
              {bus && <span className="wx-bus"><Icon name="bus" size={12} /></span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** "☁ 2°": the sky and how cold it feels while you wait at the change, in the misery tone. */
export function WeatherChip({ hour }: { hour: WeatherHour }) {
  const m = misery(hour);
  return (
    <span className={`chip ${m.tone}`} title={`At the change: ${m.label.toLowerCase()}, feels ${Math.round(hour.feelsC)}°, ${rainText(hour)}`}>
      <Icon name={weatherIcon(hour)} size={16} />
      {Math.round(hour.feelsC)}°
    </span>
  );
}
