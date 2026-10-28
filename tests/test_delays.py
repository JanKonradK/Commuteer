from __future__ import annotations

from typing import Any

import numpy as np
import pytest

pd = pytest.importorskip("pandas")
pytest.importorskip("torch")

from commuteer.delays import dataset  # noqa: E402
from commuteer.delays.baselines import HistoricalQuantiles, Persistence  # noqa: E402
from commuteer.delays.metrics import (  # noqa: E402
    TARGET_COVERAGE,
    apply_margin,
    conformal_margin,
    score,
)
from commuteer.delays.neural import NeuralConfig, NeuralQuantile  # noqa: E402


def test_midnight_unwrap() -> None:
    times = np.array([86_000.0, np.nan, 100.0, 900.0])  # 23:53, -, 00:01, 00:15
    assert dataset._unwrap_midnight(times).tolist()[::2] == [86_000.0, 86_500.0]


def test_actual_time_is_aligned_to_scheduled_day() -> None:
    scheduled = np.array([86_300.0])  # 23:58:20
    actual = np.array([60.0])  # 00:01 next day, i.e. ~2.7 min late
    assert dataset._align(actual, scheduled)[0] == 86_460.0


def test_parse_real_train(movements_xml: bytes) -> None:
    stops = dataset.parse_file(movements_xml)
    passenger = stops[stops["loc_type"].isin(dataset.PASSENGER_STOPS)]
    assert passenger["station"].iloc[0] == "ATLNE" and passenger["station"].iloc[-1] == "HSTON"
    assert passenger["dep_delay_min"].iloc[0] == pytest.approx(0.8)
    assert passenger["arr_delay_min"].iloc[-1] == pytest.approx(-1.0)


def test_build_examples_pairs_every_later_stop(movements_xml: bytes) -> None:
    stops = dataset.parse_file(movements_xml)
    ex = dataset.build_examples(stops[stops["loc_type"].isin(dataset.PASSENGER_STOPS)])
    assert len(ex) == 45  # 10 passenger stops -> 9 + 8 + ... + 1 pairs
    assert (ex["remaining_sched_min"] > 0).all()
    assert ex.loc[ex["from_station"] == "ATLNE", "delay_trend_min"].eq(0).all()
    assert np.allclose(ex["delay_change_min"], ex["target_delay_min"] - ex["current_delay_min"])


def _synthetic(n: int, seed: int) -> Any:
    rng = np.random.default_rng(seed)
    current = rng.normal(2, 3, n)
    remaining = rng.uniform(5, 90, n)
    station = rng.choice(["A", "B", "C"], n)
    noise = rng.normal(0, 0.5 + remaining / 60, n)  # more uncertainty further ahead
    change = np.where(station == "C", 2.0, -0.5) + noise
    hour = rng.uniform(0, 24, n)
    return pd.DataFrame(
        {
            "service_date": pd.Timestamp("2026-10-01")
            + pd.to_timedelta(rng.integers(0, 30, n), "D"),
            "current_delay_min": current,
            "delay_trend_min": rng.normal(0, 1, n),
            "remaining_sched_min": remaining,
            "stops_between": rng.integers(0, 10, n),
            "hour_sin": np.sin(hour),
            "hour_cos": np.cos(hour),
            "from_station": "X",
            "to_station": station,
            "route": np.char.add("X > ", station),
            "service_type": "A",
            "weekday": "1",
            "delay_change_min": change,
            "target_delay_min": current + change,
        }
    )


def test_time_split_never_trains_on_the_future() -> None:
    train, calib, test = dataset.time_split(_synthetic(3000, 0), test_days=5, calib_days=5)
    assert train["service_date"].max() < calib["service_date"].min()
    assert calib["service_date"].max() < test["service_date"].min()


def test_conformal_calibration_hits_target_coverage() -> None:
    rng = np.random.default_rng(1)
    y_cal, y_test = rng.normal(0, 2, 5000), rng.normal(0, 2, 5000)
    too_narrow = np.tile([-0.5, 0.0, 0.5], (5000, 1))
    assert score(y_test, too_narrow).coverage < 0.3
    margin = conformal_margin(y_cal, too_narrow, TARGET_COVERAGE)
    assert score(y_test, apply_margin(too_narrow, margin)).coverage == pytest.approx(0.8, abs=0.02)


def test_historical_beats_persistence_on_station_effect() -> None:
    train, test = _synthetic(5000, 2), _synthetic(2000, 3)
    y = test["delay_change_min"].to_numpy()
    hist = score(y, HistoricalQuantiles(min_count=10).fit(train).predict_change(test))
    pers = score(y, Persistence().fit(train).predict_change(test))
    assert hist.pinball < pers.pinball


def test_neural_net_learns_and_keeps_quantiles_ordered() -> None:
    train, test = _synthetic(6000, 4), _synthetic(2000, 5)
    model = NeuralQuantile(NeuralConfig(epochs=15, batch_size=512, hidden=32, layers=2)).fit(train)
    pred = model.predict_change(test)
    assert (pred[:, 0] <= pred[:, 1]).all() and (pred[:, 1] <= pred[:, 2]).all()
    assert model.history[-1] < model.history[0]
    nn_score = score(test["delay_change_min"].to_numpy(), pred)
    persistence = score(test["delay_change_min"].to_numpy(), np.zeros_like(pred))
    assert nn_score.pinball < persistence.pinball
