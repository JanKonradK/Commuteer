import { useState } from "react";
import type { BusPack } from "./lib/buses";
import type { Commute, JourneyStage } from "./lib/commute";
import { journeyAnchors, locate, nearbyPlaces, rememberPlace, type JourneyState, type LocationFix } from "./lib/journey";
import { shuttleTrips, type Shuttle } from "./lib/shuttles";
import { clock } from "./lib/predict";

export function JourneyControls(props: {
  commute: Commute; pack: BusPack; shuttles: Shuttle[];
  state: JourneyState; places: [string, string, string, string]; onChange: (state: JourneyState) => void;
}) {
  const { state, places, commute } = props;
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const first = commute.legs[0];
  const shuttle = first.kind === "shuttle" ? props.shuttles.find((s) => s.id === first.id) : null;
  const now = new Date();
  const nowS = (now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds();
  const recent = shuttle ? shuttleTrips(shuttle, first.from, first.to, now, nowS - 7200)
    .filter((t) => t.departS <= nowS).reverse() : [];
  const stages: [JourneyStage, string][] = [["start", `At ${places[0]}`], ["first", "On my first leg"],
    ["transfer", `At ${places[1]}`], ["secondStop", `At ${places[2]} · ready to board`]];
  const setStage = (stage: JourneyStage) => {
    setMessage("");
    const picked = state.first ?? state.chosen?.first;
    props.onChange({ ...state, stage, first: stage === "first" && picked?.kind !== "walk" ? picked : undefined });
  };
  const useLocation = async () => {
    setBusy(true); setMessage("");
    try {
      const position = await locate(); setFix(position);
      setMessage(position.accuracy > 200 ? "Location is too approximate to identify a stop. Select your position manually." : "Location found. Confirm your position below.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Cannot get your location. Select your position manually.");
    } finally { setBusy(false); }
  };
  const nearby = fix ? nearbyPlaces(fix, journeyAnchors(commute, props.pack)) : [];
  const currentName = state.stage === "start" ? places[0] : state.stage === "transfer" ? places[1] : state.stage === "secondStop" ? places[2] : null;
  return <div className="journey-controls">
    <label>Where are you now?
      <select aria-label="Journey position" value={state.stage} onChange={(e) => setStage(e.target.value as JourneyStage)}>
        {stages.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
    </label>
    {state.stage === "first" && shuttle && <label>Which shuttle did you board?
      <select aria-label="Boarded shuttle departure" value={state.first?.scheduledDepartS ?? ""} onChange={(e) => {
        const t = recent.find((r) => r.departS === Number(e.target.value));
        if (t) props.onChange({ ...state, first: { kind: "shuttle", label: shuttle.name,
          departS: t.departS, arriveS: t.arriveS, scheduledDepartS: t.departS,
          scheduledArriveS: t.arriveS, live: false, canceled: false } });
      }}>
        <option value="">Select the departure you boarded</option>
        {state.first && !recent.some((t) => t.departS === state.first?.scheduledDepartS) && <option value={state.first.scheduledDepartS}>Your chosen first leg</option>}
        {recent.map((t) => <option key={t.departS} value={t.departS}>{clock(t.departS)} from {places[0]}</option>)}
      </select>
    </label>}
    {state.stage === "first" && !state.first && <p className="small" role="status">Select the departure you boarded. Bus journeys need a route selected before boarding.</p>}
    {state.stage === "first" && state.first?.kind === "shuttle" && <label>Expected arrival at {places[1]} · edit if your shuttle is late
      <input type="time" aria-label="First leg expected arrival" value={clock(state.first.arriveS)} onChange={(e) => {
        if (!e.target.value || !state.first) return;
        const [h, m] = e.target.value.split(":").map(Number);
        let arriveS = (h * 60 + m) * 60;
        if (state.first.departS - arriveS > 43200) arriveS += 86400;
        if (arriveS < state.first.departS) { setMessage("Arrival must be after departure."); return; }
        props.onChange({ ...state, first: { ...state.first, arriveS, userEstimate: true } });
      }} />
    </label>}
    <div className="journey-buttons">
      <button onClick={useLocation} disabled={busy}>{busy ? "Finding location…" : "Use my location"}</button>
      {state.chosen && <button onClick={() => props.onChange({ ...state, stage: "start", chosen: undefined, first: undefined })}>Clear chosen journey</button>}
    </div>
    <p className="muted small bus-estimate-note">Location is optional. It stays on your phone. Confirm your stop; location alone does not mean you boarded.</p>
    {message && <p className="small" role="status">{message}</p>}
    {nearby.map((p) => <button key={p.stage} onClick={() => setStage(p.stage)}>
      I’m at {p.name} · about {Math.round(p.distance)} m away
    </button>)}
    {fix && currentName && fix.accuracy <= 100 && Date.now() - fix.timestamp < 60000 && <button onClick={() => {
      rememberPlace(currentName, fix); setMessage(`Location saved on this phone for ${currentName}.`);
    }}>Remember this location for {currentName}</button>}
    {state.stage === "first" && <p className="small bus-estimate-note">Tracking your first leg. If you arrive early or late, select the stop you have reached.</p>}
  </div>;
}
