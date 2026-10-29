import { renderToStaticMarkup } from "react-dom/server";
import { Geolocation } from "@capacitor/geolocation";
import { Capacitor } from "@capacitor/core";
import { type BusPack } from "../src/lib/buses";
import { type Commute, type LegTrip, planCommute } from "../src/lib/commute";
import { currentJourney, distanceM, followPhoneLocation, isChosen, journeyAnchors, localDay, locate, nearbyPlaces, routeKey, saveJourney } from "../src/lib/journey";
import { parseRows, type Shuttle } from "../src/lib/shuttles";
import { ConnectionCard } from "../src/views/CommuteView";

vi.mock("@capacitor/geolocation", () => ({ Geolocation: {
  checkPermissions: vi.fn(), requestPermissions: vi.fn(), getCurrentPosition: vi.fn(),
} }));

const now = new Date(2026, 9, 28, 21, 32);
const pack: BusPack = {
  format: "commuteer-bus-pack/1", start: "2026-10-28", days: 2, services: ["11"],
  routes: [["466", "466", "Bus Éireann"]],
  stops: [["B", "Town", 53.5652, -7.7662], ["A", "Station", 53.4268, -7.9352]],
  trips: [
    ["late", 0, 0, "Station", [[0, 10, 1301, 1301], [1, 13, 1323, 1323]]],
    ["morning", 0, 0, "Station", [[0, 10, 492, 492], [1, 13, 521, 521]]],
  ],
};
const shuttle: Shuttle = {
  id: "work", name: "Staff shuttle", days: [0, 1, 2, 3, 4, 5, 6], waitMin: 5, travelMin: 10,
  rows: parseRows("21:15 Yard\n21:30 Pickup *\n22:30 Yard\n22:45 Pickup *"),
};
const commute: Commute = { legs: [{ kind: "shuttle", id: "work", from: "Yard", to: "Pickup" }, { kind: "bus", from: "B", to: "A" }], walkMin: 5 };
const first: LegTrip = { kind: "shuttle", label: shuttle.name, departS: 1275 * 60, arriveS: 1300 * 60,
  scheduledDepartS: 1275 * 60, scheduledArriveS: 1285 * 60, live: false, canceled: false, userEstimate: true };
function feed(delay = 480) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    feed_timestamp: Date.now() / 1000, trips: { late: { date: "20261028", canceled: false, stops: [[10, "B", delay, delay, false]] } },
  }))));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("keeps the selected departed shuttle and catches the 21:49 delayed bus", async () => {
  feed();
  const plan = await planCommute(commute, pack, [shuttle], now, 4, { stage: "first", first });
  expect(plan.connections[0].first.departS).toBe(1275 * 60);
  expect(plan.connections[0].second?.departS).toBe(1309 * 60);
  expect(plan.connections[0].second?.busInfo?.tripId).toBe("late");
  expect(plan.connections[0].spareMin).toBe(4);
  feed(0);
  const withoutDelay = await planCommute(commute, pack, [shuttle], now, 4, { stage: "first", first });
  expect(withoutDelay.connections[0].overnight).toBe(true);
});

it("still catches a bus arriving at 21:47 when the transfer is ready at 21:47", async () => {
  feed(360);
  const plan = await planCommute(commute, pack, [shuttle], now, 4, { stage: "first", first: { ...first, arriveS: 1302 * 60 } });
  expect(plan.connections[0].second?.departS).toBe(1307 * 60);
  expect(plan.connections[0].spareMin).toBe(0);
});

it("recalculates from the transfer stop without requiring another shuttle", async () => {
  feed();
  const plan = await planCommute(commute, pack, [shuttle], now, 4, { stage: "transfer" });
  expect(plan.connections[0].first.kind).toBe("walk");
  expect(plan.connections[0].second?.busInfo?.tripId).toBe("late");
  expect(plan.connections[0].spareMin).toBe(12);
});

it("at the bus stop needs no walk and includes delays after the timetable departure", async () => {
  feed();
  const later = new Date(2026, 9, 28, 21, 45);
  const plan = await planCommute(commute, pack, [shuttle], later, 4, { stage: "secondStop" });
  expect(plan.walkMin).toBe(0);
  expect(plan.connections[0].second?.departS).toBe(1309 * 60);
  expect(plan.connections[0].spareMin).toBe(4);
});

it("does not offer an already-departed shuttle to someone still at the start", async () => {
  feed();
  const plan = await planCommute(commute, pack, [shuttle], now);
  const c = plan.connections[0];
  expect(c.first.departS).toBe(1350 * 60);
  expect(c.overnight).toBe(true);
  const html = renderToStaticMarkup(<ConnectionCard c={c} walkMin={5} places={["Yard", "Pickup", "Town", "Station"]}
    now={now.getTime()} pack={pack} stale={false} fastest open onToggle={() => {}} />);
  expect(html).toContain('card bad');
  expect(html).toContain("Overnight wait");
  expect(html).toContain("Arrive · tomorrow");
  expect(html).not.toContain("Earliest arrival");
  expect(html).not.toContain("567 min to spare");
});

