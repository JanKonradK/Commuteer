import { useEffect, useMemo, useState } from "react";
import { BusDetails } from "../BusDetails";
import {
  type BusDeparture,
  type BusPack,
  busDepartures,
  busPrefs,
  groupStops,
  loadPack,
  packExpired,
  withLiveDelays,
  upcomingBuses,
  busTimeSource,
} from "../lib/buses";
import { Chip, delayText, delayTone, StatusRow, Times, useAutoRefresh, secondsSinceMidnight, useNow } from "../ui";

function BusCard({ d, pack }: { d: BusDeparture; pack: BusPack }) {
  const now = useNow();
  const stale = !!d.feedAt && now - d.feedAt > 300_000;
  const live = d.departDelayS !== null || d.arriveDelayS !== null;
  const depDelay = d.departDelayS ?? 0;
  const arrDelay = d.arriveDelayS ?? d.departDelayS ?? 0;
  const delayMin = live ? arrDelay / 60 : null;
  const delayLabel = live && Math.round(arrDelay / 60) === 0 ? "No delay reported" : delayText(delayMin);
  return (
    <li className={`card ${d.canceled || d.skipped ? "bad" : delayTone(delayMin)}`}>
      <Times
        departS={d.departS + depDelay}
        arriveS={d.arriveS + arrDelay}
        scheduledDepartS={d.departS}
        scheduledArriveS={d.arriveS}
        nowS={d.canceled || d.skipped || stale ? undefined : secondsSinceMidnight(new Date(now))}
        departLabel={`Leave · ${stale ? "last estimate" : busTimeSource(d.departureUpdate).toLowerCase()}`}
        arriveLabel={`Arrive · ${stale ? "last estimate" : busTimeSource(d.arrivalUpdate).toLowerCase()}`}
      />
      <div className="chips">
        <span className="route">{d.route}</span>
        <span className="muted small">to {d.headsign}</span>
        <Chip tone={d.canceled || d.skipped ? "bad" : delayTone(delayMin)}>
          {d.canceled ? "Cancelled" : d.skipped ? "Stop not served" : stale ? "Feed out of date" : live ? `${busTimeSource(d.arrivalUpdate ?? d.departureUpdate)} · ${delayLabel}` : "Timetable only"}
        </Chip>
      </div>
      {(d.departureUpdate?.source === "carried" || d.arrivalUpdate?.source === "carried") && (
        <p className="muted small bus-estimate-note">Estimate from an earlier stop · may differ from the stop display</p>
      )}
      <BusDetails d={d} pack={pack} />
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
    if (!from || !to || from === to) return { departures: [] as BusDeparture[], warning: null };
    const now = new Date();
    const deps = busDepartures(pack, from, to, now, 720, 120);
    try {
      return { departures: upcomingBuses(await withLiveDelays(deps), now).slice(0, 6), warning: null };
    } catch (e) {
      return {
        departures: upcomingBuses(deps, now).slice(0, 6),
        warning: e instanceof Error ? `${e.message} · showing timetable` : "Live buses unavailable · showing timetable",
      };
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
      {data?.warning && <p className="muted small" role="status">{data.warning}</p>}
      {packExpired(pack, new Date()) && <p className="notice">⚠ Timetable out of date</p>}
      {data &&
        (data.departures.length === 0 ? (
          <p className="notice">No direct buses · 12 h</p>
        ) : (
          <ul>
            {data.departures.map((d) => (
              <BusCard key={`${d.tripId}-${d.serviceDate}`} d={d} pack={pack} />
            ))}
          </ul>
        ))}
    </section>
  );
}
