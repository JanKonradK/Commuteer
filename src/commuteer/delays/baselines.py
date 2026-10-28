"""Reference models. A learned model is only worth it if it beats these.

All predict the *change* in delay between the current stop and the target
stop; callers add the current delay back.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from commuteer.delays.dataset import FEATURES_CATEGORICAL, FEATURES_NUMERIC
from commuteer.delays.metrics import QUANTILES


class Timetable:
    """What the printed timetable implies: the train arrives on time."""

    name = "timetable"

    def fit(self, train: pd.DataFrame) -> Timetable:
        return self

    def predict_change(self, df: pd.DataFrame) -> np.ndarray:
        # Change that would bring the delay to zero, with no uncertainty.
        change = -df["current_delay_min"].to_numpy()
        return np.column_stack([change] * len(QUANTILES))


class Persistence:
    """What most apps show: the current delay stays the same."""

    name = "persistence"

    def fit(self, train: pd.DataFrame) -> Persistence:
        return self

    def predict_change(self, df: pd.DataFrame) -> np.ndarray:
        return np.zeros((len(df), len(QUANTILES)))


class HistoricalQuantiles:
    """Empirical percentiles of past delay changes for the same route and stop pair.

    Falls back to the to-station, then to all data, when a pair is rare.
    """

    name = "historical"

    def __init__(self, min_count: int = 30) -> None:
        self.min_count = min_count

    def fit(self, train: pd.DataFrame) -> HistoricalQuantiles:
        self.levels: list[tuple[list[str], pd.DataFrame]] = []
        for keys in (["route", "from_station", "to_station"], ["to_station"]):
            g = train.groupby(keys)["delay_change_min"]
            table = g.quantile(np.array(QUANTILES)).unstack()
            table = table[g.size() >= self.min_count]
            self.levels.append((keys, table))
        self.global_q = train["delay_change_min"].quantile(np.array(QUANTILES)).to_numpy()
        return self

    def predict_change(self, df: pd.DataFrame) -> np.ndarray:
        out = np.full((len(df), len(QUANTILES)), np.nan)
        for keys, table in self.levels:
            missing = np.isnan(out[:, 0])
            if not missing.any():
                break
            idx = (
                pd.MultiIndex.from_frame(df.loc[missing, keys])
                if len(keys) > 1
                else df.loc[missing, keys[0]]
            )
            out[missing] = table.reindex(idx).to_numpy()
        still = np.isnan(out[:, 0])
        out[still] = self.global_q
        return out


class GradientBoosting:
    """One gradient-boosted tree model per quantile (scikit-learn)."""

    name = "gradient_boosting"

    def __init__(
        self,
        max_iter: int = 300,
        learning_rate: float = 0.1,
        seed: int = 0,
        numeric: list[str] = FEATURES_NUMERIC,
        categorical: list[str] = FEATURES_CATEGORICAL,
        target: str = "delay_change_min",
    ) -> None:
        self.params = {"max_iter": max_iter, "learning_rate": learning_rate, "random_state": seed}
        self.numeric, self.categorical, self.target = numeric, categorical, target

    def _matrix(self, df: pd.DataFrame) -> pd.DataFrame:
        x = df[self.numeric + self.categorical].copy()
        for col in self.categorical:
            x[col] = pd.Categorical(x[col], categories=self.categories[col])
        return x

    MAX_CATEGORIES = 254  # scikit-learn's limit is 255 including "missing"

    def fit(self, train: pd.DataFrame) -> GradientBoosting:
        # Keep the most frequent values; rarer ones (e.g. quiet bus stops) count as missing.
        self.categories = {
            c: sorted(train[c].value_counts().index[: self.MAX_CATEGORIES])
            for c in self.categorical
        }
        x = self._matrix(train)
        y = train[self.target].to_numpy()
        self.models = [
            HistGradientBoostingRegressor(
                loss="quantile", quantile=q, categorical_features="from_dtype", **self.params
            ).fit(x, y)
            for q in QUANTILES
        ]
        return self

    def predict_change(self, df: pd.DataFrame) -> np.ndarray:
        x = self._matrix(df)
        pred = np.column_stack([m.predict(x) for m in self.models])
        return np.sort(pred, axis=1)  # separate models can cross; keep percentiles in order
