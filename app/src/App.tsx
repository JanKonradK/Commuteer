import { useCallback, useEffect, useMemo, useState } from "react";
import modelJson from "./model/delay-model.json";
import { type DeparturesResult, loadDepartures } from "./lib/departures";
import { api, type Station } from "./lib/irishRail";
import { DelayModel, type ModelJson } from "./lib/model";
import { clock, type Prediction } from "./lib/predict";
import { load, save } from "./lib/storage";

const REFRESH_MS = 60_000;
const FALLBACK_STATIONS: Station[] = [
  { code: "ATLNE", name: "Athlone", codes: ["ATLNE"] },
  { code: "HSTON", name: "Dublin Heuston", codes: ["HSTON"] },
];
const STATIONS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

interface Commute {
  from: string;
  to: string;
}

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
  const at = (d: number) => clock(p.scheduledArrivalS + d * 60);
  const late = p.train.lateMin > 0;
  const arrivalShift = Math.round(mid) !== 0;
  return (
    <li className={`card ${tone(p)}`} aria-label={`Train ${p.train.code}`}>
      <div className="times">
        <div>
          <span className="big">{clock(departureS(p))}</span>
          {late && <s>{p.train.schDepart}</s>}
        </div>
        <span className="arrow">→</span>
        <div className="arr">
          <span className="big">{at(mid)}</span>
          {arrivalShift && <s>{clock(p.scheduledArrivalS)}</s>}
          <span className="span">
            {at(lo)}–{at(hi)}
          </span>
        </div>
      </div>
      <ArrivalWindow p={p} />
    </li>
  );
}

export default function App() {
  const model = useMemo(() => new DelayModel(modelJson as ModelJson), []);
  const [stations, setStations] = useState<Station[]>(() => load("stations-v2", { at: 0, list: [] as Station[] }).list);
  const [commute, setCommute] = useState<Commute>(() => load("commute", { from: "ATLNE", to: "HSTON" }));
  const [result, setResult] = useState<DeparturesResult | null>(() => load("lastResult", null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = load("stations-v2", { at: 0, list: [] as Station[] });
    if (cached.list.length && Date.now() - cached.at < STATIONS_MAX_AGE_MS) return;
    api
      .stations()
      .then((list) => {
        setStations(list);
        save("stations-v2", { at: Date.now(), list });
      })
      .catch(() => {
        /* keep the cached list; the error banner covers departures */
      });
  }, []);

  const stationOptions: Station[] = stations.length ? stations : FALLBACK_STATIONS;
  const find = (code: string): Station =>
    stationOptions.find((s) => s.codes.includes(code)) ?? { code, name: code, codes: [code] };

  const refresh = useCallback(async () => {
    if (!commute.from || !commute.to || commute.from === commute.to) return;
    setLoading(true);
    try {
      const r = await loadDepartures(model, find(commute.from), find(commute.to));
      setResult(r);
      save("lastResult", r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load trains");
    } finally {
      setLoading(false);
    }
    // `find` reads the station list, so refresh when it changes.
  }, [model, commute, stations]);

  useEffect(() => {
    save("commute", commute);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [commute, refresh]);

  const picker = (key: keyof Commute, label: string) => (
    <select
      aria-label={label}
      value={commute[key]}
      onChange={(e) => setCommute({ ...commute, [key]: e.target.value })}
    >
      {stationOptions.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name}
        </option>
      ))}
    </select>
  );
  const stale = !!result && (!!error || Date.now() - result.fetchedAt > 3 * REFRESH_MS);
  const updated = result
    ? new Date(result.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <main>
      <header>
        <h1>Commuteer</h1>
        {result && <span className={`status ${stale ? "stale" : ""}`}>{updated}</span>}
        <button
          className={`refresh ${loading ? "spin" : ""}`}
          aria-label="Refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          ↻
        </button>
      </header>

      <section className="commute">
        {picker("from", "From")}
        <button
          className="swap"
          aria-label="Swap stations"
          onClick={() => setCommute({ from: commute.to, to: commute.from })}
        >
          ⇄
        </button>
        {picker("to", "To")}
      </section>

      {error && !result && <p className="notice">⚠ {error}</p>}
      {commute.from === commute.to && <p className="notice">⇄</p>}

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
    </main>
  );
}
