"""Turn raw Irish Rail movement records into a modelling dataset.

Stage 1 (`parse_movements`): one row per train per stop, with scheduled and
actual times as seconds since the service day's midnight (handles trains that
run past midnight) and delays in minutes.

Stage 2 (`build_examples`): the prediction task. For every train, at every
stop where we've seen it depart, pair it with every later stop it arrives at:

    "Train A701 left Clara 4.5 min late. How late will it reach Dublin Heuston?"

The target is the arrival delay at the later stop. Models predict the *change*
in delay (target minus current delay), which is easier to learn.
"""

from __future__ import annotations

import gzip
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from pathlib import Path

import numpy as np
import pandas as pd

from commuteer.collector.irish_rail import NS, parse_train_date

DAY_S = 86_400
HALF_DAY_S = DAY_S // 2
PASSENGER_STOPS = {"O", "S", "D"}  # origin, stop, destination; "T" is a timing point only
MAX_ABS_DELAY_MIN = 120  # the feed has glitches like "-97 mins late"; drop beyond 2 hours

FIELDS = [
    "TrainCode",
    "TrainDate",
    "LocationCode",
    "LocationOrder",
    "LocationType",
    "TrainOrigin",
    "TrainDestination",
    "ScheduledArrival",
    "ScheduledDeparture",
    "Arrival",
    "Departure",
]


def _seconds(text: str | None) -> float:
    """'HH:MM:SS' -> seconds. Empty or '00:00:00' (the feed's "not applicable") -> NaN."""
    if not text or text == "00:00:00":
        return np.nan
    h, m, s = text.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _unwrap_midnight(times: np.ndarray) -> np.ndarray:
    """Scheduled times along a journey only go forward; add a day after midnight."""
    out = times.copy()
    offset, last = 0, -np.inf
    for i, t in enumerate(times):
        if np.isnan(t):
            continue
        if t + offset < last - HALF_DAY_S:
            offset += DAY_S
        out[i] = t + offset
        last = out[i]
    return out


def _align(actual: np.ndarray, scheduled: np.ndarray) -> np.ndarray:
    """Put an actual time on the same day as its scheduled time (closest within 12 h)."""
    aligned: np.ndarray = actual - np.round((actual - scheduled) / DAY_S) * DAY_S
    return aligned


def parse_file(xml_bytes: bytes) -> pd.DataFrame:
    root = ET.fromstring(xml_bytes)
    rows = [
        {f: (el.findtext(f"ir:{f}", "", NS) or "").strip() for f in FIELDS}
        for el in root.iterfind("ir:objTrainMovements", NS)
    ]
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["loc_order"] = df["LocationOrder"].astype(int)
    df = df.sort_values("loc_order")

    sched_arr = np.array([_seconds(t) for t in df["ScheduledArrival"]], dtype=float)
    sched_dep = np.array([_seconds(t) for t in df["ScheduledDeparture"]], dtype=float)
    # Unwrap arrivals and departures together, in journey order.
    both = _unwrap_midnight(np.column_stack([sched_arr, sched_dep]).ravel()).reshape(-1, 2)
    sched_arr, sched_dep = both[:, 0], both[:, 1]
    act_arr = _align(np.array([_seconds(t) for t in df["Arrival"]], dtype=float), sched_arr)
    act_dep = _align(np.array([_seconds(t) for t in df["Departure"]], dtype=float), sched_dep)

    return pd.DataFrame(
        {
            "service_date": pd.to_datetime(parse_train_date(df["TrainDate"].iloc[0])),
            "train_code": df["TrainCode"].to_numpy(),
            "route": (df["TrainOrigin"] + " > " + df["TrainDestination"]).to_numpy(),
            "station": df["LocationCode"].to_numpy(),
            "loc_order": df["loc_order"].to_numpy(),
            "loc_type": df["LocationType"].to_numpy(),
            "sched_arr_s": sched_arr,
            "sched_dep_s": sched_dep,
            "arr_delay_min": (act_arr - sched_arr) / 60,
            "dep_delay_min": (act_dep - sched_dep) / 60,
        }
    )


