// Shared UI pieces: auto-refresh, the status/refresh row, and a two-time trip line.

import { useCallback, useEffect, useRef, useState } from "react";
import { clock } from "./lib/predict";

export const REFRESH_MS = 60_000;

/** Keep feed ages and countdowns moving between network refreshes. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Runs `load` now, every minute while the app is visible, and on demand. */
export function useAutoRefresh<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  // `deps` comes from the caller: whatever the load function reads (e.g. chosen stops).
  const run = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await load();
      if (id !== request.current) return;
      setData(result);
      setAt(Date.now());
      setError(null);
    } catch (e) {
      if (id !== request.current) return;
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, deps);

  useEffect(() => {
    setData(null);
    setAt(null);
    setError(null);
    void run();
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, REFRESH_MS);
    return () => {
      ++request.current;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run]);

  return { data, at, loading, error, refresh: run, setData };
}

export function StatusRow(props: { at: number | null; loading: boolean; stale: boolean; onRefresh: () => void }) {
  const time = props.at ? new Date(props.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="statusrow">
      <span className={`status ${props.stale ? "stale" : ""}`}>
        {props.loading ? "Updating…" : time && (props.stale ? `Offline · last update ${time}` : `Updated ${time}`)}
      </span>
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

const changed = (a: number, b: number) => Math.round(a / 60) !== Math.round(b / 60);

/** A time, with the timetable time struck through when the live estimate differs. */
export function Time(props: { s: number; scheduledS?: number; className?: string }) {
  return (
    <span className="time">
      <span className={props.className}>{clock(props.s)}</span>
      {props.scheduledS !== undefined && changed(props.s, props.scheduledS) && <s>{clock(props.scheduledS)}</s>}
    </span>
  );
}

/** "now" / "in 12 min" / "in 2 h 5 min" */
export function countdown(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  return `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

export function secondsSinceMidnight(d = new Date()): number {
  return (d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds();
}

/** "Leave 09:10   →   Arrive 09:55" */
export function Times(props: {
  departS: number;
  arriveS: number;
  scheduledDepartS: number;
  scheduledArriveS: number;
  nowS?: number; // seconds since midnight; shows "in 12 min" next to Leave
  departLabel?: string;
  arriveLabel?: string;
}) {
  return (
    <div className="times">
      <div>
        <small>
          {props.departLabel ?? "Leave"}{props.nowS !== undefined && <span className="countdown"> · {countdown(props.departS - props.nowS)}</span>}
        </small>
        <Time s={props.departS} scheduledS={props.scheduledDepartS} className="big" />
      </div>
      <span className="arrow">→</span>
      <div className="arr">
        <small>{props.arriveLabel ?? "Arrive"}</small>
        <Time s={props.arriveS} scheduledS={props.scheduledArriveS} className="big" />
      </div>
    </div>
  );
}

/** "On time" / "3 min late" / "2 min early" / "Timetable only". */
export function delayText(delayMin: number | null): string {
  if (delayMin === null) return "Timetable only";
  const m = Math.round(delayMin);
  if (m === 0) return "On time";
  return m > 0 ? `${m} min late` : `${-m} min early`;
}

/** Colour for a live delay in minutes (null = no live data). */
export function delayTone(delayMin: number | null): "good" | "ok" | "bad" | "none" {
  if (delayMin === null) return "none";
  return delayMin <= 1 ? "good" : delayMin <= 5 ? "ok" : "bad";
}

export function Chip(props: { tone: "good" | "ok" | "bad" | "none"; children: React.ReactNode }) {
  return <span className={`chip ${props.tone}`}>{props.children}</span>;
}
