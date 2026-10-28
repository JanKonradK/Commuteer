import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BusDeparture, busTimeSource, updateAt, upcomingBuses, withLiveDelays } from "../src/lib/buses";
import { loadDepartures } from "../src/lib/departures";
import { api, type BoardTrain, parseMovements, parseXml } from "../src/lib/irishRail";
import { DelayModel, type ModelJson } from "../src/lib/model";
import { expectedTimeS } from "../src/lib/predict";
import modelJson from "../src/model/delay-model.json";

const now = new Date(2026, 9, 28, 9);
const bus: BusDeparture = {
  tripId: "T1", route: "466", headsign: "Cavan", serviceDate: "20261028",
  fromSeq: 1, toSeq: 4, departS: 9 * 3600 - 600, arriveS: 10 * 3600,
  departDelayS: null, arriveDelayS: null, canceled: false,
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function feed(trips: object, timestamp = Date.now() / 1000) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({ feed_timestamp: timestamp, trips }))));
}

describe("live buses", () => {
  it("applies stop delays and keeps a late bus after its scheduled departure", async () => {
    feed({ T1: { date: bus.serviceDate, canceled: false, stops: [[1, "A", null, 900, false], [4, "B", 1200, null, false]] } });
    const result = await withLiveDelays([bus]);
    expect(result[0]).toMatchObject({ departDelayS: 900, arriveDelayS: 1200 });
    expect(result[0].departureUpdate).toMatchObject({ source: "stop", stopId: "A", delayS: 900 });
    expect(result[0].arrivalUpdate).toMatchObject({ source: "stop", stopId: "B", delayS: 1200 });
    expect(result[0].feedAt).toBeGreaterThan(0);
    expect(upcomingBuses(result, now)).toHaveLength(1);
    expect(upcomingBuses([bus], now)).toHaveLength(0);
  });

  it("does not apply another service day's update", async () => {
    feed({ T1: { date: "20261027", canceled: true, stops: [[1, "A", 900, 900, false]] } });
    expect(await withLiveDelays([bus])).toEqual([bus]);
  });

  it("preserves cancellations and skipped boarding stops", async () => {
    feed({ T1: { date: bus.serviceDate, canceled: true, stops: [[1, "A", null, null, true]] } });
    expect((await withLiveDelays([bus]))[0]).toMatchObject({ canceled: true, skipped: true });
  });

  it("rejects stale feeds instead of presenting old estimates as live", async () => {
    feed({}, Date.now() / 1000 - 301);
    await expect(withLiveDelays([bus])).rejects.toThrow("out of date");
  });

  it("rejects feeds without a timestamp and HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"trips":{}}')));
    await expect(withLiveDelays([bus])).rejects.toThrow("out of date");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(withLiveDelays([bus])).rejects.toThrow("503");
  });

  it("requests every trip in batches of at most 50", async () => {
    feed({ T50: { date: bus.serviceDate, canceled: false, stops: [[1, "A", null, 120, false]] } });
    const result = await withLiveDelays(Array.from({ length: 51 }, (_, i) => ({ ...bus, tripId: `T${i}` })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result[50].departDelayS).toBe(120);
  });

  it("uses departure delay after a stop recovers time", () => {
    const live = { date: bus.serviceDate, canceled: false,
      stops: [[8, "LONGFORD", 971, 701, false], [9, "KEENAGH", 671, 671, false]] as [number, string, number | null, number | null, boolean][] };
    expect(updateAt(live, 8, "arrival")).toMatchObject({ delayS: 971, source: "stop" });
    expect(updateAt(live, 8, "departure")).toMatchObject({ delayS: 701, source: "stop" });
    expect(updateAt(live, 10, "arrival")).toEqual({ delayS: 671, source: "carried", stopId: "KEENAGH", sequence: 9 });
    expect(updateAt({ ...live, stops: live.stops.slice(0, 1) }, 10, "arrival")?.delayS).toBe(701);
  });

  it("finds updates by stop sequence, ignoring missing sequences and skipped calls", () => {
    const live = { date: bus.serviceDate, canceled: false,
      stops: [[3, "C", 180, 120, false], [null, "UNKNOWN", 999, 999, false], [2, "B", 500, 500, false], [4, "D", 900, 900, true]] as [number | null, string, number | null, number | null, boolean][] };
    expect(updateAt(live, 5, "arrival")).toMatchObject({ delayS: 120, stopId: "C", source: "carried" });
    expect(updateAt(live, 1, "arrival")).toBeNull();
  });

  it("labels zero-delay upstream predictions as estimates, not confirmed on-time arrivals", async () => {
    feed({ T1: { date: bus.serviceDate, canceled: false, stops: [[1, "A", null, 0, false]] } });
    const [d] = await withLiveDelays([bus]);
    expect(busTimeSource(d.departureUpdate)).toBe("Stop update");
    expect(busTimeSource(d.arrivalUpdate)).toBe("Estimated");
    expect(busTimeSource(null)).toBe("Timetable");
  });
});

