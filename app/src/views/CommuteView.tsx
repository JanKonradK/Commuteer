import { useEffect, useMemo, useState } from "react";
import { BusDetails } from "../BusDetails";
import { JourneyControls } from "../JourneyControls";
import { currentJourney, isChosen, localDay, routeKey, saveJourney, type JourneyState } from "../lib/journey";
import { type BusPack, busTimeSource, groupStops, loadPack, packExpired } from "../lib/buses";
import { type Commute, type Connection, commuteStore, planCommute, type Leg, type LegTrip, reverse } from "../lib/commute";
import { clock } from "../lib/predict";
import { type Shuttle, stopsOf } from "../lib/shuttles";
import { Chip, delayText, delayTone, StatusRow, Time, Times, useAutoRefresh, secondsSinceMidnight, useNow } from "../ui";

function spareTone(min: number | null): "good" | "ok" | "bad" {
  if (min === null) return "bad";
  return min >= 5 ? "good" : min >= 2 ? "ok" : "bad";
}

function spareText(min: number | null): string {
  if (min === null) return "No connection";
  const m = Math.floor(min);
  return m <= 0 ? "Just makes it" : `${m} min to spare`;
}

const legName = (t: LegTrip) => (t.kind === "bus" ? `🚌 Bus ${t.label}` : t.kind === "walk" ? "Your current position" : `🚐 ${t.label}`);
const timeSource = (t: LegTrip, end: "departure" | "arrival") => t.userEstimate ? "Your estimate" : t.kind === "shuttle"
  ? "Shuttle timetable"
  : busTimeSource(end === "departure" ? t.busInfo?.departureUpdate : t.busInfo?.arrivalUpdate);
const liveText = (t: LegTrip) => {
  if (t.kind !== "bus") return "";
  const delayMin = t.live ? (t.arriveS - t.scheduledArriveS) / 60 : null;
  const label = delayMin !== null && Math.round(delayMin) === 0 ? "No delay reported" : delayText(delayMin);
  return `${t.busInfo?.arrivalUpdate?.source === "carried" ? "Estimated · " : t.live ? "Stop update · " : ""}${label}`;
};

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

