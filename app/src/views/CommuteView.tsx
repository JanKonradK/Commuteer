import { useEffect, useMemo, useState } from "react";
import { type BusPack, groupStops, loadPack } from "../lib/buses";
import { type Commute, type Connection, commuteStore, connections, type Leg, type LegTrip, reverse } from "../lib/commute";
import { type Shuttle, stopsOf } from "../lib/shuttles";
import { Chip, delayText, delayTone, StatusRow, Time, Times, useAutoRefresh, secondsSinceMidnight } from "../ui";

function spareTone(min: number | null): "good" | "ok" | "bad" {
  if (min === null) return "bad";
  return min >= 5 ? "good" : min >= 2 ? "ok" : "bad";
}

function spareText(min: number | null): string {
  if (min === null) return "No connection";
  const m = Math.floor(min);
  return m <= 0 ? "Just makes it" : `${m} min to spare`;
}

const legName = (t: LegTrip) => (t.kind === "bus" ? `🚌 Bus ${t.label}` : `🚐 ${t.label}`);
const liveText = (t: LegTrip) =>
  t.kind === "bus" ? delayText(t.live ? (t.arriveS - t.scheduledArriveS) / 60 : null) : "";

/** One stop on the timeline: time | dot | place + what happens next. */
function Stop(props: { s: number; scheduledS?: number; place: string; children?: React.ReactNode; last?: boolean }) {
  return (
    <li className={`stop ${props.last ? "last" : ""}`}>
      <Time s={props.s} scheduledS={props.scheduledS} className="mid" />
      <span className="node" aria-hidden />
      <div>
        <div className="place">{props.place}</div>
        {props.children && <div className="what">{props.children}</div>}
      </div>
    </li>
  );
}

function ConnectionCard(props: {
  c: Connection;
  walkMin: number;
  places: [string, string, string, string];
  open: boolean;
  onToggle: () => void;
}) {
  const { c, places } = props;
  const last = c.second ?? c.first;
  const tone = spareTone(c.spareMin);
  return (
    <li className={`card ${tone}`}>
      <button className="card-head" onClick={props.onToggle} aria-expanded={props.open}>
        <Times
          departS={c.first.departS}
          scheduledDepartS={c.first.scheduledDepartS}
          arriveS={last.arriveS}
          scheduledArriveS={last.scheduledArriveS}
          nowS={secondsSinceMidnight()}
        />
        <div className="chips">
          <Chip tone={tone}>{spareText(c.spareMin)}</Chip>
          {c.first.kind === "bus" && (
            <Chip tone={c.first.live ? delayTone((c.first.arriveS - c.first.scheduledArriveS) / 60) : "none"}>
              {liveText(c.first)}
            </Chip>
          )}
          <span className="expand">{props.open ? "▴" : "▾"}</span>
        </div>
      </button>
      {props.open && (
        <ol className="timeline">
          <Stop s={c.first.departS} scheduledS={c.first.scheduledDepartS} place={places[0]}>
            {legName(c.first)}
          </Stop>
          <Stop s={c.first.arriveS} scheduledS={c.first.scheduledArriveS} place={places[1]}>
            🚶 {props.walkMin} min walk to {places[2]}
          </Stop>
          {c.second ? (
            <>
              <Stop s={c.second.departS} scheduledS={c.second.scheduledDepartS} place={places[2]}>
                {legName(c.second)} · <span className={`spare-text ${tone}`}>{spareText(c.spareMin)}</span>
              </Stop>
              <Stop s={c.second.arriveS} scheduledS={c.second.scheduledArriveS} place={places[3]} last />
            </>
          ) : (
            <li className="stop last">
              <span />
              <span className="node" aria-hidden />
              <div className="what">No later connection today</div>
            </li>
          )}
        </ol>
      )}
    </li>
  );
}

