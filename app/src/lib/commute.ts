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
}

export interface Connection {
  first: LegTrip;
  second: LegTrip | null; // null: nothing catchable today
  spareMin: number | null; // minutes to spare at the change, after walking
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
  };
}

async function legTrips(
  leg: Leg,
  pack: BusPack,
  shuttles: Shuttle[],
  now: Date,
  afterS: number,
  horizonMin: number,
): Promise<LegTrip[]> {
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
  let deps = busDepartures(pack, from, to, now, horizonMin).filter((d) => d.departS >= afterS - 120);
  try {
    deps = await withLiveDelays(deps);
  } catch {
    // Offline or API down: fall back to the timetable (cards show "no live data").
  }
  return deps.map(fromBus).filter((t) => !t.canceled);
}

export async function connections(
  commute: Commute,
  pack: BusPack,
  shuttles: Shuttle[],
  now: Date,
  count = 4,
): Promise<Connection[]> {
  const nowS = (now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 1000;
  const firsts = await legTrips(commute.legs[0], pack, shuttles, now, nowS - 60, 720);
  const seconds = await legTrips(commute.legs[1], pack, shuttles, now, nowS, 900);
  const all = firsts.map((first) => {
    const ready = first.arriveS + commute.walkMin * 60;
    const second = seconds.find((t) => t.departS >= ready) ?? null;
    return { first, second, spareMin: second ? (second.departS - ready) / 60 : null };
  });
  // Several first legs often feed the same second leg (e.g. three shuttles, one bus home).
  // Only the latest of them is worth showing: same arrival, least waiting around.
  const best = new Map<string, Connection>();
  for (const c of all) {
    const key = c.second ? `${c.second.label}@${c.second.scheduledDepartS}` : `none@${c.first.departS}`;
    const seen = best.get(key);
    if (!seen || c.first.departS > seen.first.departS) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => a.first.departS - b.first.departS).slice(0, count);
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
