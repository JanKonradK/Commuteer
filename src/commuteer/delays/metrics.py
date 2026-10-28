"""Scoring for predicted delay ranges, plus conformal calibration.

Every model outputs three numbers per example: the 10th, 50th and 90th
percentile of arrival delay. The 10-90 range should contain the real delay
80% of the time. Conformal calibration (CQR, Romano et al. 2019) widens or
narrows the range using held-out data so that guarantee actually holds.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

QUANTILES = (0.1, 0.5, 0.9)
TARGET_COVERAGE = QUANTILES[2] - QUANTILES[0]  # 0.8


def pinball_loss(
    y: np.ndarray, pred: np.ndarray, quantiles: tuple[float, ...] = QUANTILES
) -> float:
    """Average quantile loss over all quantiles. Lower is better."""
    losses = []
    for i, q in enumerate(quantiles):
        err = y - pred[:, i]
        losses.append(np.mean(np.maximum(q * err, (q - 1) * err)))
    return float(np.mean(losses))


@dataclass(frozen=True)
class Scores:
    mae_min: float  # error of the median prediction, in minutes
    pinball: float
    coverage: float  # share of real delays inside the 10-90 range
    width_min: float  # average width of that range

    def as_dict(self, prefix: str = "") -> dict[str, float]:
        return {f"{prefix}{k}": v for k, v in self.__dict__.items()}


def score(y: np.ndarray, pred: np.ndarray) -> Scores:
    lo, mid, hi = pred[:, 0], pred[:, 1], pred[:, 2]
    return Scores(
        mae_min=float(np.mean(np.abs(y - mid))),
        pinball=pinball_loss(y, pred),
        coverage=float(np.mean((y >= lo) & (y <= hi))),
        width_min=float(np.mean(hi - lo)),
    )


def conformal_margin(y_calib: np.ndarray, pred_calib: np.ndarray, coverage: float) -> float:
    """CQR: how much to widen (or narrow, if negative) the range to hit `coverage`."""
    lo, hi = pred_calib[:, 0], pred_calib[:, 2]
    conformity = np.maximum(lo - y_calib, y_calib - hi)
    n = len(y_calib)
    level = min(1.0, np.ceil((n + 1) * coverage) / n)
    return float(np.quantile(conformity, level, method="higher"))


def apply_margin(pred: np.ndarray, margin: float) -> np.ndarray:
    out = pred.copy()
    out[:, 0] -= margin
    out[:, 2] += margin
    return out
