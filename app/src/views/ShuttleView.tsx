import { useMemo, useState } from "react";
import { load, save } from "../lib/storage";
import { busiestPair, parseRows, rowsToText, type Shuttle, shuttleStore, shuttleTrips, stopsOf } from "../lib/shuttles";
import { Times } from "../ui";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

function Editor(props: { shuttle: Shuttle; onSave: (s: Shuttle) => void; onDelete: () => void; onClose: () => void }) {
  const [s, setS] = useState(props.shuttle);
  const [text, setText] = useState(rowsToText(props.shuttle.rows));
  const rows = parseRows(text);
  return (
    <div className="sheet">
      <input aria-label="Name" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
      <div className="days">
        {DAYS.map((d, i) => (
          <button
            key={i}
            className={s.days.includes(i) ? "on" : ""}
            aria-pressed={s.days.includes(i)}
            onClick={() =>
              setS({ ...s, days: s.days.includes(i) ? s.days.filter((x) => x !== i) : [...s.days, i].sort() })
            }
          >
            {d}
          </button>
        ))}
      </div>
      <label className="inline">
        ⏱
        <input
          type="number"
          min={0}
          max={60}
          aria-label="Minutes between stops"
          value={s.travelMin ?? ""}
          placeholder="min"
          onChange={(e) => setS({ ...s, travelMin: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      </label>
      <textarea
        aria-label="Timetable"
        rows={12}
        value={text}
        placeholder={"07:45 Stop A\n08:00 Stop B\n12:00 Stop A *"}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="sheet-actions">
        <button onClick={props.onDelete} aria-label="Delete">
          🗑
        </button>
        <span className="muted">{rows.length}</span>
        <button onClick={props.onClose} aria-label="Cancel">
          ✕
        </button>
        <button className="primary" onClick={() => props.onSave({ ...s, rows })} aria-label="Save">
          ✓
        </button>
      </div>
    </div>
  );
}

export function ShuttleView(props: { shuttles: Shuttle[]; onChange: (list: Shuttle[]) => void }) {
  const list = props.shuttles;
  const [selected, setSelected] = useState(() => load("shuttleSel", { id: list[0]?.id ?? "", from: "", to: "" }));
  const [editing, setEditing] = useState<Shuttle | null>(null);
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

  const trips = useMemo(() => {
    if (!shuttle || !from || !to) return [];
    const now = new Date();
    const nowS = (now.getHours() * 60 + now.getMinutes()) * 60;
    return shuttleTrips(shuttle, from, to, now, nowS - 60).slice(0, 8);
  }, [shuttle, from, to]);

  const choose = (patch: Partial<typeof selected>) => {
    const next = { ...selected, id: shuttle?.id ?? "", from: from ?? "", to: to ?? "", ...patch };
    setSelected(next);
    save("shuttleSel", next);
  };
  const upsert = (s: Shuttle) => {
    const exists = list.some((x) => x.id === s.id);
    props.onChange(exists ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
    setEditing(null);
    choose({ id: s.id });
  };
  const blank = (): Shuttle => ({
    id: `s${Date.now()}`,
    name: "",
    days: [0, 1, 2, 3, 4],
    waitMin: 0,
    rows: [],
  });

  if (editing) {
    return (
      <Editor
        shuttle={editing}
        onSave={upsert}
        onClose={() => setEditing(null)}
        onDelete={() => {
          props.onChange(list.filter((x) => x.id !== editing.id));
          setEditing(null);
        }}
      />
    );
  }

  return (
    <section>
      <div className="pickers tools">
        <select aria-label="Shuttle" value={shuttle?.id ?? ""} onChange={(e) => choose({ id: e.target.value })}>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || "—"}
            </option>
          ))}
        </select>
        {shuttle && (
          <button aria-label="Edit" onClick={() => setEditing(shuttle)}>
            ✎
          </button>
        )}
        <button aria-label="Add" onClick={() => setEditing(blank())}>
          ＋
        </button>
      </div>
      {shuttle && from && to && (
        <div className="pickers">
          <select aria-label="from" value={from} onChange={(e) => choose({ from: e.target.value })}>
            {stops.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <button aria-label="Swap" onClick={() => choose({ from: to, to: from })}>
            ⇄
          </button>
          <select aria-label="to" value={to} onChange={(e) => choose({ to: e.target.value })}>
            {stops
              .filter((s) => s !== from)
              .map((s) => (
                <option key={s}>{s}</option>
              ))}
          </select>
        </div>
      )}
      {!shuttle && <p className="notice">＋</p>}
      {shuttle && trips.length === 0 && <p className="notice">—</p>}
      <ul>
        {trips.map((t) => (
          <li key={t.departS} className="card none">
            <Times departS={t.departS} arriveS={t.arriveS} scheduledDepartS={t.departS} scheduledArriveS={t.arriveS} />
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
