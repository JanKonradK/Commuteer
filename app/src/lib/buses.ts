// Bus departures from the offline Midlands timetable pack, plus live delays.
// The pack is built by `commuteer-buses pack` (src/commuteer/buses/pack.py).

import { load, save } from "./storage";

export const BUS_LIVE_URL = "https://vr7lgty7tcare3y6qvjqhx22di0rcdyj.lambda-url.eu-north-1.on.aws/";
const MAX_FEED_AGE_S = 5 * 60;

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
  skipped?: boolean; // boarding or destination stop is not served
  feedAt?: number; // feed timestamp, milliseconds since the epoch
  departureUpdate?: BusTimeUpdate | null;
  arrivalUpdate?: BusTimeUpdate | null;
}

export interface BusTimeUpdate {
  delayS: number;
  source: "stop" | "carried";
  stopId: string;
  sequence: number;
}

export function busTimeSource(update: BusTimeUpdate | null | undefined): string {
  return update ? update.source === "stop" ? "Stop update" : "Estimated" : "Timetable";
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
  lookbackMin = 2,
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
      if (departS < nowS - lookbackMin * 60 || departS > nowS + horizonMin * 60) continue;
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
  return updateAt(live, seq, kind)?.delayS ?? null;
}

/** Earlier calls propagate their departure delay, including any time recovered at a stop. */
export function updateAt(live: LiveTrip, seq: number, kind: "arrival" | "departure"): BusTimeUpdate | null {
  let update: BusTimeUpdate | null = null;
  for (const [s, stopId, arr, dep, skipped] of live.stops) {
    if (s === null || s > seq || skipped) continue;
    const value = s === seq && kind === "arrival" ? (arr ?? dep) : (dep ?? arr);
    if (value !== null && Number.isFinite(value) && (!update || s >= update.sequence)) {
      update = { delayS: value, source: s === seq ? "stop" : "carried", stopId, sequence: s };
    }
  }
  return update;
}

export async function withLiveDelays(deps: BusDeparture[], timeoutMs = 8000): Promise<BusDeparture[]> {
  if (deps.length === 0) return deps;
  const ids = [...new Set(deps.map((d) => d.tripId))];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const trips: Record<string, LiveTrip> = {};
    const timestamps: Record<string, number> = {};
    for (let i = 0; i < ids.length; i += 50) {
      const res = await fetch(`${BUS_LIVE_URL}?trips=${ids.slice(i, i + 50).map(encodeURIComponent).join(",")}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`live buses: HTTP ${res.status}`);
      const body = (await res.json()) as { feed_timestamp: number; trips: Record<string, LiveTrip> };
      const age = Date.now() / 1000 - body.feed_timestamp;
      if (!Number.isFinite(age) || age > MAX_FEED_AGE_S || age < -60) {
        throw new Error("Live bus times are out of date");
      }
      Object.assign(trips, body.trips);
      for (const id of ids.slice(i, i + 50)) timestamps[id] = body.feed_timestamp * 1000;
    }
    return deps.map((d) => {
      const live = trips[d.tripId];
      if (!live || live.date !== d.serviceDate) return d;
      const departureUpdate = updateAt(live, d.fromSeq, "departure");
      const arrivalUpdate = updateAt(live, d.toSeq, "arrival");
      return {
        ...d,
        canceled: live.canceled,
        skipped: live.stops.some(([seq, , , , skipped]) => skipped && (seq === d.fromSeq || seq === d.toSeq)),
        departDelayS: departureUpdate?.delayS ?? null,
        arriveDelayS: arrivalUpdate?.delayS ?? null,
        departureUpdate,
        arrivalUpdate,
        feedAt: timestamps[d.tripId],
      };
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Apply the time window after live delays, so late buses remain visible. */
export function upcomingBuses(deps: BusDeparture[], now: Date): BusDeparture[] {
  const nowS = (now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds();
  const departure = (d: BusDeparture) => d.departS + (d.departDelayS ?? 0);
  return deps.filter((d) => departure(d) >= nowS - 120).sort((a, b) => departure(a) - departure(b));
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
