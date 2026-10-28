// Irish Rail realtime API client and XML parsers.
// Parsing rules match the Python training pipeline (src/commuteer/delays/dataset.py),
// so the features the phone computes are the ones the model was trained on.

import { Capacitor } from "@capacitor/core";

export const DAY_S = 86_400;
const HALF_DAY_S = DAY_S / 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface Station {
  code: string; // the code used to query the station board
  name: string;
  codes: string[]; // all codes for this station (some have separate fast/slow-line codes)
}

export interface BoardTrain {
  code: string;
  trainDate: string; // e.g. "28 Oct 2026"
  origin: string;
  destination: string;
  schDepart: string; // "HH:MM" at the queried station
  expDepart: string;
  expArrival?: string;
  status?: string;
  lateMin: number;
  dueInMin: number;
  lastLocation: string;
  locationType: string; // O origin, S stop, D destination, T timing point
}

export interface MovementStop {
  station: string;
  name: string;
  order: number;
  type: string;
  schArrS: number | null; // seconds since the service day's midnight (can exceed 24 h)
  schDepS: number | null;
  arrDelayMin: number | null;
  depDelayMin: number | null;
}

export interface Movements {
  code: string;
  trainDate: string;
  route: string; // "Origin > Destination", as in training
  stops: MovementStop[]; // sorted by order
}

export function hasLiveInfo(train: BoardTrain): boolean {
  return !!train.status && train.status.toLowerCase() !== "no information";
}

function baseUrl(): string {
  // Native: call the API directly. Browser (dev): go through Vite's proxy.
  return Capacitor.isNativePlatform() ? "https://api.irishrail.ie" : "/irishrail";
}

export async function fetchXml(
  path: string,
  { timeoutMs = 10_000, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
): Promise<Document> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl()}/realtime/realtime.asmx/${path}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Irish Rail returned HTTP ${res.status}`);
      return parseXml(await res.text());
    } catch (e) {
      lastError = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  // Network failures surface as TypeError ("Failed to fetch") or AbortError: say it plainly.
  const offline = !(lastError instanceof Error) || lastError.name === "TypeError" || lastError.name === "AbortError";
  throw offline ? new Error("Can't reach Irish Rail") : lastError;
}

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Irish Rail sent an unreadable response");
  }
  return doc;
}

function field(el: Element, tag: string): string {
  return el.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";
}

function items(doc: Document, tag: string): Element[] {
  return Array.from(doc.getElementsByTagName(tag));
}

export function parseStations(doc: Document): Station[] {
  const byName = new Map<string, Station>();
  for (const el of items(doc, "objStation")) {
    const code = field(el, "StationCode");
    const name = field(el, "StationDesc");
    // All-capitals entries are junctions and depots, not passenger stations.
    if (!code || !name || name === name.toUpperCase()) continue;
    const existing = byName.get(name);
    if (existing) existing.codes.push(code);
    else byName.set(name, { code, name, codes: [code] });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseStationBoard(doc: Document): BoardTrain[] {
  return items(doc, "objStationData").map((el) => ({
    code: field(el, "Traincode"),
    trainDate: field(el, "Traindate"),
    origin: field(el, "Origin"),
    destination: field(el, "Destination"),
    schDepart: field(el, "Schdepart"),
    expDepart: field(el, "Expdepart"),
    expArrival: field(el, "Exparrival"),
    status: field(el, "Status"),
    lateMin: Number(field(el, "Late")) || 0,
    dueInMin: Number(field(el, "Duein")) || 0,
    lastLocation: field(el, "Lastlocation"),
    locationType: field(el, "Locationtype"),
  }));
}

/** "HH:MM:SS" -> seconds; empty or "00:00:00" (the feed's "not applicable") -> null. */
export function seconds(text: string): number | null {
  if (!text || text === "00:00:00") return null;
  const [h, m, s] = text.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

/** Scheduled times along a journey only go forward; add a day after midnight. */
export function unwrapMidnight(times: (number | null)[]): (number | null)[] {
  let offset = 0;
  let last = -Infinity;
  return times.map((t) => {
    if (t === null) return null;
    if (t + offset < last - HALF_DAY_S) offset += DAY_S;
    last = t + offset;
    return last;
  });
}

/** Put an actual time on the same day as its scheduled time (closest within 12 h). */
export function align(actual: number | null, scheduled: number | null): number | null {
  if (actual === null || scheduled === null) return null;
  return actual - Math.round((actual - scheduled) / DAY_S) * DAY_S;
}

export function parseMovements(doc: Document): Movements | null {
  const rows = items(doc, "objTrainMovements")
    .map((el) => ({ el, order: Number(field(el, "LocationOrder")) }))
    .sort((a, b) => a.order - b.order);
  if (rows.length === 0) return null;

  const schedFlat = unwrapMidnight(
    rows.flatMap(({ el }) => [seconds(field(el, "ScheduledArrival")), seconds(field(el, "ScheduledDeparture"))]),
  );
  const stops = rows.map(({ el, order }, i): MovementStop => {
    const schArr = schedFlat[2 * i];
    const schDep = schedFlat[2 * i + 1];
    const actArr = align(seconds(field(el, "Arrival")), schArr);
    const actDep = align(seconds(field(el, "Departure")), schDep);
    return {
      station: field(el, "LocationCode"),
      name: field(el, "LocationFullName"),
      order,
      type: field(el, "LocationType"),
      schArrS: schArr,
      schDepS: schDep,
      arrDelayMin: actArr !== null && schArr !== null ? (actArr - schArr) / 60 : null,
      depDelayMin: actDep !== null && schDep !== null ? (actDep - schDep) / 60 : null,
    };
  });
  const first = rows[0].el;
  return {
    code: field(first, "TrainCode"),
    trainDate: field(first, "TrainDate"),
    route: `${field(first, "TrainOrigin")} > ${field(first, "TrainDestination")}`,
    stops,
  };
}

/** "28 Oct 2026" -> weekday with Monday = 0 (as pandas uses in training). */
export function weekdayOf(trainDate: string): number {
  const [day, month, year] = trainDate.split(" ");
  const utc = new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day)));
  return (utc.getUTCDay() + 6) % 7;
}

export const api = {
  stations: async () => parseStations(await fetchXml("getAllStationsXML")),
  board: async (stationCode: string, minutes = 90) =>
    parseStationBoard(
      await fetchXml(`getStationDataByCodeXML_WithNumMins?StationCode=${encodeURIComponent(stationCode)}&NumMins=${minutes}`),
    ),
  movements: async (trainCode: string, trainDate: string) =>
    parseMovements(
      await fetchXml(
        `getTrainMovementsXML?TrainId=${encodeURIComponent(trainCode)}&TrainDate=${encodeURIComponent(trainDate)}`,
      ),
    ),
};