describe("live train times", () => {
  const train: BoardTrain = {
    code: "A701", trainDate: "27 Oct 2026", origin: "Athlone", destination: "Dublin Heuston",
    schDepart: "05:15", expDepart: "05:18", lateMin: 3, dueInMin: 10,
    lastLocation: "", locationType: "O", status: "En Route",
  };
  const from = { code: "ATLNE", name: "Athlone", codes: ["ATLNE"] };
  const to = { code: "HSTON", name: "Dublin Heuston", codes: ["HSTON"] };
  const model = new DelayModel(modelJson as ModelJson);

  beforeEach(() => {
    const movements = parseMovements(parseXml(readFileSync(join(__dirname, "fixtures/movements_A701.xml"), "utf8")))!;
    vi.spyOn(api, "movements").mockResolvedValue({
      ...movements, stops: movements.stops.map((s) => ({ ...s, depDelayMin: null, arrDelayMin: null })),
    });
  });

  it("keeps the operator arrival separate from the model", async () => {
    vi.spyOn(api, "board").mockImplementation(async (code) => code === "ATLNE" ? [train] : [{ ...train, expArrival: "07:03" }]);
    const result = await loadDepartures(model, from, to);
    expect(result.predictions[0].liveArrivalS).toBe(7 * 3600 + 180);
    expect(result.predictions[0].arrivalDelay).toHaveLength(3);
  });

  it("falls back to the model if the destination board fails", async () => {
    vi.spyOn(api, "board").mockImplementation(async (code) => {
      if (code === "ATLNE") return [train];
      throw new Error("Offline");
    });
    const result = await loadDepartures(model, from, to);
    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0].liveArrivalS).toBeNull();
    expect(result.arrivalBoardUnavailable).toBe(true);
  });

  it("does not call a timetable-only arrival live", async () => {
    vi.spyOn(api, "board").mockImplementation(async (code) => code === "ATLNE" ? [train] : [{ ...train, status: "No Information", expArrival: "06:53" }]);
    expect((await loadDepartures(model, from, to)).predictions[0].liveArrivalS).toBeNull();
  });

  it("matches the service date, not just the train code", async () => {
    vi.spyOn(api, "board").mockImplementation(async (code) => code === "ATLNE" ? [train] : [{ ...train, trainDate: "26 Oct 2026", expArrival: "07:03" }]);
    expect((await loadDepartures(model, from, to)).predictions[0].liveArrivalS).toBeNull();
  });

  it("aligns expected times at midnight and rejects absent clock values", () => {
    expect(expectedTimeS("00:05", 23 * 3600 + 58 * 60)).toBe(86400 + 300);
    expect(expectedTimeS("23:58", 86400 + 300)).toBe(23 * 3600 + 58 * 60);
    expect(expectedTimeS("00:00", 3600)).toBeNull();
    expect(expectedTimeS("25:10", 3600)).toBeNull();
  });
});
