import { renderToStaticMarkup } from "react-dom/server";
import { BusDetails } from "../src/BusDetails";
import type { BusDeparture, BusPack } from "../src/lib/buses";

const pack: BusPack = {
  format: "commuteer-bus-pack/1", start: "2026-10-28", days: 1, services: ["1"],
  routes: [], trips: [], stops: [["K", "Keenagh", 53.6, -7.8]],
};
const bus: BusDeparture = {
  tripId: "5940_99814", route: "466", headsign: "Athlone", serviceDate: "20261028",
  fromSeq: 10, toSeq: 13, departS: 49320, arriveS: 50760,
  departDelayS: 671, arriveDelayS: 671, canceled: false, feedAt: Date.now(),
  departureUpdate: { delayS: 671, sequence: 9, stopId: "K", source: "carried" },
  arrivalUpdate: { delayS: 671, sequence: 9, stopId: "K", source: "carried" },
};

it("explains the Cavan bus estimate without claiming a stop update or position", () => {
  const html = renderToStaticMarkup(<BusDetails d={bus} pack={pack} />);
  expect(html).toContain("Delay carried forward from Keenagh");
  expect(html).toContain("11 min late");
  expect(html).toContain("No update for this stop");
  expect(html).toContain("13:42");
  expect(html).toContain("TFI feed:");
  expect(html).toContain("Bus Éireann RTPI may still show the timetable");
});

it("shows missing data and stale feed states", () => {
  const html = renderToStaticMarkup(<BusDetails d={{ ...bus,
    departureUpdate: null, arrivalUpdate: null, feedAt: Date.now() - 360_000,
  }} pack={pack} />);
  expect(html).toContain("No stop estimate in the feed");
  expect(html).toContain("out of date");
  expect(html).toContain("No live prediction is available");
});