it("requires a selected first leg and flags a passed arrival instead of silently trusting it", async () => {
  feed();
  expect((await planCommute(commute, pack, [shuttle], now, 4, { stage: "first" })).connections).toEqual([]);
  const plan = await planCommute(commute, pack, [shuttle], now, 4, { stage: "first", first: { ...first, arriveS: 1285 * 60 } });
  expect(plan.connections[0].positionUncertain).toBe(true);
});

it("remembers a choice only for the same route and date", async () => {
  feed();
  const plan = await planCommute(commute, pack, [shuttle], now, 4, { stage: "first", first });
  const state = { route: routeKey(commute), day: localDay(now), stage: "first" as const, first, chosen: plan.connections[0] };
  saveJourney(state);
  expect(currentJourney(commute, now).stage).toBe("first");
  expect(isChosen(state, plan.connections[0])).toBe(true);
  const atStop = await planCommute(commute, pack, [shuttle], now, 4, { stage: "secondStop" });
  expect(isChosen(state, atStop.connections[0])).toBe(true);
  expect(currentJourney(commute, new Date(2026, 9, 29)).chosen).toBeUndefined();
  expect(currentJourney({ ...commute, legs: [commute.legs[1], commute.legs[0]] }, now).chosen).toBeUndefined();
});

it("suggests nearby places only with a fresh, accurate location", () => {
  const anchors = journeyAnchors(commute, pack);
  const fix = { latitude: 53.5652, longitude: -7.7662, accuracy: 30, timestamp: Date.now() };
  expect(nearbyPlaces(fix, anchors)[0].stage).toBe("secondStop");
  expect(distanceM(fix, { ...fix, latitude: 53.6 })).toBeGreaterThan(3000);
  expect(nearbyPlaces({ ...fix, accuracy: 2000 }, anchors)).toEqual([]);
  expect(nearbyPlaces({ ...fix, timestamp: Date.now() - 120000 }, anchors)).toEqual([]);
});

it("handles Android permission denial without requesting a position", async () => {
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  vi.spyOn(Geolocation, "checkPermissions").mockResolvedValue({ location: "denied", coarseLocation: "denied" });
  vi.spyOn(Geolocation, "requestPermissions").mockResolvedValue({ location: "denied", coarseLocation: "denied" });
  const position = vi.spyOn(Geolocation, "getCurrentPosition");
  await expect(locate()).rejects.toThrow("permission is off");
  expect(position).not.toHaveBeenCalled();
});

describe("automatic phone location", () => {
  const state = { route: routeKey(commute), day: localDay(now), stage: "start" as const };
  const fix = { latitude: 53.5652, longitude: -7.7662, accuracy: 20, timestamp: now.getTime() };

  it("automatically starts at the second bus stop without asking", () => {
    const result = followPhoneLocation(state, commute, pack, fix, now);
    expect(result.stage).toBe("secondStop");
    expect(result.walkMinOverride).toBe(0);
    expect(result.locationBased).toBe(true);
  });

  it("estimates the remaining walk from the phone position", () => {
    const result = followPhoneLocation(state, commute, pack, { ...fix, latitude: fix.latitude + 0.003 }, now);
    expect(result.stage).toBe("transfer");
    expect(result.walkMinOverride).toBeGreaterThan(5);
    expect(result.walkMinOverride).toBeLessThan(10);
  });

  it("ignores stale and inaccurate phone fixes", () => {
    expect(followPhoneLocation(state, commute, pack, { ...fix, accuracy: 500 }, now)).toBe(state);
    expect(followPhoneLocation(state, commute, pack, { ...fix, timestamp: now.getTime() - 61000 }, now)).toBe(state);
  });

  it("follows the chosen first leg when the phone moves away from its starting point", () => {
    const originFix = { ...fix, latitude: 53.59 };
    const result = followPhoneLocation({ ...state, first, chosen: { first, second: null, spareMin: null }, originFix }, commute, pack,
      { ...fix, latitude: 53.58 }, now);
    expect(result.stage).toBe("first");
    expect(result.first).toEqual(first);
    expect(followPhoneLocation({ ...state, first, originFix }, commute, pack, originFix, now).stage).toBe("start");
  });

  it("does not switch away from a stop because of small GPS changes", () => {
    const result = followPhoneLocation({ ...state, stage: "secondStop" }, commute, pack, { ...fix, latitude: fix.latitude + 0.001 }, now);
    expect(result.stage).toBe("secondStop");
  });

  it("keeps tracking the chosen second bus after it leaves the stop", async () => {
    feed();
    const atStop = await planCommute(commute, pack, [shuttle], now, 4, { stage: "secondStop" });
    const later = new Date(2026, 9, 28, 21, 51);
    const next = followPhoneLocation({ ...state, stage: "secondStop", chosen: atStop.connections[0] }, commute, pack,
      { ...fix, latitude: fix.latitude - 0.004, timestamp: later.getTime() }, later);
    expect(next.stage).toBe("second");
    const moving = await planCommute(commute, pack, [shuttle], later, 4, next);
    expect(moving.connections[0].second?.busInfo?.tripId).toBe("late");
    expect(moving.walkMin).toBe(0);
  });
});
