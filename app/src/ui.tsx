// Shared UI pieces: auto-refresh, the status/refresh row, and a two-time trip line.

import { useCallback, useEffect, useState } from "react";
import { clock } from "./lib/predict";

export const REFRESH_MS = 60_000;

/** Runs `load` now, every minute while the app is visible, and on demand. */
export function useAutoRefresh<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `deps` comes from the caller: whatever the load function reads (e.g. chosen stops).
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    void run();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [run]);

  return { data, at, loading, error, refresh: run, setData };
}

export function StatusRow(props: { at: number | null; loading: boolean; stale: boolean; onRefresh: () => void }) {
  const time = props.at ? new Date(props.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="statusrow">
      <span className={`status ${props.stale ? "stale" : ""}`}>{time}</span>
      <button
        className={`refresh ${props.loading ? "spin" : ""}`}
        aria-label="Refresh"
        onClick={props.onRefresh}
        disabled={props.loading}
      >
        ↻
      </button>
    </div>
  );
}

/** "09:12 ~~09:10~~ → 09:38": best estimate, with the timetable struck through if different. */
export function Times(props: {
  departS: number;
  arriveS: number;
  scheduledDepartS: number;
  scheduledArriveS: number;
  size?: "big" | "small";
}) {
  const cls = props.size === "small" ? "mid" : "big";
  const changed = (a: number, b: number) => Math.round(a / 60) !== Math.round(b / 60);
  return (
    <div className="times">
      <div>
        <span className={cls}>{clock(props.departS)}</span>
        {changed(props.departS, props.scheduledDepartS) && <s>{clock(props.scheduledDepartS)}</s>}
      </div>
      <span className="arrow">→</span>
      <div className="arr">
        <span className={cls}>{clock(props.arriveS)}</span>
        {changed(props.arriveS, props.scheduledArriveS) && <s>{clock(props.scheduledArriveS)}</s>}
      </div>
    </div>
  );
}

/** Green-for-good colour band for live delays in minutes (null = no live data). */
export function delayTone(delayMin: number | null): "good" | "ok" | "bad" | "none" {
  if (delayMin === null) return "none";
  return delayMin <= 1 ? "good" : delayMin <= 5 ? "ok" : "bad";
}
