// Shared UI pieces: auto-refresh, the route bar with refresh, and a two-time trip line.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { clock } from "./lib/predict";

export const REFRESH_MS = 60_000;

const visible = () => document.visibilityState !== "hidden";

// One shared clock for every countdown on screen. It stops while the app is hidden
// so the phone is not woken up just to redraw a screen nobody can see.
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
const tickAll = () => clockListeners.forEach((f) => f());
const onClockVisibility = () => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = undefined;
  if (visible() && clockListeners.size) {
    tickAll();
    clockTimer = setInterval(tickAll, 30_000);
  }
};

/** Keep feed ages and countdowns moving between network refreshes. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    clockListeners.add(update);
    if (clockListeners.size === 1) {
      document.addEventListener("visibilitychange", onClockVisibility);
      if (visible()) clockTimer = setInterval(tickAll, 30_000);
    }
    return () => {
      clockListeners.delete(update);
      if (!clockListeners.size) {
        if (clockTimer) clearInterval(clockTimer);
        clockTimer = undefined;
        document.removeEventListener("visibilitychange", onClockVisibility);
      }
    };
  }, []);
  return now;
}

/**
 * Runs `load` now, every `intervalMs` while the app is visible, and on demand.
 * Nothing runs while the app is in the background; it catches up when reopened.
 */
export function useAutoRefresh<T>(load: () => Promise<T>, deps: unknown[], intervalMs = REFRESH_MS) {
  const [data, setData] = useState<T | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const every = useRef(intervalMs);
  const restart = useRef<(() => void) | null>(null);

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!visible()) return; // stop until the app is visible again
        void run();
        schedule();
      }, every.current);
    };
    const onVisible = () => {
      if (!visible()) return;
      void run();
      schedule();
    };
    restart.current = schedule;
    void run();
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ++request.current;
      clearTimeout(timer);
      restart.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run]);

  // A new interval takes effect straight away, without reloading.
  useEffect(() => {
    if (every.current === intervalMs) return;
    every.current = intervalMs;
    restart.current?.();
  }, [intervalMs]);

  return { data, at, loading, error, refresh: run, setData };
}

/** "09:05" from a timestamp, in the same 24-hour style as every other time in the app. */
export function wallClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Updated 09:05", or a warning when the last refresh failed. */
export function UpdatedText(props: { at: number | null; loading: boolean; stale: boolean }) {
  const time = props.at ? wallClock(props.at) : "";
  return (
    <span className={`status ${props.stale ? "stale" : ""}`}>
      {props.loading ? "Updating…" : time && (props.stale ? `Offline · last update ${time}` : `Updated ${time}`)}
    </span>
  );
}

export function RefreshButton(props: { loading: boolean; onRefresh: () => void }) {
  return (
    <button
      className={`icon-button refresh ${props.loading ? "spin" : ""}`}
      aria-label="Refresh"
      onClick={props.onRefresh}
      disabled={props.loading}
    >
      <Icon name="refresh" size={20} />
    </button>
  );
}

/** The From / swap / To box at the top of a screen, with an optional button beside it (refresh). */
export function RouteBar(props: { from: ReactNode; to?: ReactNode; onSwap: () => void; side?: ReactNode }) {
  return (
    <div className={`routebar ${props.side ? "" : "solo"}`}>
      <div className={`route-box ${props.to ? "" : "single"}`}>
        {props.from}
        <button className="icon-button swap" aria-label="Swap direction" onClick={props.onSwap}>
          <Icon name="swap" size={18} />
        </button>
        {props.to}
      </div>
      {props.side}
    </div>
  );
}

type Options = readonly (readonly [value: string, name: string])[];

/**
 * A dropdown whose chosen value wraps onto several lines. Android's own dropdown shows
 * only one line, so the name is shown as text and the real dropdown sits invisibly on top:
 * tapping still opens the normal Android picker.
 */
export function WrapSelect(props: { label: string; value: string; options: Options; onChange: (value: string) => void }) {
  const name = props.options.find(([v]) => v === props.value)?.[1] ?? props.value;
  return (
    <span className="wrap-select">
      <span className="wrap-value">{name}</span>
      <Icon name="chevron" size={16} />
      <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([value, option]) => (
          <option key={value} value={value}>
            {option}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A From or To picker inside the route box. The whole field is the tap target. */
export function RouteSelect(props: { label: "From" | "To"; value: string; options: Options; onChange: (value: string) => void }) {
  return (
    <label className="route-field">
      <span className="route-label">{props.label}</span>
      <WrapSelect {...props} />
    </label>
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

/** "Leave in 12 min  09:10 ——→ 09:55  Arrive" */
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
          {props.departLabel ?? "Leave"}
          {props.nowS !== undefined && <span className="countdown"> {countdown(props.departS - props.nowS)}</span>}
        </small>
        <Time s={props.departS} scheduledS={props.scheduledDepartS} className="big" />
      </div>
      <span className="track" aria-hidden />
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
