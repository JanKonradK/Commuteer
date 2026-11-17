// Weather strip for "should I stay at work a bit longer?" and a one-line weather chip.

import { Chip } from "./ui";
import { describe, misery, stayLonger, type WeatherHour, weatherEmoji } from "./lib/weather";

const HOUR_MS = 3_600_000;
const hh = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, "0")}:00`;

export function WeatherStrip({ hours, now, departures = [] }: { hours: WeatherHour[]; now: number; departures?: number[] }) {
  const { hours: next, bestHour } = stayLonger(hours, now);
  if (!next.length) return null;
  return (
    <div className="wx-strip" role="list">
      {next.map((h) => {
        const best = h === bestHour;
        const bus = departures.some((d) => d >= h.at && d < h.at + HOUR_MS);
        return (
          <div key={h.at} role="listitem" className={`wx-hour ${h.misery.tone}${best ? " best" : ""}`} title={h.misery.label}>
            <span className="wx-time">{hh(h.at)}</span>
            <span className="wx-icon">{weatherEmoji(h)}</span>
            <span className="wx-temp">{Math.round(h.tempC)}°</span>
            <span className="wx-rain">{Math.round(h.rainChance)}%</span>
            {best && <span className="wx-best">Driest</span>}
            {bus && <span className="wx-dot" aria-label="bus departs" />}
          </div>
        );
      })}
    </div>
  );
}

export function WeatherChip({ hour }: { hour: WeatherHour }) {
  return <Chip tone={misery(hour).tone}>{describe(hour)}</Chip>;
}
