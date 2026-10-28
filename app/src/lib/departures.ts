// Loads the next trains for a saved commute and predicts each one's arrival.

import { api, type BoardTrain, type Station } from "./irishRail";
import type { DelayModel } from "./model";
import { type Prediction, predictJourney } from "./predict";

export interface DeparturesResult {
  predictions: Prediction[];
  skipped: number; // trains at your station that don't go to your destination
  fetchedAt: number;
}

const MAX_TRAINS = 10;

/** Run tasks with limited parallelism, to stay gentle on a free public API. */
async function mapLimited<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

export async function loadDepartures(
  model: DelayModel,
  from: Station,
  to: Station,
): Promise<DeparturesResult> {
  const board = await api.board(from.code);
  const candidates = board
    .filter((t: BoardTrain) => t.locationType !== "D" && t.dueInMin >= -1)
    .sort((a, b) => a.dueInMin - b.dueInMin)
    .slice(0, MAX_TRAINS);

  const outcomes = await mapLimited(candidates, 4, async (train) => {
    try {
      const movements = await api.movements(train.code, train.trainDate);
      return movements ? predictJourney(model, train, movements, from.codes, to.codes) : null;
    } catch {
      return null; // one train failing shouldn't hide the others
    }
  });
  const predictions = outcomes.flatMap((o) => (o?.ok ? [o.prediction] : []));
  return { predictions, skipped: candidates.length - predictions.length, fetchedAt: Date.now() };
}
