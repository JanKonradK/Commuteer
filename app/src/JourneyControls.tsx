import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { BusPack } from "./lib/buses";
import type { Commute } from "./lib/commute";
import { followPhoneLocation, localDay, locate, routeKey, type JourneyState, type LocationFix } from "./lib/journey";
import type { Shuttle } from "./lib/shuttles";

/** GPS is the biggest battery cost: check often only while following a chosen journey. */
export const LOCATION_FOLLOWING_MS = 20_000;
export const LOCATION_IDLE_MS = 120_000;

/** One compact line saying how the phone's location is being used. */
export function JourneyControls(props: {
  commute: Commute; pack: BusPack; shuttles: Shuttle[];
  state: JourneyState; places: [string, string, string, string]; onChange: (state: JourneyState) => void;
}) {
  const { state, commute } = props;
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const following = !!state.chosen;
  const every = useRef(following ? LOCATION_FOLLOWING_MS : LOCATION_IDLE_MS);
  every.current = following ? LOCATION_FOLLOWING_MS : LOCATION_IDLE_MS;
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const position = await locate();
        if (!stopped && document.visibilityState === "visible") { setFix(position); setError(""); }
      } catch {
        if (!stopped) { setError("Phone location unavailable"); setFix(null); }
      } finally { busy = false; }
    };
    // Re-arm after each reading; while the app is hidden, stop until it is visible again.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stopped || document.visibilityState === "hidden") return;
        void read();
        schedule();
      }, every.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      void read();
      schedule();
    };
    void read();
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [retry, following]);
  useEffect(() => {
    if (!fix || state.route !== routeKey(commute) || state.day !== localDay(new Date())) return;
    const next = followPhoneLocation(state, commute, props.pack, fix);
    if (JSON.stringify(next) !== JSON.stringify(state)) props.onChange(next);
  }, [fix, state, commute, props.pack, props.onChange]);

  const text = error
    ? error
    : !fix
      ? "Finding your location…"
      : fix.accuracy > 100
        ? "Location approximate"
        : `Using phone location · ±${Math.round(fix.accuracy)} m`;
  return (
    <div className={`location ${error ? "off" : ""}`} role="status"
      title="Walking times from your location are estimates. Location updates while Commute is open.">
      <Icon name="pin" size={16} />
      <span className="location-text">{text}</span>
      {error && <button className="link" onClick={() => setRetry((v) => v + 1)}>Retry</button>}
    </div>
  );
}
