import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import type { BusPack } from "./buses";
import { groupStops } from "./buses";
import type { Commute, Connection, JourneyContext, JourneyStage } from "./commute";
import { connectionKey } from "./commute";
import { load, save } from "./storage";

export interface JourneyState extends JourneyContext {
  route: string;
  day: string;
  chosen?: Connection;
}
export const routeKey = (c: Commute) => JSON.stringify(c.legs);
export const localDay = (now: Date) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
export function currentJourney(c: Commute, now: Date): JourneyState {
  const saved = load<JourneyState | null>("active-journey", null);
  return saved?.route === routeKey(c) && saved.day === localDay(now)
    ? saved : { route: routeKey(c), day: localDay(now), stage: "start" };
}
export function saveJourney(state: JourneyState) { save("active-journey", state); }
export function isChosen(state: JourneyState, c: Connection): boolean {
  if (!state.chosen) return false;
  const original = c.first.kind === "walk" ? { ...state.chosen, first: c.first } : state.chosen;
  return connectionKey(original) === connectionKey(c);
}
export interface LocationFix { latitude: number; longitude: number; accuracy: number; timestamp: number }
export interface PlaceAnchor { name: string; stage: JourneyStage; latitude: number; longitude: number }
export function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const x = (a.longitude - b.longitude) * rad * Math.cos((a.latitude + b.latitude) * rad / 2);
  const y = (a.latitude - b.latitude) * rad;
  return Math.hypot(x, y) * 6371000;
}
export function nearbyPlaces(fix: LocationFix, anchors: PlaceAnchor[], now = Date.now()) {
  if (fix.accuracy > 200 || now - fix.timestamp > 60_000 || !Number.isFinite(fix.accuracy)) return [];
  return anchors.map((place) => ({ ...place, distance: distanceM(fix, place) }))
    .filter((p) => p.distance <= 200).sort((a, b) => a.distance - b.distance);
}
export function journeyAnchors(c: Commute, pack: BusPack): PlaceAnchor[] {
  const stages: JourneyStage[] = ["start", "transfer", "secondStop"];
  const legs = [c.legs[0], c.legs[0], c.legs[1]];
  const ends = ["from", "to", "from"] as const;
  const saved = load<Record<string, LocationFix>>("place-locations", {});
  const groups = groupStops(pack);
  return legs.flatMap((leg, i) => {
    const group = leg.kind === "bus" ? groups.find((g) => g.key === leg[ends[i]]) : null;
    const name = group?.name ?? leg[ends[i]];
    const stop = group ? pack.stops[group.stops[0]] : null;
    const coordinates = saved[name] ?? (stop ? { latitude: stop[2], longitude: stop[3] } : null);
    return coordinates ? [{ name, stage: stages[i], ...coordinates }] : [];
  });
}
export function rememberPlace(name: string, fix: LocationFix): void {
  const saved = load<Record<string, LocationFix>>("place-locations", {});
  save("place-locations", { ...saved, [name]: fix });
}
export async function locate(): Promise<LocationFix> {
  if (Capacitor.isNativePlatform()) {
    let permission = await Geolocation.checkPermissions();
    if (permission.location !== "granted" && permission.coarseLocation !== "granted") {
      permission = await Geolocation.requestPermissions({ permissions: ["location"] });
    }
    if (permission.location !== "granted" && permission.coarseLocation !== "granted") {
      throw new Error("Location permission is off. Select your position manually.");
    }
  }
  const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  return { latitude: position.coords.latitude, longitude: position.coords.longitude,
    accuracy: position.coords.accuracy, timestamp: position.timestamp };
}
