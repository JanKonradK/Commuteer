"""Train and compare delay models, tracked in MLflow.

uv run --extra ml commuteer-train --data data
uv run --extra ml mlflow ui --backend-store-uri sqlite:///mlflow.db   # browse runs
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path
from typing import Protocol

import mlflow
import numpy as np
import pandas as pd

from commuteer.delays import dataset
from commuteer.delays.baselines import GradientBoosting, HistoricalQuantiles, Persistence, Timetable
from commuteer.delays.dataset import FEATURES_CATEGORICAL, FEATURES_NUMERIC
from commuteer.delays.metrics import TARGET_COVERAGE, apply_margin, conformal_margin, score
from commuteer.delays.neural import NeuralConfig, NeuralQuantile

log = logging.getLogger(__name__)
EXPERIMENT = "train-delay-propagation"


class Model(Protocol):
    name: str

    def fit(self, train: pd.DataFrame) -> object: ...
    def predict_change(self, df: pd.DataFrame) -> np.ndarray: ...


def load_stops(data: Path) -> pd.DataFrame:
    """Parse raw movement files once, then reuse the cached Parquet table."""
    cache = data / "silver" / "train_stops.parquet"
    files = sorted((data / "bronze" / "irish_rail_movements").rglob("*.xml.gz"))
    if cache.exists() and cache.stat().st_mtime > max(f.stat().st_mtime for f in files):
        return pd.read_parquet(cache)
    log.info("parsing %d movement files", len(files))
    stops = dataset.parse_movements(files)
    cache.parent.mkdir(parents=True, exist_ok=True)
    stops.to_parquet(cache, index=False)
    return stops


def predict(model: Model, df: pd.DataFrame) -> np.ndarray:
    """Model predicts the change in delay; add the current delay back."""
    current = df["current_delay_min"].to_numpy(dtype=float)[:, None]
    return np.asarray(model.predict_change(df) + current, dtype=float)


def evaluate(
    model: Model, train: pd.DataFrame, calib: pd.DataFrame, test: pd.DataFrame
) -> dict[str, float]:
    started = time.perf_counter()
    model.fit(train)
    fit_s = time.perf_counter() - started

    y_calib = calib["target_delay_min"].to_numpy()
    y_test = test["target_delay_min"].to_numpy()
    pred_calib, pred_test = predict(model, calib), predict(model, test)
    margin = conformal_margin(y_calib, pred_calib, TARGET_COVERAGE)

    return {
        "fit_seconds": fit_s,
        "conformal_margin_min": margin,
        **score(y_test, pred_test).as_dict("raw_"),
        **score(y_test, apply_margin(pred_test, margin)).as_dict("test_"),
    }


def breakdown(model: Model, calib: pd.DataFrame, test: pd.DataFrame, by: str) -> pd.DataFrame:
    """Calibrated test scores per group (e.g. per service type) for the report."""
    margin = conformal_margin(
        calib["target_delay_min"].to_numpy(), predict(model, calib), TARGET_COVERAGE
    )
    pred = apply_margin(predict(model, test), margin)
    rows = []
    for key, idx in test.groupby(by).indices.items():
        s = score(test["target_delay_min"].to_numpy()[idx], pred[idx])
        rows.append({by: key, "examples": len(idx), **s.as_dict()})
    return pd.DataFrame(rows).sort_values("examples", ascending=False)


def export_for_app(model: NeuralQuantile, margin: float, test: pd.DataFrame, path: Path) -> None:
    """Write the network for the phone app, plus parity cases its tests must reproduce."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model.export(margin)), encoding="utf-8")
    cases = test.sample(25, random_state=1)
    expected = model.predict_change(cases)
    parity = [
        {
            "categorical": {c: str(row[c]) for c in FEATURES_CATEGORICAL},
            "numeric": {c: float(row[c]) for c in FEATURES_NUMERIC},
            "expected_change": [round(float(v), 5) for v in pred],
        }
        for (_, row), pred in zip(cases.iterrows(), expected, strict=True)
    ]
    path.with_name("parity-cases.json").write_text(json.dumps(parity, indent=1), encoding="utf-8")
    log.info("exported app model to %s (%.0f KB)", path, path.stat().st_size / 1024)


