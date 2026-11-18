// Where is my bus? Places a GPS fix on the trip's stops: the stop it is at, or the
// stop it is heading for, and how many stops before yours.

import type { BusPack, BusVehicle } from "./buses";

export interface TripStop { name: string; seq: number; lat: number; lon: number }

export interface BusWhere {
  atStop: TripStop | null; // within AT_STOP_M of a stop
  next: TripStop | null; // the next stop it will reach (null at the end of the line)
  /** Stops until the target, counting it: 0 = at it, 1 = next stop. Negative = passed it. */
  stopsTo: number;
  ageS: number; // how old the GPS fix is
  offRoute: boolean; // the fix is far from every part of the route
}

const AT_STOP_M = 60;
const OFF_ROUTE_M = 1500;

const tripCache = new Map<string, TripStop[]>();
/** The stops of a trip, in order, with their positions. */
export function tripStops(pack: BusPack, tripId: string): TripStop[] {
  const hit = tripCache.get(tripId);
  if (hit) return hit;
  const trip = pack.trips.find((t) => t[0] === tripId);
  const stops = trip ? trip[4].map(([i, seq]) => {
    const s = pack.stops[i];
    return { name: s[1], seq, lat: s[2], lon: s[3] };
  }) : [];
  tripCache.set(tripId, stops);
  return stops;
}

/** Local flat projection in metres (fine for a few tens of km). */
function xy(lat0: number, p: { lat: number; lon: number }): [number, number] {
  const k = Math.PI / 180 * 6371000;
  return [(p.lon) * k * Math.cos(lat0 * Math.PI / 180), p.lat * k];
}

/** Where the bus is relative to the stop with sequence `targetSeq`. */
export function whereBus(stops: TripStop[], v: BusVehicle, targetSeq: number, now: number): BusWhere | null {
  if (stops.length < 2) return null;
  const lat0 = v.lat;
  const [px, py] = xy(lat0, v);
  // Closest segment between consecutive stops; ties go to the earlier one.
  let best = { i: 0, d: Infinity, f: 0 };
  for (let i = 0; i < stops.length - 1; i++) {
    const [ax, ay] = xy(lat0, stops[i]);
    const [bx, by] = xy(lat0, stops[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const f = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(px - (ax + f * dx), py - (ay + f * dy));
    if (d < best.d - 1) best = { i, d, f };
  }
  const dist = (s: TripStop) => { const [x, y] = xy(lat0, s); return Math.hypot(px - x, py - y); };
  const a = stops[best.i], b = stops[best.i + 1];
  const atStop = dist(a) <= AT_STOP_M ? a : dist(b) <= AT_STOP_M ? b : null;
  const atIdx = atStop ? stops.indexOf(atStop) : -1;
  const nextIdx = atStop ? atIdx + 1 : best.i + 1;
  const targetIdx = stops.findIndex((s) => s.seq === targetSeq);
  // Stops until the target, counting the target: 0 = at it, 1 = it is the next stop.
  const lastIdx = atStop ? atIdx : best.i;
  const stopsTo = targetIdx < 0 ? 0 : targetIdx - lastIdx;
  return {
    atStop,
    next: stops[nextIdx] ?? null,
    stopsTo,
    ageS: Math.max(0, Math.round((now - v.t) / 1000)),
    offRoute: best.d > OFF_ROUTE_M,
  };
}

/** "At Moate · 3 stops away", "Heading to Ballymahon · your stop is next". */
export function whereText(w: BusWhere, target: "board" | "alight"): string {
  if (w.offRoute) return "Off the usual route";
  const here = w.atStop ? `At ${w.atStop.name}` : w.next ? `Heading to ${w.next.name}` : "At the last stop";
  const n = w.stopsTo;
  if (n < 0) return target === "board" ? `${here} · passed your stop` : `${here} · past your stop`;
  if (n === 0) return target === "board" ? "At your stop now" : "At your stop";
  if (n === 1 && !w.atStop) return `${here} · your stop is next`;
  if (target === "board") return `${here} · ${n === 1 ? "1 stop away" : `${n} stops away`}`;
  return `${here} · ${n === 1 ? "1 stop to go" : `${n} stops to go`}`;
}
