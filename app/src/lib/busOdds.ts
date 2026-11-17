// Statistical arrival odds for buses from empirical delay quantiles.
// Bands are built by `commuteer-buses bands` (src/commuteer/buses/bands.py).

export interface BandBucket { maxLeadMin: number | null; live: number[]; timetable: number[]; n: number }
export interface BusBands {
  format: string; generated: string; days: number; rows: number;
  probs: number[]; buckets: BandBucket[]; routes: Record<string, BandBucket[]>;
}
// Delay minutes vs timetable at quantile probs.
export interface DelayDist { probs: number[]; minutes: number[] }

const LO = 0.02, HI = 0.98; // never claim certainty from a day or two of data
const clamp = (p: number) => Math.min(HI, Math.max(LO, p));

const pick = (bs: BandBucket[] | undefined, lead: number) =>
  bs?.find((b) => b.maxLeadMin === null || lead < b.maxLeadMin);

export function delayDist(bands: BusBands, opts: { route: string; leadMin: number; liveDelayMin: number | null }): DelayDist {
  const b = pick(bands.routes[opts.route], opts.leadMin) ?? pick(bands.buckets, opts.leadMin)!;
  const live = opts.liveDelayMin;
  const raw = live === null ? b.timetable : b.live.map((r) => live + r);
  let m = -Infinity;
  return { probs: bands.probs, minutes: raw.map((x) => (m = Math.max(m, x))) };
}

// Piecewise-linear CDF with linear tails (slope of the end segment), unclamped.
function cdf({ probs: p, minutes: x }: DelayDist, v: number): number {
  const n = x.length;
  const seg = v < x[0] ? 0 : v >= x[n - 1] ? n - 2 : x.findIndex((_, i) => v < x[i + 1]);
  const dx = x[seg + 1] - x[seg];
  if (dx <= 0) return v < x[seg] ? p[seg] : p[seg + 1]; // flat segment = point mass
  return Math.min(1, Math.max(0, p[seg] + ((p[seg + 1] - p[seg]) * (v - x[seg])) / dx));
}

// Inverse of cdf, used for integration.
function quantile({ probs: p, minutes: x }: DelayDist, u: number): number {
  const n = p.length;
  const seg = u < p[0] ? 0 : u >= p[n - 1] ? n - 2 : p.findIndex((_, i) => u < p[i + 1]);
  return x[seg] + ((x[seg + 1] - x[seg]) * (u - p[seg])) / (p[seg + 1] - p[seg]);
}

export const chanceAtMost = (dist: DelayDist, min: number) => clamp(cdf(dist, min));

export const range80 = (dist: DelayDist): [number, number] => [quantile(dist, 0.1), quantile(dist, 0.9)];

// P(first arrival + walk <= second departure). null leg = runs exactly to timetable.
export function chanceCatch(
  firstArrive: DelayDist | null, firstSchedArriveS: number, walkS: number,
  second: DelayDist | null, secondSchedDepartS: number,
): number {
  const slackMin = (secondSchedDepartS - firstSchedArriveS - walkS) / 60; // need d1 - d2 <= slack
  if (!firstArrive && !second) return clamp(slackMin >= 0 ? 1 : 0);
  if (!second) return clamp(cdf(firstArrive!, slackMin));
  if (!firstArrive) return clamp(1 - cdf(second, -slackMin));
  const N = 200; // independent legs: average over evenly spaced quantiles of the first
  let s = 0;
  for (let i = 0; i < N; i++) s += 1 - cdf(second, quantile(firstArrive, (i + 0.5) / N) - slackMin);
  return clamp(s / N);
}

let bandsPromise: Promise<BusBands> | undefined;
export function loadBands(): Promise<BusBands> {
  bandsPromise ??= import("../model/bus-bands.json").then((m) => m.default as unknown as BusBands);
  return bandsPromise;
}
