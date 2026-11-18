// Following a journey on Android starts a live notification (LiveJourneyService.java):
// a countdown kept up to date from the live bus API every 30 s, even with the app closed,
// plus alerts for "leave now", a tight or missed change, a cancelled bus and "your stop is next".

import { Capacitor, registerPlugin } from "@capacitor/core";
import { BUS_LIVE_URL, type BusPack } from "./buses";
import type { Connection, LegTrip } from "./commute";
import { tripStops } from "./whereBus";

const LiveJourney = registerPlugin<{
  start(options: { journey: string }): Promise<{ notifications: boolean }>;
  stop(): Promise<void>;
}>("LiveJourney");

export const liveSupported = () => Capacitor.isNativePlatform();

/** Seconds since today's midnight (may exceed a day) to epoch milliseconds. */
const msAt = (now: number, s: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() + s * 1000; };

function legJson(t: LegTrip, toName: string, pack: BusPack, now: number) {
  const d = t.busInfo;
  const to = d ? tripStops(pack, d.tripId).find((s) => s.seq === d.toSeq) : undefined;
  return {
    label: t.kind === "bus" ? `Bus ${t.label}` : t.label,
    tripId: d?.tripId ?? null,
    serviceDate: d?.serviceDate ?? null,
    fromSeq: d?.fromSeq ?? 0,
    toSeq: d?.toSeq ?? 0,
    toName,
    departMs: msAt(now, t.scheduledDepartS),
    arriveMs: msAt(now, t.scheduledArriveS),
    estDepartMs: msAt(now, t.departS),
    estArriveMs: msAt(now, t.arriveS),
    live: !!t.live,
    delayS: t.live ? t.arriveS - t.scheduledArriveS : null,
    toLat: to?.lat ?? null,
    toLon: to?.lon ?? null,
  };
}

/** What the service needs, as JSON. Walk-only "legs" (you are already at the change) are left out. */
export function journeyJson(c: Connection, places: [string, string, string, string], pack: BusPack, walkMin: number, now: number): string | null {
  const legs = [];
  if (c.first.kind !== "walk" && c.stage !== "second") legs.push(legJson(c.first, places[1], pack, now));
  if (c.second) legs.push(legJson(c.second, places[3], pack, now));
  // Nothing to follow once you have arrived (the service would only flash and stop).
  if (!legs.length || legs[legs.length - 1].estArriveMs < now - 5 * 60_000) return null;
  return JSON.stringify({ api: BUS_LIVE_URL, walkMin: c.first.kind === "walk" ? 0 : walkMin, leadMin: 5, legs });
}

let last = "";
/** Start or update the notification. Resolves to whether notifications are allowed. */
export async function startLive(json: string): Promise<boolean | null> {
  if (!liveSupported() || json === last) return null;
  last = json;
  try {
    return (await LiveJourney.start({ journey: json })).notifications;
  } catch {
    last = "";
    return false;
  }
}

export async function stopLive(): Promise<void> {
  last = "";
  if (liveSupported()) await LiveJourney.stop().catch(() => undefined);
}
