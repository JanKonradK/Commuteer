import { useEffect, useMemo, useState } from "react";
import {
  type BusDeparture,
  type BusPack,
  busDepartures,
  busPrefs,
  groupStops,
  loadPack,
  packExpired,
  withLiveDelays,
} from "../lib/buses";
import { Chip, delayText, delayTone, StatusRow, Times, useAutoRefresh, secondsSinceMidnight } from "../ui";

function BusCard({ d }: { d: BusDeparture }) {
  const live = d.departDelayS !== null || d.arriveDelayS !== null;
  const depDelay = d.departDelayS ?? 0;
  const arrDelay = d.arriveDelayS ?? d.departDelayS ?? 0;
  const delayMin = live ? arrDelay / 60 : null;
  return (
    <li className={`card ${delayTone(delayMin)}`}>
      <Times
        departS={d.departS + depDelay}
        arriveS={d.arriveS + arrDelay}
        scheduledDepartS={d.departS}
        scheduledArriveS={d.arriveS}
        nowS={secondsSinceMidnight()}
      />
      <div className="chips">
        <span className="route">{d.route}</span>
        <span className="muted small">to {d.headsign}</span>
        <Chip tone={delayTone(delayMin)}>{delayText(delayMin)}</Chip>
      </div>
    </li>
  );
}

export function BusView() {
  const [pack, setPack] = useState<BusPack | null>(null);
  const [route, setRoute] = useState(busPrefs.get);
  useEffect(() => {
    void loadPack().then(setPack);
  }, []);
  const groups = useMemo(() => (pack ? groupStops(pack) : []), [pack]);

  const { data, at, loading, error, refresh } = useAutoRefresh(async () => {
    busPrefs.set(route);
    if (!pack) return null;
    const from = groups.find((g) => g.key === route.from);
    const to = groups.find((g) => g.key === route.to);
    if (!from || !to || from === to) return [];
    const deps = busDepartures(pack, from, to, new Date(), 720).slice(0, 6); // rural routes run every few hours
    try {
      return await withLiveDelays(deps);
    } catch {
      return deps; // offline: timetable only (grey cards, no live dot)
    }
  }, [route, pack]);

  if (!pack) return <p className="notice">…</p>;
  const picker = (key: "from" | "to") => (
    <select aria-label={key} value={route[key]} onChange={(e) => setRoute({ ...route, [key]: e.target.value })}>
      {groups.map((g) => (
        <option key={g.key} value={g.key}>
          {g.name}
        </option>
      ))}
    </select>
  );

  return (
    <section>
      <div className="pickers">
        {picker("from")}
        <button aria-label="Swap" onClick={() => setRoute({ from: route.to, to: route.from })}>
          ⇄
        </button>
        {picker("to")}
      </div>
      <StatusRow at={at} loading={loading} stale={!!error} onRefresh={refresh} />
      {packExpired(pack, new Date()) && <p className="notice">⚠ Timetable out of date</p>}
      {data &&
        (data.length === 0 ? (
          <p className="notice">No direct buses · 12 h</p>
        ) : (
          <ul>
            {data.map((d) => (
              <BusCard key={`${d.tripId}-${d.serviceDate}`} d={d} />
            ))}
          </ul>
        ))}
    </section>
  );
}
