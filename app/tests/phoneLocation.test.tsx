import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JourneyControls, LOCATION_FOLLOWING_MS, LOCATION_IDLE_MS } from "../src/JourneyControls";
import { localDay, locate, routeKey } from "../src/lib/journey";
import type { Commute } from "../src/lib/commute";
import type { BusPack } from "../src/lib/buses";

vi.mock("../src/lib/journey", async (original) => ({ ...await original<typeof import("../src/lib/journey")>(), locate: vi.fn() }));
const commute: Commute = { walkMin: 5, legs: [{ kind: "shuttle", id: "s", from: "Yard", to: "Pickup" }, { kind: "bus", from: "B", to: "A" }] };
const pack: BusPack = { format: "1", start: "2026-10-29", days: 1, services: [], routes: [], trips: [],
  stops: [["B", "Town", 53.5652, -7.7662], ["A", "Station", 53.4, -7.9]] };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = async (change = vi.fn()) => {
  await act(async () => root.render(<JourneyControls commute={commute} pack={pack} shuttles={[]}
    state={{ stage: "start", route: routeKey(commute), day: localDay(new Date()) }}
    places={["Yard", "Pickup", "Town", "Station"]} onChange={change} />));
  return change;
};

it("gets the phone location on opening without a location picker or confirmation", async () => {
  vi.mocked(locate).mockResolvedValue({ latitude: 53.5652, longitude: -7.7662, accuracy: 20, timestamp: Date.now() });
  const change = await mount();
  expect(locate).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ stage: "secondStop" }));
  expect(host.textContent).toContain("Using phone location");
  expect(host.querySelector("select")).toBeNull();
  expect(host.textContent).not.toContain("Where are you");
  expect(host.textContent).not.toContain("Confirm your stop");
});

it("checks rarely while browsing and stops polling on unmount", async () => {
  vi.mocked(locate).mockResolvedValue({ latitude: 53.5652, longitude: -7.7662, accuracy: 20, timestamp: Date.now() });
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(LOCATION_FOLLOWING_MS));
  expect(locate).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(LOCATION_IDLE_MS - LOCATION_FOLLOWING_MS));
  expect(locate).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  await vi.advanceTimersByTimeAsync(LOCATION_IDLE_MS * 2);
  expect(locate).toHaveBeenCalledTimes(2);
});

it("checks often while following a chosen journey", async () => {
  vi.mocked(locate).mockResolvedValue({ latitude: 53.5652, longitude: -7.7662, accuracy: 20, timestamp: Date.now() });
  const chosen = { first: { kind: "bus", label: "466", departS: 0, arriveS: 0, scheduledDepartS: 0, scheduledArriveS: 0, live: false, canceled: false }, second: null, spareMin: null } as const;
  await act(async () => root.render(<JourneyControls commute={commute} pack={pack} shuttles={[]}
    state={{ stage: "start", route: routeKey(commute), day: localDay(new Date()), chosen }}
    places={["Yard", "Pickup", "Town", "Station"]} onChange={vi.fn()} />));
  await act(async () => vi.advanceTimersByTimeAsync(LOCATION_FOLLOWING_MS));
  expect(locate).toHaveBeenCalledTimes(2);
});

it("does not use GPS while the app is in the background", async () => {
  vi.mocked(locate).mockResolvedValue({ latitude: 53.5652, longitude: -7.7662, accuracy: 20, timestamp: Date.now() });
  await mount();
  const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => vi.advanceTimersByTimeAsync(LOCATION_IDLE_MS * 3));
  expect(locate).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(locate).toHaveBeenCalledTimes(2);
  hidden.mockRestore();
});

it("does not replace a denied location with questions about the user's position", async () => {
  vi.mocked(locate).mockRejectedValue(new Error("Permission denied"));
  const change = await mount();
  expect(change).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Phone location unavailable");
  expect(host.querySelector("select")).toBeNull();
});
