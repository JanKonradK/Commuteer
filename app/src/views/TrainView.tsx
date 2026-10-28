import { useEffect, useMemo, useState } from "react";
import { loadDepartures } from "../lib/departures";
import { api, type Station } from "../lib/irishRail";
import { DelayModel, type ModelJson } from "../lib/model";
import { clock, type Prediction } from "../lib/predict";
import { load, save } from "../lib/storage";
import modelJson from "../model/delay-model.json";
import { REFRESH_MS, StatusRow, Times, useAutoRefresh } from "../ui";

const FALLBACK_STATIONS: Station[] = [
  { code: "ATLNE", name: "Athlone", codes: ["ATLNE"] },
  { code: "HSTON", name: "Dublin Heuston", codes: ["HSTON"] },
];
const STATIONS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Timetable departure plus the board's lateness. (The board's own "expected
 * departure" field is sometimes inconsistent, e.g. earlier than the timetable.) */
function departureS(p: Prediction): number {
  const [h, m] = p.train.schDepart.split(":").map(Number);
  return (h * 60 + m + Math.max(0, p.train.lateMin)) * 60;
}

function tone(p: Prediction): "good" | "ok" | "bad" {
  return p.chanceOnTime >= 0.8 ? "good" : p.chanceOnTime >= 0.5 ? "ok" : "bad";
}

/** The likely arrival window drawn against the timetable (the white tick). */
function ArrivalWindow({ p }: { p: Prediction }) {
  const [lo, mid, hi] = p.arrivalDelay;
  const min = Math.min(lo, 0) - 2;
  const max = Math.max(hi, 0) + 2;
  const x = (d: number) => `${((d - min) / (max - min)) * 100}%`;
  const at = (d: number) => clock(p.scheduledArrivalS + d * 60);
  return (
    <div
      className="window"
      role="img"
      aria-label={`Likely arrival ${at(lo)} to ${at(hi)}; timetable ${clock(p.scheduledArrivalS)}`}
    >
      <div className="band" style={{ left: x(lo), width: `calc(${x(hi)} - ${x(lo)})` }} />
      <div className="tick" style={{ left: x(0) }} />
      <div className="dot" style={{ left: x(mid) }} />
    </div>
  );
}

function TrainCard({ p }: { p: Prediction }) {
  const [lo, mid, hi] = p.arrivalDelay;
  const [h, m] = p.train.schDepart.split(":").map(Number);
  return (
    <li className={`card ${tone(p)}`} aria-label={`Train ${p.train.code}`}>
      <Times
        departS={departureS(p)}
        scheduledDepartS={(h * 60 + m) * 60}
        arriveS={p.scheduledArrivalS + mid * 60}
        scheduledArriveS={p.scheduledArrivalS}
      />
      <span className="span">
        {clock(p.scheduledArrivalS + lo * 60)}–{clock(p.scheduledArrivalS + hi * 60)}
      </span>
      <ArrivalWindow p={p} />
    </li>
  );
}

export function TrainView() {
  const model = useMemo(() => new DelayModel(modelJson as ModelJson), []);
  const [stations, setStations] = useState<Station[]>(
    () => load("stations-v2", { at: 0, list: [] as Station[] }).list,
  );
  const [route, setRoute] = useState(() => load("commute", { from: "ATLNE", to: "HSTON" }));

  useEffect(() => {
    const cached = load("stations-v2", { at: 0, list: [] as Station[] });
    if (cached.list.length && Date.now() - cached.at < STATIONS_MAX_AGE_MS) return;
    api
      .stations()
      .then((list) => {
        setStations(list);
        save("stations-v2", { at: Date.now(), list });
      })
      .catch(() => undefined); // keep the cached or fallback list
  }, []);

  const options = stations.length ? stations : FALLBACK_STATIONS;
  const find = (code: string): Station =>
    options.find((s) => s.codes.includes(code)) ?? { code, name: code, codes: [code] };

  const { data, at, loading, error, refresh } = useAutoRefresh(async () => {
    save("commute", route);
    if (route.from === route.to) return null;
    const r = await loadDepartures(model, find(route.from), find(route.to));
    save("lastResult", r);
    return r;
  }, [route, stations]);
  const result = data ?? load("lastResult", null);
  const stale = !!error || (!!at && Date.now() - at > 3 * REFRESH_MS);

  const picker = (key: "from" | "to") => (
    <select aria-label={key} value={route[key]} onChange={(e) => setRoute({ ...route, [key]: e.target.value })}>
      {options.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name}
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
      <StatusRow at={at ?? result?.fetchedAt ?? null} loading={loading} stale={stale} onRefresh={refresh} />
      {error && !result && <p className="notice">⚠ {error}</p>}
      {result &&
        (result.predictions.length === 0 ? (
          <p className="notice">No direct trains · 90 min</p>
        ) : (
          <ul>
            {result.predictions.map((p) => (
              <TrainCard key={`${p.train.code}-${p.train.trainDate}`} p={p} />
            ))}
          </ul>
        ))}
    </section>
  );
}
