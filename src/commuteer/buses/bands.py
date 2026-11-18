"""Empirical delay quantiles per lead-time bucket, so the app can say
"80% chance the bus arrives between 17:42 and 17:51" without running a model.

"live" = error of TFI's live prediction (actual - tfi); "timetable" = delay vs
timetable, used when there is no live info for the trip.

    uv run commuteer-buses bands --data data --out app/src/model/bus-bands.json
"""

from __future__ import annotations

import csv
import gzip
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PROBS = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]
EDGES = [5, 10, 20, 30, 45, None]  # bucket upper bounds on sched_lead_min; None = open
ROUTE_MIN_ROWS = 200


def _bucket(lead: float) -> int:
    return next(i for i, e in enumerate(EDGES) if e is None or lead < e)


def _quantiles(xs: list[float]) -> list[float]:
    xs = sorted(xs)
    out = []
    for p in PROBS:  # linear interpolation, same as numpy's default
        k = p * (len(xs) - 1)
        lo, hi = math.floor(k), math.ceil(k)
        out.append(round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 2))
    return out


def _buckets(rows: list[tuple[int, float, float]], min_n: int) -> list[dict[str, Any]]:
    out = []
    for i, edge in enumerate(EDGES):
        live = [r for b, r, _ in rows if b == i]
        tt = [a for b, _, a in rows if b == i]
        if len(live) >= max(min_n, 1):
            out.append(
                {
                    "maxLeadMin": edge,
                    "live": _quantiles(live),
                    "timetable": _quantiles(tt),
                    "n": len(live),
                }
            )
    return out


def export_bands(data: Path, out: Path) -> dict[str, Any]:
    rows: list[tuple[int, float, float]] = []
    r466: list[tuple[int, float, float]] = []
    days: set[str] = set()
    for f in sorted((data / "silver" / "bus_examples").glob("**/*.csv.gz")):
        with gzip.open(f, "rt", newline="") as fh:
            for r in csv.DictReader(fh):
                try:
                    row = (
                        _bucket(float(r["sched_lead_min"])),
                        float(r["actual"]) - float(r["tfi"]),
                        float(r["actual"]),
                    )
                except (ValueError, KeyError):
                    continue  # missing tfi/actual
                days.add(r["service_date"])
                rows.append(row)
                if " 466 " in f" {r['route']} ":
                    r466.append(row)
    bands = {
        "format": "commuteer-bus-bands/1",
        "generated": datetime.now(UTC).isoformat(timespec="seconds"),
        "days": len(days),
        "rows": len(rows),
        "probs": PROBS,
        "buckets": _buckets(rows, 1),
        "routes": {"466": _buckets(r466, ROUTE_MIN_ROWS)},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bands, indent=1), encoding="utf-8")
    return bands
