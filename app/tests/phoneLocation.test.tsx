import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JourneyControls } from "../src/JourneyControls";
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

it("refreshes automatically and stops polling on unmount", async () => {
  vi.mocked(locate).mockResolvedValue({ latitude: 53.5652, longitude: -7.7662, accuracy: 20, timestamp: Date.now() });
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(locate).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  await vi.advanceTimersByTimeAsync(60000);
  expect(locate).toHaveBeenCalledTimes(2);
});

it("does not replace a denied location with questions about the user's position", async () => {
  vi.mocked(locate).mockRejectedValue(new Error("Permission denied"));
  const change = await mount();
  expect(change).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Phone location unavailable");
  expect(host.querySelector("select")).toBeNull();
});
