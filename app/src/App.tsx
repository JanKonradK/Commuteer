import { useCallback, useEffect, useMemo, useState } from "react";
import modelJson from "./model/delay-model.json";
import { type DeparturesResult, loadDepartures } from "./lib/departures";
import { api, type Station } from "./lib/irishRail";
import { DelayModel, type ModelJson } from "./lib/model";
import { clock, ON_TIME_LIMIT_MIN, type Prediction } from "./lib/predict";
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

function minutes(delay: number): string {
  const r = Math.round(delay);
  if (r === 0) return "on time";
  return r > 0 ? `${r} min late` : `${-r} min early`;
}

/** Timetable departure plus the board's lateness. (The board's own "expected
 * departure" field is sometimes inconsistent, e.g. earlier than the timetable.) */
function departure(p: Prediction): string {
  const [h, m] = p.train.schDepart.split(":").map(Number);
  return clock((h * 60 + m + Math.max(0, p.train.lateMin)) * 60);
}

function TrainCard({ p }: { p: Prediction }) {
  const [lo, mid, hi] = p.arrivalDelay;
  const at = (d: number) => clock(p.scheduledArrivalS + d * 60);
  const chance = Math.round(p.chanceOnTime * 20) * 5; // nearest 5%
  const tone = chance >= 80 ? "good" : chance >= 50 ? "ok" : "bad";
  return (
    <li className="card">
      <div className="row">
        <span className="time">{departure(p)}</span>
        <span className="dest">to {p.train.destination}</span>
        <span className="code">{p.train.code}</span>
      </div>
      <div className="muted">
        {p.train.lateMin > 0 ? `${p.train.lateMin} min late` : "On time"} · due in {p.train.dueInMin} min
        {p.train.lateMin > 0 && ` (timetable ${p.train.schDepart})`}
      </div>
      <div className="arrival">
        Arrives {p.toName} <strong>{at(mid)}</strong>
        <span className="muted"> (timetable {clock(p.scheduledArrivalS)})</span>
      </div>
      <div className="range">
        80% likely between {at(lo)} and {at(hi)}
        <span className={`pill ${tone}`}>
          {chance}% within {ON_TIME_LIMIT_MIN} min of timetable
        </span>
      </div>
      <div className="muted small">
        Delay last measured at {p.observedAt}: {minutes(p.currentDelayMin)}
      </div>
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
    <label>
      {label}
      <select value={commute[key]} onChange={(e) => setCommute({ ...commute, [key]: e.target.value })}>
        {stationOptions.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
  const stale = result && Date.now() - result.fetchedAt > 3 * REFRESH_MS;

  return (
    <main>
      <header>
        <h1>Commuteer</h1>
        <button className="refresh" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Updating…" : "Refresh"}
        </button>
      </header>

      <section className="commute">
        {picker("from", "From")}
        <button
          className="swap"
          aria-label="Swap stations"
          onClick={() => setCommute({ from: commute.to, to: commute.from })}
        >
          ⇅
        </button>
        {picker("to", "To")}
      </section>

      {error && (
        <p className="banner">
          {error}. {result ? "Showing the last trains loaded." : "Check your connection and try again."}
        </p>
      )}
      {commute.from === commute.to && <p className="banner">Pick two different stations.</p>}

      {result && (
        <>
          <p className={`muted small ${stale ? "stale" : ""}`}>
            Updated {new Date(result.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {stale && " · may be out of date"}
          </p>
          {result.predictions.length === 0 ? (
            <p className="empty">No direct trains in the next 90 minutes.</p>
          ) : (
            <ul>
              {result.predictions.map((p) => (
                <TrainCard key={`${p.train.code}-${p.train.trainDate}`} p={p} />
              ))}
            </ul>
          )}
        </>
      )}

      <footer className="muted small">
        Live data: Irish Rail. Arrival ranges come from a model trained on 8 weeks of real journeys and
        run on this phone.
      </footer>
    </main>
  );
}