function LegEditor(props: {
  leg: Leg;
  pack: BusPack;
  shuttles: Shuttle[];
  onChange: (l: Leg) => void;
}) {
  const groups = useMemo(() => groupStops(props.pack), [props.pack]);
  const { leg } = props;
  const kind = (
    <select
      aria-label="Mode"
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
      <option value="bus">🚌 Bus</option>
      {props.shuttles.map((s) => (
        <option key={s.id} value={s.id}>
          🚐 {s.name}
        </option>
      ))}
    </select>
  );
  const shuttle = leg.kind === "shuttle" ? props.shuttles.find((s) => s.id === leg.id) : undefined;
  const options =
    leg.kind === "bus"
      ? groups.map((g) => [g.key, g.name] as const)
      : (shuttle ? stopsOf(shuttle) : []).map((s) => [s, s] as const);
  const pick = (key: "from" | "to") => (
    <select aria-label={key} value={leg[key]} onChange={(e) => props.onChange({ ...leg, [key]: e.target.value })}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
  return (
    <div className="leg-editor">
      {kind}
      {pick("from")}
      {pick("to")}
    </div>
  );
}

export function CommuteView({ shuttles }: { shuttles: Shuttle[] }) {
  const [pack, setPack] = useState<BusPack | null>(null);
  const [commute, setCommute] = useState<Commute>(commuteStore.get);
  const [editing, setEditing] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => {
    void loadPack().then(setPack);
  }, []);
  const update = (c: Commute) => {
    setCommute(c);
    commuteStore.set(c);
  };

  const { data, at, loading, error, refresh } = useAutoRefresh(
    async () => (pack ? connections(commute, pack, shuttles, new Date()) : null),
    [commute, pack, shuttles],
  );

  if (!pack) return <p className="notice">…</p>;
  const groups = groupStops(pack);
  const place = (l: Leg, end: "from" | "to") =>
    l.kind === "bus" ? (groups.find((g) => g.key === l[end])?.name ?? l[end]) : l[end];
  const places: [string, string, string, string] = [
    place(commute.legs[0], "from"),
    place(commute.legs[0], "to"),
    place(commute.legs[1], "from"),
    place(commute.legs[1], "to"),
  ];

  return (
    <section>
      <div className="pickers">
        <button className="route-title" onClick={() => setEditing(!editing)} aria-label="Edit commute">
          {places[0]} → {places[3]} <span className="muted">✎</span>
        </button>
        <button aria-label="Swap" onClick={() => update(reverse(commute))}>
          ⇄
        </button>
      </div>
      {editing && (
        <div className="sheet">
          <small className="muted">First</small>
          <LegEditor
            leg={commute.legs[0]}
            pack={pack}
            shuttles={shuttles}
            onChange={(l) => update({ ...commute, legs: [l, commute.legs[1]] })}
          />
          <label className="inline">
            🚶 Walk
            <input
              type="number"
              min={0}
              max={60}
              aria-label="Walking minutes"
              value={commute.walkMin}
              onChange={(e) => update({ ...commute, walkMin: Number(e.target.value) || 0 })}
            />
            min
          </label>
          <small className="muted">Then</small>
          <LegEditor
            leg={commute.legs[1]}
            pack={pack}
            shuttles={shuttles}
            onChange={(l) => update({ ...commute, legs: [commute.legs[0], l] })}
          />
        </div>
      )}
      <StatusRow at={at} loading={loading} stale={!!error} onRefresh={refresh} />
      {data && data.length === 0 && <p className="notice">—</p>}
      <ul>
        {data?.map((c, i) => {
          const key = `${c.first.scheduledDepartS}-${c.first.label}`;
          // The next trip is open by default; tap any other to see its steps.
          const open = openKey === null ? i === 0 : openKey === key;
          return (
            <ConnectionCard
              key={key}
              c={c}
              walkMin={commute.walkMin}
              places={places}
              open={open}
              onToggle={() => setOpenKey(open ? "" : key)}
            />
          );
        })}
      </ul>
    </section>
  );
}