def parse_movements(files: Iterable[Path]) -> pd.DataFrame:
    frames = []
    for path in files:
        raw = path.read_bytes()
        df = parse_file(gzip.decompress(raw) if path.suffix == ".gz" else raw)
        if not df.empty:
            frames.append(df[df["loc_type"].isin(PASSENGER_STOPS)])
    stops = pd.concat(frames, ignore_index=True)
    for col in ("arr_delay_min", "dep_delay_min"):
        stops.loc[stops[col].abs() > MAX_ABS_DELAY_MIN, col] = np.nan
    return stops


FEATURES_NUMERIC = [
    "current_delay_min",
    "delay_trend_min",
    "remaining_sched_min",
    "stops_between",
    "hour_sin",
    "hour_cos",
]
FEATURES_CATEGORICAL = ["from_station", "to_station", "route", "service_type", "weekday"]


def build_examples(stops: pd.DataFrame, max_stops_ahead: int = 12) -> pd.DataFrame:
    """Pair each observed departure with later observed arrivals on the same train.

    Capped at `max_stops_ahead` so long DART runs (~30 stops) don't swamp the data.
    """
    stops = stops.sort_values(["service_date", "train_code", "loc_order"], ignore_index=True)
    trip_id = stops.groupby(["service_date", "train_code"], sort=False).ngroup().to_numpy()
    pos = stops.groupby(trip_id).cumcount().to_numpy()
    dep = stops["dep_delay_min"].to_numpy()
    arr = stops["arr_delay_min"].to_numpy()
    sched_dep = stops["sched_dep_s"].to_numpy()
    sched_arr = stops["sched_arr_s"].to_numpy()
    # Delay at the previous stop of the same trip (NaN at the origin).
    prev_dep = np.where(pos > 0, np.roll(dep, 1), np.nan)

    pairs_k, pairs_j = [], []
    for ahead in range(1, max_stops_ahead + 1):
        k = np.arange(len(stops) - ahead)
        j = k + ahead
        same_trip = trip_id[k] == trip_id[j]
        usable = (
            same_trip
            & ~np.isnan(dep[k])
            & ~np.isnan(sched_dep[k])
            & ~np.isnan(arr[j])
            & ~np.isnan(sched_arr[j])
        )
        pairs_k.append(k[usable])
        pairs_j.append(j[usable])
    k, j = np.concatenate(pairs_k), np.concatenate(pairs_j)

    trend = dep[k] - prev_dep[k]
    ex = pd.DataFrame(
        {
            "service_date": stops["service_date"].to_numpy()[k],
            "train_code": stops["train_code"].to_numpy()[k],
            "route": stops["route"].to_numpy()[k],
            "from_station": stops["station"].to_numpy()[k],
            "to_station": stops["station"].to_numpy()[j],
            "current_delay_min": dep[k],
            # Is the train losing or gaining time? (0 at the origin)
            "delay_trend_min": np.where(np.isnan(trend), 0.0, trend),
            "remaining_sched_min": (sched_arr[j] - sched_dep[k]) / 60,
            "stops_between": j - k - 1,
            "sched_dep_s": sched_dep[k],
            "target_delay_min": arr[j],
        }
    )
    hour = (ex["sched_dep_s"] % DAY_S) / 3600
    ex["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    ex["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    ex["weekday"] = ex["service_date"].dt.day_of_week.astype(str)
    # The code's letter is the service family, e.g. A = InterCity, E = DART, P = Commuter.
    ex["service_type"] = ex["train_code"].str[0]
    ex["delay_change_min"] = ex["target_delay_min"] - ex["current_delay_min"]
    return ex


def time_split(
    ex: pd.DataFrame, test_days: int = 14, calib_days: int = 7
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Split by date, never randomly: models train on the past and are tested on the future."""
    dates = np.sort(ex["service_date"].unique())
    test_start = dates[-test_days]
    calib_start = dates[-(test_days + calib_days)]
    train = ex[ex["service_date"] < calib_start]
    calib = ex[(ex["service_date"] >= calib_start) & (ex["service_date"] < test_start)]
    test = ex[ex["service_date"] >= test_start]
    return train, calib, test