export function ConnectionCard(props: {
  c: Connection;
  walkMin: number;
  places: [string, string, string, string];
  open: boolean;
  onToggle: () => void;
  pack: BusPack;
  now: number;
  stale: boolean;
  fastest: boolean;
  chosen?: boolean;
  onChoose?: () => void;
}) {
  const { c, places } = props;
  const last = c.second ?? c.first;
  const tone = c.overnight || c.longWait ? "bad" : c.positionUncertain ? "ok" : spareTone(c.spareMin);
  const remaining = c.stage === "first" || c.first.kind === "walk";
  return (
    <li className={`card ${tone}`}>
      <button className="card-head" onClick={props.onToggle} aria-expanded={props.open}>
        <Times
          departS={remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.departS}
          scheduledDepartS={remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.scheduledDepartS}
          arriveS={last.arriveS}
          scheduledArriveS={last.scheduledArriveS}
          nowS={props.stale ? undefined : secondsSinceMidnight(new Date(props.now))}
          departLabel={remaining ? "Continue from now" : props.stale ? "Leave · last update" : `Leave · ${timeSource(c.first, "departure").toLowerCase()}`}
          arriveLabel={!c.second ? "Transfer only" : c.second.arriveS >= 86400 ? "Arrive · tomorrow" : props.stale ? "Arrive · last update" : `Arrive · ${timeSource(last, "arrival").toLowerCase()}`}
        />
        <div className="chips">
          <Chip tone={tone}>{c.overnight ? "Overnight wait · next day" : c.longWait ? "Long wait" : c.positionUncertain ? "Location update needed" : spareText(c.spareMin)}</Chip>
          {props.chosen && <Chip tone="good">Your chosen journey</Chip>}
          {props.fastest && c.second && !c.overnight && !c.longWait && !c.positionUncertain && <Chip tone="good">Earliest arrival</Chip>}
          {[c.first, c.second].filter((t): t is LegTrip => t !== null && t.kind === "bus").map((t, i) => (
            <Chip key={i} tone={props.stale ? "none" : t.live ? delayTone((t.arriveS - t.scheduledArriveS) / 60) : "none"}>
              Bus {t.label} · {props.stale ? "Last known times" : liveText(t)}
            </Chip>
          ))}
          <span className="expand">{props.open ? "▴" : "▾"}</span>
        </div>
      </button>
      {c.second && <div className="journey-stats">
        <span>{Math.max(0, Math.ceil((c.second.arriveS - (remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.departS)) / 60))} min {remaining ? "remaining" : "total"}</span>
        <span>{props.walkMin} min walk</span>
        <span>{Math.max(0, Math.floor(c.spareMin ?? 0))} min wait</span>
      </div>}
      {props.onChoose && c.second && <button className="choose-journey" onClick={props.onChoose} aria-pressed={!!props.chosen}>
        {props.chosen ? "Journey selected" : "Choose this journey"}
      </button>}
      {c.overnight && <p className="route-warning">This connection is tomorrow. It does not catch tonight’s bus.</p>}
      {c.positionUncertain && <p className="route-warning">The first-leg timetable arrival has passed. The remaining connection is an estimate while phone location updates.</p>}
      {c.changedFrom && <p className="muted small bus-estimate-note" role="status">
        Connection changed after live updates. {c.second ? `Take ${legName(c.second)} at ${clock(c.second.departS)}.` : "No later connection is available."}
      </p>}
      {props.open && <>
        {(c.first.busInfo?.arrivalUpdate?.source === "carried" || c.second?.busInfo?.departureUpdate?.source === "carried") && (
          <p className="muted small bus-estimate-note">Connection uses an estimated bus time. Allow extra time.</p>
        )}
        <ol className="timeline">
          {c.first.kind !== "walk" && <Stop s={c.first.departS} scheduledS={c.first.scheduledDepartS} place={places[0]}>
            {legName(c.first)} · leave · {timeSource(c.first, "departure")}
          </Stop>}
          <Stop s={Math.max(c.first.arriveS, remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.arriveS)}
            scheduledS={c.first.kind === "walk" ? undefined : c.first.scheduledArriveS}
            place={c.first.kind === "walk" ? "Your location" : places[1]}>
            {c.first.kind === "walk" ? "You are here" : `Arrive · ${timeSource(c.first, "arrival")}`}<br />
            {c.stage === "second" ? "Following your chosen second leg" : props.walkMin > 0 ? `🚶 ${props.walkMin} min walk to ${places[2]} · ready at ${clock(Math.max(c.first.arriveS, remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.arriveS) + props.walkMin * 60)}` : "Ready to board here"}
          </Stop>
          {c.second ? (
            <>
              {c.stage !== "second" && <Stop s={c.second.departS} scheduledS={c.second.scheduledDepartS} place={places[2]}>
                {legName(c.second)} · leave · {timeSource(c.second, "departure")}<br />
                <span className={`spare-text ${tone}`}>{c.overnight ? "Tomorrow · overnight wait" : c.longWait ? `${Math.floor((c.spareMin ?? 0) / 60)} h ${Math.floor((c.spareMin ?? 0) % 60)} min wait` : spareText(c.spareMin)}</span>
              </Stop>}
              <Stop s={c.second.arriveS} scheduledS={c.second.scheduledArriveS} place={places[3]} last>
                Arrive · {timeSource(c.second, "arrival")}
              </Stop>
            </>
          ) : (
            <li className="stop last">
              <span />
              <span className="node" aria-hidden />
              <div className="what">No later connection today</div>
            </li>
          )}
        </ol>
        {c.first.busInfo && <BusDetails d={c.first.busInfo} pack={props.pack} />}
        {c.second?.busInfo && <BusDetails d={c.second.busInfo} pack={props.pack} />}
      </>}
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
  const now = useNow();
  const [pack, setPack] = useState<BusPack | null>(null);
  const [commute, setCommute] = useState<Commute>(commuteStore.get);
  const [journey, setJourney] = useState(() => currentJourney(commute, new Date()));
  const [editing, setEditing] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  useEffect(() => {
    void loadPack().then(setPack);
  }, []);
  useEffect(() => {
    if (journey.route !== routeKey(commute) || journey.day !== localDay(new Date(now))) {
      setJourney(currentJourney(commute, new Date(now)));
    }
  }, [commute, journey, now]);
  const updateJourney = (state: JourneyState) => { setJourney(state); saveJourney(state); setOpenKey(null); };
  const update = (c: Commute) => {
    setCommute(c);
    commuteStore.set(c);
    setOpenKey(null);
  };

  const { data, at, loading, error, refresh } = useAutoRefresh(
    async () => (pack ? planCommute(commute, pack, shuttles, new Date(), 4, journey) : null),
    [commute, pack, shuttles, journey],
  );

  if (!pack) return <p className="notice">…</p>;
  const stale = !!error || !!(data && (now - data.fetchedAt > 180_000 || (data.feedAt && now - data.feedAt > 300_000)));
  const nowS = secondsSinceMidnight(new Date(now));
  const options = data?.connections.filter((c) =>
    (c.stage === "first" || c.first.kind === "walk" || c.first.departS >= nowS) && (c.stage === "second" || !c.second || c.second.departS >= nowS),
  ) ?? [];
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
      <JourneyControls key={routeKey(commute)} commute={commute} pack={pack} shuttles={shuttles}
        state={journey} places={places} onChange={updateJourney} />
      {journey.chosen && !options.some((c) => isChosen(journey, c)) && !loading && <p className="route-warning" role="status">
        Your chosen connection has changed. Routes recalculate automatically from your phone location.
      </p>}
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
      <div className="commute-actions">
        <button className="calculate" onClick={refresh} disabled={loading}>{loading ? "Calculating…" : "Calculate routes"}</button>
        <StatusRow at={at} loading={loading} stale={!!error} onRefresh={refresh} />
      </div>
      <p className="muted small bus-estimate-note">Routes use the latest available bus times, your shuttle timetable, and the walk between stops. Updates every minute.</p>
      {data?.warnings.map((warning) => <p className="route-warning" role="status" key={warning}>{warning}</p>)}
      {stale && <p className="route-warning" role="status">Times are out of date. Recalculate before you leave.</p>}
      {packExpired(pack, new Date(now)) && <p className="route-warning">Bus timetable out of date. Route options may be incomplete.</p>}
      {commute.legs.some((l) => l.kind === "shuttle" && !shuttles.some((s) => s.id === l.id)) && (
        <p className="route-warning">Add or select your shuttle timetable to calculate the full commute.</p>
      )}
      {data && options.length === 0 && <p className="notice">No route found for the selected stops and timetables. Change the stops or refresh for new times.</p>}
      <ul>
        {options.map((c, i) => {
          const key = `${c.first.busInfo?.tripId ?? c.first.label}-${c.first.scheduledDepartS}`;
          // The next trip is open by default; tap any other to see its steps.
          const open = openKey === null ? i === 0 : openKey === key;
          return (
            <ConnectionCard
              key={key}
              c={c}
              pack={pack}
              walkMin={data?.walkMin ?? commute.walkMin}
              now={now}
              stale={stale}
              fastest={i === 0}
              chosen={isChosen(journey, c)}
              onChoose={() => updateJourney({ ...journey, chosen: c, first: c.first, originFix: undefined })}
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
