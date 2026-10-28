import { useEffect, useMemo, useState } from "react";
import { type BusPack, groupStops, loadPack } from "../lib/buses";
import { type Commute, type Connection, commuteStore, connections, type Leg, reverse } from "../lib/commute";
import { clock } from "../lib/predict";
import { type Shuttle, stopsOf } from "../lib/shuttles";
import { StatusRow, Times, useAutoRefresh } from "../ui";

function spareTone(min: number | null): "good" | "ok" | "bad" {
  if (min === null) return "bad";
  return min >= 5 ? "good" : min >= 2 ? "ok" : "bad";
}

/** Journey drawn to scale: ride, walk, wait (coloured by spare time), ride. */
function Strip({ c, walkMin }: { c: Connection; walkMin: number }) {
  const start = c.first.departS;
  const end = c.second ? c.second.arriveS : c.first.arriveS + walkMin * 60;
  const pct = (s: number) => `${Math.max(0, (s / (end - start)) * 100)}%`;
  const ride1 = c.first.arriveS - c.first.departS;
  const walk = walkMin * 60;
  const wait = c.second ? c.second.departS - c.first.arriveS - walk : 0;
  const ride2 = c.second ? c.second.arriveS - c.second.departS : 0;
  const icon = (kind: string) => (kind === "bus" ? "🚌" : "🚐");
  return (
    <div className="strip" role="img" aria-label={`Spare ${c.spareMin === null ? "none" : Math.round(c.spareMin)} min`}>
      <div className={`seg ride ${c.first.kind}`} style={{ width: pct(ride1) }}>
        {icon(c.first.kind)} {c.first.kind === "bus" ? c.first.label : ""}
      </div>
      <div className="seg walk" style={{ width: pct(walk) }}>
        🚶
      </div>
      {c.second && wait > 0 && <div className={`seg wait ${spareTone(c.spareMin)}`} style={{ width: pct(wait) }} />}
      {c.second && (
        <div className={`seg ride ${c.second.kind}`} style={{ width: pct(ride2) }}>
          {icon(c.second.kind)} {c.second.kind === "bus" ? c.second.label : ""}
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ c, walkMin }: { c: Connection; walkMin: number }) {
  const last = c.second ?? c.first;
  return (
    <li className={`card ${spareTone(c.spareMin)}`}>
      <Times
        departS={c.first.departS}
        scheduledDepartS={c.first.scheduledDepartS}
        arriveS={last.arriveS}
        scheduledArriveS={last.scheduledArriveS}
      />
      <Strip c={c} walkMin={walkMin} />
      <div className="legs">
        <span>{clock(c.first.arriveS)}</span>
        {c.second ? (
          <span className={`spare ${spareTone(c.spareMin)}`}>+{Math.max(0, Math.round(c.spareMin ?? 0))}′</span>
        ) : (
          <span className="spare bad">✕</span>
        )}
        <span>{c.second ? clock(c.second.departS) : ""}</span>
        <span className={`live ${c.first.live ? "on" : ""}`} aria-label={c.first.live ? "Live" : "Timetable only"} />
      </div>
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
      <option value="bus">🚌</option>
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
  const name = (l: Leg) =>
    l.kind === "bus" ? (groupStops(pack).find((g) => g.key === l.from)?.name ?? l.from) : l.from;
  const lastStop = (l: Leg) =>
    l.kind === "bus" ? (groupStops(pack).find((g) => g.key === l.to)?.name ?? l.to) : l.to;

  return (
    <section>
      <div className="pickers">
        <button className="route-title" onClick={() => setEditing(!editing)} aria-label="Edit commute">
          {name(commute.legs[0])} → {lastStop(commute.legs[1])}
        </button>
        <button aria-label="Swap" onClick={() => update(reverse(commute))}>
          ⇄
        </button>
      </div>
      {editing && (
        <div className="sheet">
          <LegEditor
            leg={commute.legs[0]}
            pack={pack}
            shuttles={shuttles}
            onChange={(l) => update({ ...commute, legs: [l, commute.legs[1]] })}
          />
          <label className="inline">
            🚶
            <input
              type="number"
              min={0}
              max={60}
              aria-label="Walking minutes"
              value={commute.walkMin}
              onChange={(e) => update({ ...commute, walkMin: Number(e.target.value) || 0 })}
            />
            ′
          </label>
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
        {data?.map((c) => (
          <ConnectionCard key={`${c.first.scheduledDepartS}-${c.first.label}`} c={c} walkMin={commute.walkMin} />
        ))}
      </ul>
    </section>
  );
}
