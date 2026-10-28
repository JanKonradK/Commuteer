// Two-leg journeys: e.g. bus 466 Athlone -> Ballymahon, walk, shuttle -> West Yard.
// For each first-leg departure, find the first second-leg departure you can still
// make after walking, using live bus delays where known.

import { type BusDeparture, type BusPack, busDepartures, groupStops, withLiveDelays } from "./buses";
import { load, save } from "./storage";
import { type Shuttle, shuttleTrips } from "./shuttles";

export type Leg =
  | { kind: "bus"; from: string; to: string } // stop group keys
  | { kind: "shuttle"; id: string; from: string; to: string }; // shuttle id + stop names

export interface Commute {
  legs: [Leg, Leg];
  walkMin: number;
}

export interface LegTrip {
  kind: "bus" | "shuttle";
  label: string; // route number or shuttle name
  departS: number; // best estimate (live if known)
  arriveS: number;
  scheduledDepartS: number;
  scheduledArriveS: number;
  live: boolean;
  canceled: boolean;
  busInfo?: BusDeparture;
}

export interface Connection {
  first: LegTrip;
  second: LegTrip | null; // null: nothing catchable today
  spareMin: number | null; // minutes to spare at the change, after walking
  changedFrom?: LegTrip; // the timetable connection that live updates replaced
}

export interface CommutePlan {
  connections: Connection[];
  warnings: string[];
  walkMin: number;
  feedAt: number | null;
  fetchedAt: number;
}

function fromBus(d: BusDeparture): LegTrip {
  const live = d.departDelayS !== null || d.arriveDelayS !== null;
  return {
    kind: "bus",
    label: d.route,
    departS: d.departS + (d.departDelayS ?? 0),
    arriveS: d.arriveS + (d.arriveDelayS ?? d.departDelayS ?? 0),
    scheduledDepartS: d.departS,
    scheduledArriveS: d.arriveS,
    live,
    canceled: d.canceled,
    busInfo: d,
  };
}

function legTrips(
  leg: Leg,
  pack: BusPack,
  shuttles: Shuttle[],
  now: Date,
  afterS: number,
  horizonMin: number,
): LegTrip[] {
  if (leg.kind === "shuttle") {
    const s = shuttles.find((x) => x.id === leg.id);
    if (!s) return [];
    return shuttleTrips(s, leg.from, leg.to, now, afterS).map((t) => ({
      kind: "shuttle",
      label: s.name,
      departS: t.departS,
      arriveS: t.arriveS,
      scheduledDepartS: t.departS,
      scheduledArriveS: t.arriveS,
      live: false,
      canceled: false,
    }));
  }
  const groups = groupStops(pack);
  const from = groups.find((g) => g.key === leg.from);
  const to = groups.find((g) => g.key === leg.to);
  if (!from || !to) return [];
  return busDepartures(pack, from, to, now, horizonMin, 120).map(fromBus);
}

function tripKey(t: LegTrip): string {
  return t.busInfo ? `${t.busInfo.tripId}@${t.busInfo.serviceDate}` : `${t.label}@${t.scheduledDepartS}`;
}

/** Build both legs from one feed request, then calculate catchable connections. */
export async function planCommute(
  commute: Commute,
  pack: BusPack,
  shuttles: Shuttle[],
  now: Date,
  count = 4,
): Promise<CommutePlan> {
  const nowS = (now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 1000;
  const walkMin = Number.isFinite(commute.walkMin) ? Math.min(60, Math.max(0, commute.walkMin)) : 5;
  const warnings: string[] = [];
  const legs = [
    legTrips(commute.legs[0], pack, shuttles, now, nowS, 720),
    legTrips(commute.legs[1], pack, shuttles, now, nowS, 900),
  ];
  const buses = legs.flat().flatMap((t) => t.busInfo ? [t.busInfo] : []);
  let updated = buses;
  try {
    updated = await withLiveDelays(buses);
  } catch {
    warnings.push("Live bus times unavailable. Routes use the timetable. Refresh before you leave.");
  }
  let i = 0;
  const [firsts, seconds] = legs.map((trips) => trips.map((t) => t.busInfo ? fromBus(updated[i++]) : t)
    .filter((t) => !t.canceled && !t.busInfo?.skipped && t.departS >= nowS)
    .sort((a, b) => a.departS - b.departS));
  const all = firsts.map((first) => {
    const ready = first.arriveS + walkMin * 60;
    // A later express bus can arrive before an earlier slow service.
    const second = seconds.filter((t) => t.departS >= ready)
      .sort((a, b) => a.arriveS - b.arriveS || b.departS - a.departS)[0] ?? null;
    const scheduledReady = first.scheduledArriveS + walkMin * 60;
    const scheduledSecond = seconds.filter((t) => t.scheduledDepartS >= scheduledReady)
      .sort((a, b) => a.scheduledArriveS - b.scheduledArriveS || b.scheduledDepartS - a.scheduledDepartS)[0];
    return {
      first, second, spareMin: second ? (second.departS - ready) / 60 : null,
      changedFrom: scheduledSecond && (!second || tripKey(scheduledSecond) !== tripKey(second)) ? scheduledSecond : undefined,
    };
  });
  // Several first legs often feed the same second leg (e.g. three shuttles, one bus home).
  // Only the latest of them is worth showing: same arrival, least waiting around.
  const best = new Map<string, Connection>();
  for (const c of all) {
    const key = c.second ? tripKey(c.second) : `none@${tripKey(c.first)}`;
    const seen = best.get(key);
    if (!seen || c.first.departS > seen.first.departS) best.set(key, c);
  }
  const options = [...best.values()];
  const complete = options.filter((c) => c.second);
  const results = complete.length ? complete : options;
  const feedTimes = updated.flatMap((d) => d.feedAt ? [d.feedAt] : []);
  return {
    connections: results.sort((a, b) =>
      (a.second?.arriveS ?? Infinity) - (b.second?.arriveS ?? Infinity) || a.first.departS - b.first.departS,
    ).slice(0, count),
    warnings, walkMin, feedAt: feedTimes.length ? Math.min(...feedTimes) : null, fetchedAt: Date.now(),
  };
}

export async function connections(commute: Commute, pack: BusPack, shuttles: Shuttle[], now: Date, count = 4): Promise<Connection[]> {
  return (await planCommute(commute, pack, shuttles, now, count)).connections;
}

export function reverse(c: Commute): Commute {
  const flip = (l: Leg): Leg => ({ ...l, from: l.to, to: l.from });
  return { walkMin: c.walkMin, legs: [flip(c.legs[1]), flip(c.legs[0])] };
}

const DEFAULT: Commute = {
  walkMin: 5,
  legs: [
    { kind: "bus", from: "8330B455691", to: "8290B1520801" }, // Athlone Stn -> Ballymahon (466)
    { kind: "shuttle", id: "centerparcs", from: "Inny Kayak Club", to: "West Yard" },
  ],
};

export const commuteStore = {
  get: () => load<Commute>("commute2", DEFAULT),
  set: (c: Commute) => save("commute2", c),
};
