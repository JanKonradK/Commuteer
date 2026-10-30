import type { BusDeparture, BusPack, BusTimeUpdate } from "./lib/buses";
import { busTimeSource } from "./lib/buses";
import { clock } from "./lib/predict";
import { delayText, useNow } from "./ui";

/** A feed prediction is not a GPS fix or proof the bus has reached this stop. */
export function BusDetails({ d, pack }: { d: BusDeparture; pack: BusPack }) {
  const now = useNow();
  const ageS = d.feedAt ? Math.max(0, Math.floor((now - d.feedAt) / 1000)) : null;
  const describe = (u: BusTimeUpdate | null | undefined) => {
    if (!u) return "Timetable only. No stop estimate in the feed.";
    const stop = pack.stops.find((s) => s[0] === u.stopId)?.[1] ?? "an earlier stop";
    return u.source === "stop"
      ? `TFI supplied an update for this stop: ${delayText(u.delayS / 60)}.`
      : `Delay carried forward from ${stop}: ${delayText(u.delayS / 60)}. No update for this stop.`;
  };
  return (
    <details className="bus-details">
      <summary>Time details · {busTimeSource(d.arrivalUpdate).toLowerCase()}</summary>
      <div className="bus-details-body">
        <p><strong>Leave:</strong> {describe(d.departureUpdate)}</p>
        <p><strong>Arrive:</strong> {describe(d.arrivalUpdate)}</p>
        <p>Timetable: {clock(d.departS)} → {clock(d.arriveS)}</p>
        {d.feedAt && ageS !== null && (
          <p>TFI feed: {new Date(d.feedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}
            {" · "}{ageS < 60 ? `${ageS} sec ago` : `${Math.floor(ageS / 60)} min ago`}
            {ageS > 300 ? " · out of date" : ""}
          </p>
        )}
        <p>Stop updates are predictions. Carried-forward delays assume the bus keeps the same delay. Bus Éireann RTPI may still show the timetable.</p>
        <p><a href="https://www.buseireann.ie/rtpi" target="_blank" rel="noopener noreferrer">Compare with Bus Éireann RTPI ↗</a></p>
        {!d.departureUpdate && !d.arrivalUpdate && <p>No live prediction is available for these stops.</p>}
      </div>
    </details>
  );
}
