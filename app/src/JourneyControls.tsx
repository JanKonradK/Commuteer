import { useEffect, useState } from "react";
import type { BusPack } from "./lib/buses";
import type { Commute } from "./lib/commute";
import { followPhoneLocation, localDay, locate, routeKey, type JourneyState, type LocationFix } from "./lib/journey";
import type { Shuttle } from "./lib/shuttles";

export function JourneyControls(props: {
  commute: Commute; pack: BusPack; shuttles: Shuttle[];
  state: JourneyState; places: [string, string, string, string]; onChange: (state: JourneyState) => void;
}) {
  const { state, commute } = props;
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const read = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const position = await locate();
        if (!stopped && document.visibilityState === "visible") { setFix(position); setError(""); }
      } catch {
        if (!stopped) { setError("Phone location unavailable. Routes use the last known journey position."); setFix(null); }
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 20_000);
    document.addEventListener("visibilitychange", read);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, [retry]);
  useEffect(() => {
    if (!fix || state.route !== routeKey(commute) || state.day !== localDay(new Date())) return;
    const next = followPhoneLocation(state, commute, props.pack, fix);
    if (JSON.stringify(next) !== JSON.stringify(state)) props.onChange(next);
  }, [fix, state, commute, props.pack, props.onChange]);
  return <div className="location-status" role="status">
    <span>{error || (!fix ? "Getting your phone location…" : fix.accuracy > 100
      ? "Phone location is approximate. Waiting for a more accurate fix."
      : `Using phone location · accurate to about ${Math.round(fix.accuracy)} m`)}</span>
    {fix && <small>Updates automatically while Commute is open. Walking times from your location are estimates.</small>}
    <div className="journey-buttons">
      {error && <button onClick={() => setRetry((v) => v + 1)}>Retry location</button>}
      {state.chosen && <button onClick={() => props.onChange({ ...state, stage: "start", chosen: undefined, first: undefined, second: undefined, originFix: undefined })}>Clear chosen journey</button>}
    </div>
  </div>;
}
