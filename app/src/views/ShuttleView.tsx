import { useMemo, useState } from "react";
import { load, save } from "../lib/storage";
import { busiestPair, parseRows, rowsToText, type Shuttle, shuttleStore, shuttleTrips, stopsOf } from "../lib/shuttles";
import { RouteBar, RouteSelect, Times, secondsSinceMidnight, useNow } from "../ui";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function ShuttleEditor(props: { shuttle: Shuttle; isNew: boolean; onSave: (s: Shuttle) => void; onDelete: () => void; onClose: () => void }) {
  const [s, setS] = useState(props.shuttle);
  const [text, setText] = useState(rowsToText(props.shuttle.rows));
  const rows = parseRows(text);
  return (
    <div className="sheet">
      <h2 className="sheet-title">{props.isNew ? "New shuttle" : "Edit shuttle"}</h2>
      <label className="field">
        <span>Name</span>
        <input aria-label="Name" value={s.name} placeholder="e.g. Work shuttle" onChange={(e) => setS({ ...s, name: e.target.value })} />
      </label>
      <div className="field">
        <span>Runs on</span>
        <div className="days">
          {DAYS.map((d, i) => (
            <button
              key={i}
              className={s.days.includes(i) ? "on" : ""}
              aria-pressed={s.days.includes(i)}
              aria-label={DAY_NAMES[i]}
              onClick={() =>
                setS({ ...s, days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })
              }
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <label className="inline">
        Minutes between stops
        <input
          type="number"
          min={0}
          max={60}
          aria-label="Minutes between stops"
          value={s.travelMin ?? ""}
          placeholder="auto"
          onChange={(e) => setS({ ...s, travelMin: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span>Timetable · one stop per line: time, then stop name</span>
        <textarea
          aria-label="Timetable"
          rows={10}
          value={text}
          placeholder={"07:45 Stop A\n08:00 Stop B\n12:00 Stop A *"}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <small className="muted">
        {rows.length === 1 ? "1 stop time" : `${rows.length} stop times`} recognised. End a line with * for a drop-off-only stop.
      </small>
      <div className="sheet-actions">
        {!props.isNew && (
          <button
            className="danger"
            onClick={() => {
              if (window.confirm(`Delete ${s.name || "this shuttle"}?`)) props.onDelete();
            }}
          >
            Delete
          </button>
        )}
        <span />
        <button onClick={props.onClose}>Cancel</button>
        <button className="primary" onClick={() => props.onSave({ ...s, rows })} disabled={!rows.length}>
          Save
        </button>
      </div>
    </div>
  );
}

/** "Mon–Fri", "Every day", "Weekends" or "Mon, Wed, Fri". */
export function daysText(days: number[]): string {
  const key = [...days].sort().join("");
  if (key === "0123456") return "Every day";
  if (key === "01234") return "Mon–Fri";
  if (key === "56") return "Weekends";
  if (!days.length) return "No days set";
  return [...days].sort().map((d) => DAY_NAMES[d].slice(0, 3)).join(", ");
}

export const blankShuttle = (): Shuttle => ({
  id: `s${Date.now()}`,
  name: "",
  days: [0, 1, 2, 3, 4],
  waitMin: 0,
  rows: [],
});

/** Upcoming shuttles between two stops. Timetables are edited in Settings. */
export function ShuttleView(props: { shuttles: Shuttle[]; onOpenSettings: () => void }) {
  const list = props.shuttles;
  const [selected, setSelected] = useState(() => load("shuttleSel", { id: list[0]?.id ?? "", from: "", to: "" }));
  const shuttle = list.find((s) => s.id === selected.id) ?? list[0];
  const stops = shuttle ? stopsOf(shuttle) : [];
  const pair = shuttle ? busiestPair(shuttle) : null;
  const from = stops.includes(selected.from) ? selected.from : (pair?.[0] ?? stops[0]);
  const to =
    stops.includes(selected.to) && selected.to !== from
      ? selected.to
      : pair && pair[0] === from
        ? pair[1]
        : stops.find((s) => s !== from);

  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const trips = useMemo(() => {
    if (!shuttle || !from || !to) return [];
    const date = new Date(minute * 60_000);
    const nowS = (date.getHours() * 60 + date.getMinutes()) * 60;
    return shuttleTrips(shuttle, from, to, date, nowS - 60).slice(0, 8);
  }, [shuttle, from, to, minute]);

  const choose = (patch: Partial<typeof selected>) => {
    const next = { ...selected, id: shuttle?.id ?? "", from: from ?? "", to: to ?? "", ...patch };
    setSelected(next);
    save("shuttleSel", next);
  };

  if (!shuttle) {
    return (
      <div className="empty">
        <p>No shuttle timetables yet.</p>
        <p className="muted small">Add the timetable for a work or private shuttle and Commuteer will plan connections to it.</p>
        <button className="primary" onClick={props.onOpenSettings}>Add one in Settings</button>
      </div>
    );
  }

  return (
    <section>
      {list.length > 1 && (
        <div className="choices" role="radiogroup" aria-label="Shuttle">
          {list.map((s) => (
            <button key={s.id} role="radio" aria-checked={s.id === shuttle.id}
              className={s.id === shuttle.id ? "on" : ""} onClick={() => choose({ id: s.id })}>
              {s.name || "Unnamed shuttle"}
            </button>
          ))}
        </div>
      )}
      {from && to && (
        <RouteBar
          from={<RouteSelect label="From" value={from} options={stops.map((s) => [s, s] as const)} onChange={(v) => choose({ from: v })} />}
          to={<RouteSelect label="To" value={to} options={stops.filter((s) => s !== from).map((s) => [s, s] as const)} onChange={(v) => choose({ to: v })} />}
          onSwap={() => choose({ from: to, to: from })}
        />
      )}
      <div className="meta">
        <span>{shuttle.name || "Shuttle"} · {daysText(shuttle.days)}</span>
        <button className="link" onClick={props.onOpenSettings}>Edit timetable</button>
      </div>
      {trips.length === 0 && <p className="notice">No more shuttles between these stops today.</p>}
      <ul>
        {trips.map((t) => (
          <li key={t.departS} className="card none">
            <Times departS={t.departS} arriveS={t.arriveS} scheduledDepartS={t.departS} scheduledArriveS={t.arriveS} nowS={secondsSinceMidnight(new Date(now))} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function useShuttles() {
  const [list, setList] = useState<Shuttle[]>(shuttleStore.all);
  const update = (next: Shuttle[]) => {
    setList(next);
    shuttleStore.save(next);
  };
  return [list, update] as const;
}
