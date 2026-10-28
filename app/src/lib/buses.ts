// Bus departures from the offline Midlands timetable pack, plus live delays.
// The pack is built by `commuteer-buses pack` (src/commuteer/buses/pack.py).

import { load, save } from "./storage";

export const BUS_LIVE_URL = "https://vr7lgty7tcare3y6qvjqhx22di0rcdyj.lambda-url.eu-north-1.on.aws/";

export interface BusPack {
  format: string;
  start: string; // YYYY-MM-DD: day 0 of each service bitmask
  days: number;
  stops: [string, string, number, number][]; // id, name, lat, lon
  routes: [string, string, string][]; // id, short name, operator
  services: string[]; // "0101..." one char per day from `start`
  trips: [string, number, number, string, [number, number, number, number][]][];
  // trip_id, route index, service index, headsign, [stop index, sequence, arrive_min, depart_min]
}

export interface StopGroup {
  key: string; // stable id: first stop id of the group
  name: string;
  stops: number[]; // stop indices (e.g. one per direction)
}

export interface BusDeparture {
  tripId: string;
  route: string;
  headsign: string;
  serviceDate: string; // YYYYMMDD
  fromSeq: number;
  toSeq: number;
  departS: number; // scheduled, seconds since local midnight of `day0` (can exceed a day)
  arriveS: number;
  departDelayS: number | null; // live, null if unknown
  arriveDelayS: number | null;
  canceled: boolean;
}

const KM_PER_DEG = 111.2;
function km(a: [number, number], b: [number, number]): number {
  const dx = (a[1] - b[1]) * KM_PER_DEG * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * KM_PER_DEG, dx);
}

/** Stops with the same name within 1 km are one place (typically one per direction). */
export function groupStops(pack: BusPack): StopGroup[] {
  const groups: (StopGroup & { at: [number, number] })[] = [];
  pack.stops.forEach(([id, name, lat, lon], i) => {
    const g = groups.find((x) => x.name === name && km(x.at, [lat, lon]) < 1);
    if (g) g.stops.push(i);
    else groups.push({ key: id, name, stops: [i], at: [lat, lon] });
  });
  // Same name, different place: add a number so the picker stays unambiguous.
  const seen = new Map<string, number>();
  return groups
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ key, name, stops }) => {
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      return { key, name: n > 1 ? `${name} (${n})` : name, stops };
    });
}

function dayIndex(pack: BusPack, d: Date): number {
  const [y, m, day] = pack.start.split("-").map(Number);
  const start = Date.UTC(y, m - 1, day);
  const that = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((that - start) / 86_400_000);
}

export function packExpired(pack: BusPack, now: Date): boolean {
  return dayIndex(pack, now) >= pack.days;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Scheduled trips calling at `from` and later at `to`, departing within the window. */
export function busDepartures(
  pack: BusPack,
  from: StopGroup,
  to: StopGroup,
  now: Date,
  horizonMin = 180,
): BusDeparture[] {
  const fromSet = new Set(from.stops);
  const toSet = new Set(to.stops);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nowS = (now.getTime() - today.getTime()) / 1000;
  const out: BusDeparture[] = [];
  // Yesterday's trips can run past midnight (GTFS times above 24:00).
  for (const offset of [-1, 0, 1]) {
    const day = new Date(today);
    day.setDate(day.getDate() + offset);
    const idx = dayIndex(pack, day);
    if (idx < 0 || idx >= pack.days) continue;
    for (const [tripId, route, service, headsign, calls] of pack.trips) {
      if (pack.services[service][idx] !== "1") continue;
      const i = calls.findIndex((c) => fromSet.has(c[0]));
      if (i < 0) continue;
      const j = calls.findIndex((c, k) => k > i && toSet.has(c[0]));
      if (j < 0) continue;
      const departS = (calls[i][3] + offset * 1440) * 60;
      if (departS < nowS - 120 || departS > nowS + horizonMin * 60) continue;
      out.push({
        tripId,
        route: pack.routes[route][1],
        headsign,
        serviceDate: ymd(day),
        fromSeq: calls[i][1],
        toSeq: calls[j][1],
        departS,
        arriveS: (calls[j][2] + offset * 1440) * 60,
        departDelayS: null,
        arriveDelayS: null,
        canceled: false,
      });
    }
  }
  return out.sort((a, b) => a.departS - b.departS);
}

interface LiveTrip {
  date: string;
  canceled: boolean;
  stops: [number | null, string, number | null, number | null, boolean][];
}

/** GTFS-Realtime rule: a stop's delay is the latest update at or before it in the trip. */
export function delayAt(live: LiveTrip, seq: number, kind: "arrival" | "departure"): number | null {
  let delay: number | null = null;
  for (const [s, , arr, dep] of live.stops) {
    if (s === null || s > seq) break;
    const value = kind === "arrival" ? (arr ?? dep) : (dep ?? arr);
    if (value !== null) delay = value;
  }
  return delay;
}

export async function withLiveDelays(deps: BusDeparture[], timeoutMs = 8000): Promise<BusDeparture[]> {
  if (deps.length === 0) return deps;
  const ids = [...new Set(deps.map((d) => d.tripId))].slice(0, 50);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BUS_LIVE_URL}?trips=${ids.map(encodeURIComponent).join(",")}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`live buses: HTTP ${res.status}`);
    const body = (await res.json()) as { trips: Record<string, LiveTrip> };
    return deps.map((d) => {
      const live = body.trips[d.tripId];
      if (!live || live.date !== d.serviceDate) return d;
      return {
        ...d,
        canceled: live.canceled,
        departDelayS: delayAt(live, d.fromSeq, "departure"),
        arriveDelayS: delayAt(live, d.toSeq, "arrival"),
      };
    });
  } finally {
    clearTimeout(timer);
  }
}

let packPromise: Promise<BusPack> | null = null;
/** The pack is ~1.5 MB, so it loads on first use rather than at app start. */
export function loadPack(): Promise<BusPack> {
  packPromise ??= import("../data/bus-pack.json").then((m) => m.default as unknown as BusPack);
  return packPromise;
}

export const busPrefs = {
  get: () => load("busCommute", { from: "8330B455691", to: "8290B1520801" }), // Athlone Stn -> Ballymahon
  set: (v: { from: string; to: string }) => save("busCommute", v),
};
