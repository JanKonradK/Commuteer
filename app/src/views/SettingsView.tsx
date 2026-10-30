import { useEffect, useMemo, useState } from "react";
import { type BusPack, groupStops, loadPack } from "../lib/buses";
import { type Commute, commuteStore, type Leg } from "../lib/commute";
import { type Shuttle, stopsOf } from "../lib/shuttles";
import { Icon } from "../icons";
import { LOCATION_FOLLOWING_MS, LOCATION_IDLE_MS } from "../JourneyControls";
import { WrapSelect } from "../ui";
import { type useUpdates, VersionLine } from "../UpdateBanner";
import { blankShuttle, daysText, ShuttleEditor } from "./ShuttleView";

/** Mode, then From and To, for one leg of the commute. */
function LegEditor(props: { title: string; leg: Leg; pack: BusPack; shuttles: Shuttle[]; onChange: (l: Leg) => void }) {
  const groups = useMemo(() => groupStops(props.pack), [props.pack]);
  const { leg } = props;
  const shuttle = leg.kind === "shuttle" ? props.shuttles.find((s) => s.id === leg.id) : undefined;
  const options =
    leg.kind === "bus"
      ? groups.map((g) => [g.key, g.name] as const)
      : (shuttle ? stopsOf(shuttle) : []).map((s) => [s, s] as const);
  const pick = (key: "from" | "to") => (
    <label className="field">
      <span>{key === "from" ? "From" : "To"}</span>
      <WrapSelect label={`${props.title} ${key}`} value={leg[key]} options={options}
        onChange={(v) => props.onChange({ ...leg, [key]: v })} />
    </label>
  );
  return (
    <fieldset className="leg-editor">
      <legend>{props.title}</legend>
      <label className="field wide">
        <span>Travel by</span>
        <select
          aria-label={`${props.title} mode`}
          value={leg.kind === "bus" ? "bus" : leg.id}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "bus") props.onChange({ kind: "bus", from: groups[0].key, to: groups[1].key });
            else {
              const s = props.shuttles.find((x) => x.id === v);
              const stops = s ? stopsOf(s) : [];
              props.onChange({ kind: "shuttle", id: v, from: stops[0] ?? "", to: stops[1] ?? "" });
            }
          }}
        >
          <option value="bus">Bus</option>
          {props.shuttles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || "Unnamed shuttle"}
            </option>
          ))}
        </select>
      </label>
      {pick("from")}
      {pick("to")}
    </fieldset>
  );
}

export function SettingsView(props: {
  shuttles: Shuttle[];
  onShuttlesChange: (list: Shuttle[]) => void;
  updates: ReturnType<typeof useUpdates>;
}) {
  const list = props.shuttles;
  const [pack, setPack] = useState<BusPack | null>(null);
  const [commute, setCommute] = useState<Commute>(commuteStore.get);
  const [editing, setEditing] = useState<Shuttle | null>(null);
  useEffect(() => {
    void loadPack().then(setPack);
  }, []);
  const update = (c: Commute) => {
    setCommute(c);
    commuteStore.set(c);
  };

  if (editing) {
    const close = () => { setEditing(null); window.scrollTo(0, 0); };
    return (
      <ShuttleEditor
        shuttle={editing}
        isNew={!list.some((x) => x.id === editing.id)}
        onSave={(s) => {
          props.onShuttlesChange(list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]);
          close();
        }}
        onDelete={() => {
          props.onShuttlesChange(list.filter((x) => x.id !== editing.id));
          close();
        }}
        onClose={close}
      />
    );
  }

  const open = (s: Shuttle) => { setEditing(s); window.scrollTo(0, 0); };
  return (
    <section>
      <h1 className="page-title">Settings</h1>

      <h2 className="group-title">Your commute</h2>
      <div className="group pad">
        {pack ? (
          <>
            <LegEditor title="First leg" leg={commute.legs[0]} pack={pack} shuttles={list}
              onChange={(l) => update({ ...commute, legs: [l, commute.legs[1]] })} />
            <label className="inline">
              Walk between them
              <input type="number" min={0} max={60} aria-label="Walking minutes" value={commute.walkMin}
                onChange={(e) => update({ ...commute, walkMin: Number(e.target.value) || 0 })} />
              min
            </label>
            <LegEditor title="Second leg" leg={commute.legs[1]} pack={pack} shuttles={list}
              onChange={(l) => update({ ...commute, legs: [commute.legs[0], l] })} />
            <p className="muted small hint">Saved as you go. Use the swap button on the Commute screen for the trip home.</p>
          </>
        ) : (
          <p className="muted">Loading bus stops…</p>
        )}
      </div>

      <h2 className="group-title">Shuttle timetables</h2>
      <ul className="group rows">
        {list.map((s) => (
          <li key={s.id}>
            <button className="row" onClick={() => open(s)}>
              <span className="row-text">
                <span>{s.name || "Unnamed shuttle"}</span>
                <small>{daysText(s.days)} · {stopsOf(s).length} stops</small>
              </span>
              <Icon name="next" size={18} />
            </button>
          </li>
        ))}
        <li>
          <button className="row add" onClick={() => open(blankShuttle())}>
            <Icon name="plus" size={18} />
            <span>Add a shuttle</span>
          </button>
        </li>
      </ul>

      <h2 className="group-title">Location and battery</h2>
      <div className="group pad text">
        <p>Your phone location tells Commuteer which stop you’ve reached, so it can update the rest of the journey.</p>
        <p className="muted small">
          Checked every {LOCATION_IDLE_MS / 60_000} min while Commute is open, every {LOCATION_FOLLOWING_MS / 1000} s
          while you follow a journey, and never while the app is in the background.
        </p>
      </div>

      <h2 className="group-title">About</h2>
      <div className="group pad">
        <VersionLine updates={props.updates} />
      </div>
    </section>
  );
}