def write_report(path: Path, results: pd.DataFrame, info: dict[str, object], extra: str) -> None:
    lines = [
        "# Train delay model results",
        "",
        "Task: a train has just left a stop. Predict the range (10th-90th percentile) of its",
        "arrival delay at each later stop, up to 12 stops ahead. Ranges are calibrated with",
        "conformal prediction to contain the real delay 80% of the time.",
        "",
        *[f"- **{k}:** {v}" for k, v in info.items()],
        "",
        "Scores on the held-out test period (most recent days, never seen in training).",
        "MAE = average error of the middle prediction, in minutes. Coverage should be ~80%.",
        "Narrower ranges at the same coverage are better.",
        "",
        "| Model | MAE (min) | Pinball loss | Coverage (raw) | Coverage (calibrated) | "
        "Range width (min) | Fit time (s) |",
        "|---|---|---|---|---|---|---|",
    ]
    for _, r in results.iterrows():
        lines.append(
            f"| {r['model']} | {r['test_mae_min']:.2f} | {r['test_pinball']:.3f} | "
            f"{r['raw_coverage']:.1%} | {r['test_coverage']:.1%} | {r['test_width_min']:.2f} | "
            f"{r['fit_seconds']:.0f} |"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n\n" + extra + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="commuteer-train")
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument("--tracking-uri", default="sqlite:///mlflow.db")
    parser.add_argument("--test-days", type=int, default=14)
    parser.add_argument("--calib-days", type=int, default=7)
    parser.add_argument("--max-train-rows", type=int, default=2_000_000)
    parser.add_argument("--epochs", type=int, default=NeuralConfig.epochs)
    parser.add_argument("--report", type=Path, default=Path("reports/delay_model_results.md"))
    parser.add_argument(
        "--export", type=Path, default=Path("app/src/model/delay-model.json"), help="app model"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    stops = load_stops(args.data)
    examples = dataset.build_examples(stops)
    train, calib, test = dataset.time_split(examples, args.test_days, args.calib_days)
    if len(train) > args.max_train_rows:
        train = train.sample(args.max_train_rows, random_state=0)
    info: dict[str, object] = {
        "Train-days of data": examples["service_date"].nunique(),
        "Date range": f"{examples['service_date'].min():%Y-%m-%d} to "
        f"{examples['service_date'].max():%Y-%m-%d}",
        "Trains (train-days)": f"{stops.groupby(['service_date', 'train_code']).ngroups:,}",
        "Stop records": f"{len(stops):,}",
        "Examples (train / calibration / test)": f"{len(train):,} / {len(calib):,} / {len(test):,}",
    }
    for k, v in info.items():
        log.info("%s: %s", k, v)

    mlflow.set_tracking_uri(args.tracking_uri)
    mlflow.set_experiment(EXPERIMENT)
    cfg = NeuralConfig(epochs=args.epochs)
    models: list[Model] = [
        Timetable(),
        Persistence(),
        HistoricalQuantiles(),
        GradientBoosting(),
        NeuralQuantile(cfg),
    ]
    results = []
    for model in models:
        log.info("training %s", model.name)
        with mlflow.start_run(run_name=model.name):
            mlflow.log_params(
                {
                    "model": model.name,
                    "train_rows": len(train),
                    "test_days": args.test_days,
                    "calib_days": args.calib_days,
                    "target_coverage": TARGET_COVERAGE,
                }
            )
            if isinstance(model, NeuralQuantile):
                mlflow.log_params({f"nn_{k}": v for k, v in cfg.__dict__.items()})
            metrics = evaluate(model, train, calib, test)
            mlflow.log_metrics(metrics)
            if isinstance(model, NeuralQuantile):
                for epoch, loss in enumerate(model.history):
                    mlflow.log_metric("train_pinball", loss, step=epoch)
                # "pickle" keeps the model loadable without a traced graph; the app uses
                # the JSON export below instead.
                mlflow.pytorch.log_model(model.model, name="model", serialization_format="pickle")
                export_for_app(model, metrics["conformal_margin_min"], test, args.export)
                mlflow.log_artifact(str(args.export))
            results.append({"model": model.name, **metrics})
            log.info("%s: %s", model.name, {k: round(v, 3) for k, v in metrics.items()})

    table = pd.DataFrame(results)
    best_name = table.sort_values("test_pinball").iloc[0]["model"]
    best = next(m for m in models if m.name == best_name)
    by_type = breakdown(best, calib, test, "service_type")
    by_ahead = breakdown(best, calib, test.assign(ahead=test["stops_between"] + 1), "ahead")
    extra = (
        f"## Best model ({best_name}) by service type\n\n"
        "Code letter: A/P/D = InterCity and Commuter, E = DART (full list in the README).\n\n"
        + by_type.to_markdown(index=False, floatfmt=".2f")
        + f"\n\n## Best model ({best_name}) by stops ahead\n\n"
        + by_ahead.sort_values("ahead").to_markdown(index=False, floatfmt=".2f")
    )
    write_report(args.report, table, info, extra)
    print(table.to_string(index=False))
    print(f"\nReport written to {args.report}")


if __name__ == "__main__":
    main()
