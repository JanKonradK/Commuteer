// On-device inference for the PyTorch delay model.
// The network is exported from Python (`commuteer-train`) as JSON weights and the
// forward pass is reimplemented here, so predictions need no server or ML runtime.
// tests/model.test.ts checks this matches PyTorch's outputs on real test cases.

export interface ModelJson {
  format: string;
  quantiles: number[];
  conformal_margin_min: number;
  categorical: string[];
  numeric: string[];
  vocab: Record<string, Record<string, number>>;
  numeric_mean: number[];
  numeric_std: number[];
  embeddings: number[][][];
  layers: { weight: number[][]; bias: number[] }[];
  head: { weight: number[][]; bias: number[] };
}

export type Quantiles = [number, number, number]; // 10th, 50th, 90th percentile

const UNKNOWN = 0; // index for categories the model never saw in training

/** Error function (Abramowitz & Stegun 7.1.26, max error 1.5e-7). */
export function erf(x: number): number {
  const sign = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
}

const gelu = (x: number) => 0.5 * x * (1 + erf(x / Math.SQRT2));
const softplus = (x: number) => (x > 20 ? x : Math.log1p(Math.exp(x)));

function linear(input: number[], weight: number[][], bias: number[]): number[] {
  return weight.map((row, i) => {
    let sum = bias[i];
    for (let j = 0; j < row.length; j++) sum += row[j] * input[j];
    return sum;
  });
}

export class DelayModel {
  constructor(readonly json: ModelJson) {
    if (!json.format.startsWith("commuteer-quantile-net/")) {
      throw new Error(`Unsupported model format: ${json.format}`);
    }
  }

  /** Predicted change in delay (minutes) between the current stop and the target stop. */
  predictChange(categorical: Record<string, string>, numeric: Record<string, number>): Quantiles {
    const m = this.json;
    const parts: number[] = [];
    m.categorical.forEach((name, i) => {
      const index = m.vocab[name][categorical[name]] ?? UNKNOWN;
      parts.push(...m.embeddings[i][index]);
    });
    m.numeric.forEach((name, i) => {
      parts.push((numeric[name] - m.numeric_mean[i]) / m.numeric_std[i]);
    });

    let h = parts;
    for (const layer of m.layers) h = linear(h, layer.weight, layer.bias).map(gelu);
    const [mid, gapLo, gapHi] = linear(h, m.head.weight, m.head.bias);
    return [mid - softplus(gapLo), mid, mid + softplus(gapHi)];
  }

  /** Arrival delay range, widened by the conformal margin to cover ~80% of real delays. */
  predictArrivalDelay(
    currentDelayMin: number,
    categorical: Record<string, string>,
    numeric: Record<string, number>,
  ): Quantiles {
    const [lo, mid, hi] = this.predictChange(categorical, numeric);
    const margin = this.json.conformal_margin_min;
    return [currentDelayMin + lo - margin, currentDelayMin + mid, currentDelayMin + hi + margin];
  }
}

/**
 * Rough probability that the delay is at most `limitMin`, interpolating a CDF
 * through the 10th/50th/90th percentiles. Clamped to 5-95%: three points can't
 * support more confident claims about the tails.
 */
export function chanceWithin(q: Quantiles, limitMin: number): number {
  const xs = q;
  const ps = [0.1, 0.5, 0.9];
  let p: number;
  if (limitMin <= xs[0]) {
    const slope = xs[1] > xs[0] ? 0.4 / (xs[1] - xs[0]) : Infinity;
    p = 0.1 - (xs[0] - limitMin) * slope;
  } else if (limitMin >= xs[2]) {
    const slope = xs[2] > xs[1] ? 0.4 / (xs[2] - xs[1]) : Infinity;
    p = 0.9 + (limitMin - xs[2]) * slope;
  } else {
    const i = limitMin <= xs[1] ? 0 : 1;
    const span = xs[i + 1] - xs[i];
    p = span > 0 ? ps[i] + ((limitMin - xs[i]) / span) * 0.4 : ps[i + 1];
  }
  return Math.min(0.95, Math.max(0.05, p));
}
