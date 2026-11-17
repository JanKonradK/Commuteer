from __future__ import annotations

import csv
import gzip
import json
from pathlib import Path

from commuteer.buses.bands import export_bands

COLS = "service_date,trip,route,from_stop,to_stop,lead_target_min,lead_min,sched_lead_min,since_last_stop_min,stops_ahead,remaining_sched_min,hour,weekday,tfi,gps_delay,gps_trend,actual".split(",")


def test_export_bands(tmp_path: Path) -> None:
    d = tmp_path / "silver" / "bus_examples" / "date=2026-01-01"
    d.mkdir(parents=True)
    with gzip.open(d / "bus_examples.csv.gz", "wt", newline="") as fh:
        w = csv.DictWriter(fh, COLS)
        w.writeheader()
        for i in range(101):  # residual 0..100 -> 0.01 quantiles, tfi=1
            route = "X 466 a" if i < 50 else "X 20 a"
            w.writerow({c: "" for c in COLS} | {"service_date": "2026-01-01", "route": route, "sched_lead_min": "7", "tfi": "1", "actual": str(i + 1)})
        w.writerow({c: "" for c in COLS} | {"service_date": "2026-01-02", "route": "X", "sched_lead_min": "60", "tfi": "", "actual": "3"})
    out = tmp_path / "bands.json"
    export_bands(tmp_path, out)
    b = json.loads(out.read_text())
    assert b["rows"] == 101 and b["days"] == 1
    [bk] = b["buckets"]
    assert bk["maxLeadMin"] == 10 and bk["n"] == 101
    assert bk["live"] == [5, 10, 25, 50, 75, 90, 95]
    assert bk["timetable"] == [6, 11, 26, 51, 76, 91, 96]
    assert b["routes"]["466"] == []  # < 200 rows
