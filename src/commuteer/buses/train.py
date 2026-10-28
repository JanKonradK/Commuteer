"""Bus delay model: learns when to trust TFI's live estimate and how to correct it.

Same machinery as the train model (`commuteer.delays`): PyTorch quantile network,
gradient boosting, conformal calibration, MLflow. Each training row is a moment
when someone could have asked "when will this bus reach stop X?", with what was
known then (TFI's estimate, the bus's GPS-measured delay) and what happened.

Models predict the *correction* to TFI's estimate, so "trust TFI" is the
starting point and the model only has to learn where TFI goes wrong.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import logging
from pathlib import Path

import mlflow
import numpy as np
import pandas as pd

from commuteer.delays.baselines import GradientBoosting
from commuteer.delays.metrics import TARGET_COVERAGE, apply_margin, conformal_margin, score
from commuteer.delays.neural import NeuralConfig, NeuralQuantile

log = logging.getLogger(__name__)
EXPERIMENT = "bus-delay"

# Everything here must be known at the moment of prediction. `lead_min` and
# `lead_target_min` are derived from the actual arrival, so they're used only to
# group results in the report, never as model inputs.
NUMERIC = [
    "tfi",
    "gps_delay",
    "gps_trend",
    "sched_lead_min",  # timetabled minutes until the stop (NOT actual: that would leak the answer)
    "since_last_stop_min",
    "stops_ahead",
    "remaining_sched_min",
    "hour_sin",
    "hour_cos",
]
CATEGORICAL = ["route", "to_stop", "weekday"]
TARGET = "correction"  # actual - tfi


def load_examples(data: Path) -> pd.DataFrame:
    frames = []
    for path in sorted((data / "silver" / "bus_examples").rglob("*.csv.gz")):
        frames.append(pd.read_csv(io.BytesIO(gzip.decompress(path.read_bytes()))))
    if not frames:
        raise SystemExit("No bus examples yet: run `commuteer-buses history` first.")
    df = pd.concat(frames, ignore_index=True)
    df["hour_sin"] = np.sin(2 * np.pi * df["hour"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour"] / 24)
    df["weekday"] = df["weekday"].astype(str)
    df["route"] = df["route"].astype(str)
    df["to_stop"] = df["to_stop"].astype(str)
    df[TARGET] = df["actual"] - df["tfi"]
    return df


def split(
    df: pd.DataFrame, min_days: int = 7
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, str]:
    """By date once there's enough history (train on the past, test on the newest days).

    With less than `min_days`, fall back to splitting by trip: whole trips are
    held out, but test trips ran on the same days as training ones, so scores
    are optimistic. The report says which split was used.
    """
    dates = sorted(df["service_date"].unique())
    if len(dates) >= min_days:
        test_days = dates[-max(1, len(dates) // 5) :]
        calib_day = dates[-len(test_days) - 1]
        train = df[df["service_date"] < calib_day]
        calib = df[df["service_date"] == calib_day]
        test = df[df["service_date"].isin(test_days)]
        return train, calib, test, f"by date ({len(dates)} days; test = last {len(test_days)})"
    bucket = df["trip"].map(lambda t: int(hashlib.md5(str(t).encode()).hexdigest(), 16) % 10)
    return (
        df[bucket < 6],
        df[(bucket >= 6) & (bucket < 8)],
        df[bucket >= 8],
        f"by trip ({len(dates)} day(s) only: optimistic until a week of history exists)",
    )


def constant(df: pd.DataFrame, values: np.ndarray) -> np.ndarray:
    return np.column_stack([values, values, values])


def evaluate_all(df: pd.DataFrame, epochs: int) -> tuple[pd.DataFrame, str, pd.DataFrame]:
    train, calib, test, how = split(df)

    def tfi(d: pd.DataFrame) -> np.ndarray:
        return d["tfi"].to_numpy(dtype=float)

    candidates: dict[str, tuple[np.ndarray, np.ndarray]] = {
        # (calibration predictions, test predictions) of the actual delay
        "tfi_live_estimate": (constant(calib, tfi(calib)), constant(test, tfi(test))),
        "timetable": (constant(calib, np.zeros(len(calib))), constant(test, np.zeros(len(test)))),
        "gps_delay_carried_forward": (
            constant(calib, calib["gps_delay"].to_numpy(dtype=float)),
            constant(test, test["gps_delay"].to_numpy(dtype=float)),
        ),
    }
    gb = GradientBoosting(numeric=NUMERIC, categorical=CATEGORICAL, target=TARGET).fit(train)
    nn = NeuralQuantile(
        NeuralConfig(epochs=epochs), numeric=NUMERIC, categorical=CATEGORICAL, target=TARGET
    ).fit(train)
    for name, model in (("gradient_boosting", gb), ("pytorch_quantile_net", nn)):
        candidates[name] = (
            model.predict_change(calib) + tfi(calib)[:, None],
            model.predict_change(test) + tfi(test)[:, None],
        )

    y_calib = calib["actual"].to_numpy(dtype=float)
    y_test = test["actual"].to_numpy(dtype=float)
    rows, calibrated = [], {}
    for name, (pc, pt) in candidates.items():
        margin = conformal_margin(y_calib, pc, TARGET_COVERAGE)
        calibrated[name] = apply_margin(pt, margin)
        rows.append({"model": name, **score(y_test, calibrated[name]).as_dict()})
    results = pd.DataFrame(rows)

    # Error of the middle prediction by lead time and for route 466, per model.
    detail = []
    for name, pred in calibrated.items():
        err = np.abs(pred[:, 1] - y_test)
        by_lead = pd.Series(err).groupby(test["lead_target_min"].to_numpy()).mean()
        r466 = test["route"].str.contains(" 466 ").to_numpy()
        detail.append(
            {
                "model": name,
                **{f"{k} min": v for k, v in by_lead.items()},
                "route 466": float(err[r466].mean()) if r466.any() else float("nan"),
            }
        )
    info = (
        f"{how}; {len(train):,} / {len(calib):,} / {len(test):,} examples (train / calibration / "
        f"test), {df['trip'].nunique():,} trips, {df['route'].nunique()} routes"
    )
    return results, info, pd.DataFrame(detail)


def train_buses(data: Path, tracking_uri: str, report: Path, epochs: int = 8) -> None:
    df = load_examples(data)
    results, info, detail = evaluate_all(df, epochs)
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(EXPERIMENT)
    with mlflow.start_run(run_name="bus-models"):
        mlflow.log_param("split", info)
        for _, r in results.iterrows():
            mlflow.log_metrics({f"{r['model']}_{k}": float(r[k]) for k in results.columns[1:]})
    lines = [
        "# Bus delay model results",
        "",
        "Task: predict a bus's delay at a stop it hasn't reached yet, 5-60 minutes ahead.",
        "Actual delays come from GPS positions (when the bus really passed the stop), not",
        "from TFI's estimates. All models' ranges are calibrated to cover ~80%.",
        "",
        f"Data: {info}.",
        "",
        "| Model | Error of middle estimate (min) | Pinball loss | Coverage | Range width (min) |",
        "|---|---|---|---|---|",
        *[
            f"| {r['model']} | {r['mae_min']:.2f} | {r['pinball']:.3f} | {r['coverage']:.1%} | "
            f"{r['width_min']:.2f} |"
            for _, r in results.iterrows()
        ],
        "",
        "## Error (min) by how far ahead, and on route 466",
        "",
        detail.to_markdown(index=False, floatfmt=".2f"),
    ]
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(results.to_string(index=False))
    print()
    print(detail.to_string(index=False))
    print(f"\n{info}\nReport written to {report}")
