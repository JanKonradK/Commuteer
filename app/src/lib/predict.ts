// Turns a live train into model features and a predicted arrival at your stop.
// Features mirror build_examples() in the Python pipeline.

import { type BoardTrain, DAY_S, type Movements, weekdayOf } from "./irishRail";
import { chanceWithin, type DelayModel, type Quantiles } from "./model";

const PASSENGER = new Set(["O", "S", "D"]);
export const ON_TIME_LIMIT_MIN = 5;

export interface Prediction {
  train: BoardTrain;
  toName: string;
  scheduledArrivalS: number; // at your destination, seconds since service-day midnight
  arrivalDelay: Quantiles; // minutes: 10th, 50th, 90th percentile
  chanceOnTime: number; // P(arrive no more than ON_TIME_LIMIT_MIN late)
  observedAt: string; // where the current delay was last measured
  currentDelayMin: number;
  liveArrivalS?: number | null; // Irish Rail's destination board, separate from the model
}

/** Put a board clock time on the same day as the scheduled call. */
export function expectedTimeS(time: string | undefined, scheduledS: number): number | null {
  if (!time || !/^\d{2}:\d{2}$/.test(time) || time === "00:00") return null;
  const [h, m] = time.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  const s = (h * 60 + m) * 60;
  return s + Math.round((scheduledS - s) / DAY_S) * DAY_S;
}

export type Outcome = { ok: true; prediction: Prediction } | { ok: false; reason: string };

export function predictJourney(
  model: DelayModel,
  train: BoardTrain,
  movements: Movements,
  fromCodes: string[],
  toCodes: string[],
): Outcome {
  const stops = movements.stops.filter((s) => PASSENGER.has(s.type));
  const fromIdx = stops.findIndex((s) => fromCodes.includes(s.station));
  const toIdx = stops.findIndex((s, i) => i > fromIdx && toCodes.includes(s.station));
  if (fromIdx < 0 || toIdx < 0) return { ok: false, reason: "does not stop at your destination" };
  const target = stops[toIdx];
  if (target.schArrS === null) return { ok: false, reason: "no scheduled arrival time" };

  if (stops[fromIdx].depDelayMin !== null) return { ok: false, reason: "already left your station" };
  // The last stop the train has actually departed is where its current delay is known.
  let k = -1;
  for (let i = 0; i < fromIdx; i++) if (stops[i].depDelayMin !== null) k = i;
  let currentDelay: number;
  let delayTrend = 0;
  if (k === -1) {
    // Not started yet: use the board's expected lateness at the origin.
    k = 0;
    currentDelay = Math.max(0, train.lateMin);
  } else {
    currentDelay = stops[k].depDelayMin as number;
    const prev = stops.slice(0, k).reverse().find((s) => s.depDelayMin !== null);
    if (prev) delayTrend = currentDelay - (prev.depDelayMin as number);
  }
  const depS = stops[k].schDepS;
  if (depS === null) return { ok: false, reason: "no scheduled departure time" };

  const hour = (depS % DAY_S) / 3600;
  const numeric = {
    current_delay_min: currentDelay,
    delay_trend_min: delayTrend,
    remaining_sched_min: (target.schArrS - depS) / 60,
    stops_between: toIdx - k - 1,
    hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    hour_cos: Math.cos((2 * Math.PI * hour) / 24),
  };
  const categorical = {
    from_station: stops[k].station,
    to_station: target.station,
    route: movements.route,
    service_type: movements.code.charAt(0),
    weekday: String(weekdayOf(movements.trainDate)),
  };
  const arrivalDelay = model.predictArrivalDelay(currentDelay, categorical, numeric);
  return {
    ok: true,
    prediction: {
      train,
      toName: target.name,
      scheduledArrivalS: target.schArrS,
      arrivalDelay,
      chanceOnTime: chanceWithin(arrivalDelay, ON_TIME_LIMIT_MIN),
      observedAt: stops[k].name,
      currentDelayMin: currentDelay,
    },
  };
}

export function clock(secondsOfDay: number): string {
  const s = ((Math.round(secondsOfDay / 60) * 60) % DAY_S + DAY_S) % DAY_S;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
