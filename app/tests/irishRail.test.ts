import { readFileSync } from "node:fs";
import { join } from "node:path";
import modelJson from "../src/model/delay-model.json";
import {
  align,
  type BoardTrain,
  parseMovements,
  parseStationBoard,
  parseStations,
  parseXml,
  unwrapMidnight,
  weekdayOf,
} from "../src/lib/irishRail";
import { DelayModel, type ModelJson } from "../src/lib/model";
import { clock, predictJourney } from "../src/lib/predict";

const fixture = (name: string) => parseXml(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const model = new DelayModel(modelJson as ModelJson);

describe("Irish Rail parsing", () => {
  it("reads the station list", () => {
    const stations = parseStations(fixture("all_stations.xml"));
    expect(stations.length).toBeGreaterThan(150);
    expect(stations).toContainEqual({ code: "ATLNE", name: "Athlone", codes: ["ATLNE"] });
    const hazelhatch = stations.filter((s) => s.name === "Hazelhatch");
    expect(hazelhatch).toHaveLength(1);
    expect(hazelhatch[0].codes).toEqual(["HZLCH", "HAZEF", "HAZES"]);
    expect(stations.some((s) => s.name === "CITY JUNCTION")).toBe(false);
  });

  it("reads a station board", () => {
    const board = parseStationBoard(fixture("station_ATLNE.xml"));
    expect(board.length).toBeGreaterThan(0);
    expect(board[0].code).toMatch(/^[A-Z]\d+$/);
    expect(board[0].schDepart).toMatch(/^\d\d:\d\d$/);
  });

  it("reads a train's movements like the Python pipeline", () => {
    const m = parseMovements(fixture("movements_A701.xml"));
    expect(m?.route).toBe("Athlone > Dublin Heuston");
    const passenger = m!.stops.filter((s) => ["O", "S", "D"].includes(s.type));
    expect(passenger[0].depDelayMin).toBeCloseTo(0.8);
    expect(passenger.at(-1)?.arrDelayMin).toBeCloseTo(-1.0);
    expect(passenger[0].schArrS).toBeNull(); // origin has no scheduled arrival
  });

  it("handles midnight", () => {
    expect(unwrapMidnight([86_000, null, 100])).toEqual([86_000, null, 86_500]);
    expect(align(60, 86_300)).toBe(86_460);
    expect(clock(86_400 + 125)).toBe("00:02");
  });

  it("uses Monday = 0 weekdays", () => {
    expect(weekdayOf("26 Oct 2026")).toBe(0); // a Monday
    expect(weekdayOf("1 Nov 2026")).toBe(6); // a Sunday
  });
});

describe("journey prediction", () => {
  const movements = parseMovements(fixture("movements_A701.xml"))!;
  // Pretend the train hasn't started yet, as it would look before 05:15.
  const notStarted = {
    ...movements,
    stops: movements.stops.map((s) => ({ ...s, depDelayMin: null, arrDelayMin: null })),
  };
  const train: BoardTrain = {
    code: "A701",
    trainDate: "27 Oct 2026",
    origin: "Athlone",
    destination: "Dublin Heuston",
    schDepart: "05:15",
    expDepart: "05:18",
    lateMin: 3,
    dueInMin: 10,
    lastLocation: "",
    locationType: "O",
  };

  it("predicts arrival at a later stop", () => {
    const out = predictJourney(model, train, notStarted, ["ATLNE"], ["HSTON"]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [lo, mid, hi] = out.prediction.arrivalDelay;
    expect(lo).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(hi);
    expect(out.prediction.currentDelayMin).toBe(3);
    expect(clock(out.prediction.scheduledArrivalS)).toBe("06:53");
  });

  it("skips trains that don't reach your destination or have already left", () => {
    expect(predictJourney(model, train, notStarted, ["HSTON"], ["ATLNE"]).ok).toBe(false);
    expect(predictJourney(model, train, movements, ["ATLNE"], ["HSTON"]).ok).toBe(false);
  });
});
