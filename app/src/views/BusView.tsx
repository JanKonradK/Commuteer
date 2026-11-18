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
  upcomingBuses,
} from "../lib/buses";
import { LiveLine } from "../LiveBus";
import { Chip, delayTone, LIVE_REFRESH_MS, RefreshButton, RouteBar, RouteSelect, Times, UpdatedText, useAutoRefresh, secondsSinceMidnight, useNow } from "../ui";

/** Times (live ones get a green dot, the timetable time struck through), route and where it goes. */
function BusCard({ d, pack }: { d: BusDeparture; pack: BusPack }) {
  const now = useNow();
  const stale = !!d.feedAt && now - d.feedAt > 300_000;
  const live = !stale && (d.departDelayS !== null || d.arriveDelayS !== null);
  const depDelay = d.departDelayS ?? 0;
  const arrDelay = d.arriveDelayS ?? d.departDelayS ?? 0;
  const gone = d.canceled || d.skipped;
  return (
    <li className={`card ${gone ? "bad" : delayTone(live ? arrDelay / 60 : null)}`}>
      <Times
        departS={d.departS + depDelay}
        arriveS={d.arriveS + arrDelay}
        scheduledDepartS={d.departS}
        scheduledArriveS={d.arriveS}
        nowS={gone || stale ? undefined : secondsSinceMidnight(new Date(now))}
        live={live}
      />
      <div className="chips">
        <span className="route">{d.route}</span>
        <span className="muted">{d.headsign}</span>
        {gone && <Chip tone="bad">{d.canceled ? "Cancelled" : "Stop not served"}</Chip>}
      </div>
      {!gone && <LiveLine pack={pack} d={d} target="board" />}
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
  }, [route, pack], LIVE_REFRESH_MS);

  if (!pack) return <p className="notice">Loading timetable…</p>;
  const stopOptions = groups.map((g) => [g.key, g.name] as const);
  const picker = (key: "from" | "to") => (
    <RouteSelect label={key === "from" ? "From" : "To"} value={route[key]} options={stopOptions}
      onChange={(v) => setRoute({ ...route, [key]: v })} />
  );

  return (
    <section>
      <RouteBar
        from={picker("from")}
        to={picker("to")}
        onSwap={() => setRoute({ from: route.to, to: route.from })}
        side={<RefreshButton loading={loading} onRefresh={refresh} />}
      />
      {(error || data?.warning) && <p className="route-warning" role="status"><UpdatedText at={at} loading={false} stale /></p>}
      {packExpired(pack, new Date()) && <p className="route-warning">Bus timetable out of date</p>}
      {data &&
        (data.departures.length === 0 ? (
          <p className="notice">No direct buses in the next 12 h</p>
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
