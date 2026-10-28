"""Cut the national GTFS timetable down to a region, small enough to ship in the app.

The national file is ~200 MB. A pack keeps only stops within a radius of a
point, the trips that call at two or more of them, and which dates each trip
runs (calendar + calendar_dates resolved into a bitmask), so the phone can
answer "next buses from A to B" offline.

Standard library only, so the same code can later run in the nightly Lambda.

    uv run commuteer-buses pack --gtfs data/gtfs/GTFS_All.zip --out app/src/data/bus-pack.json
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import zipfile
from collections import defaultdict
from collections.abc import Iterator
from datetime import date, timedelta
from pathlib import Path
from typing import Any

ATHLONE = (53.4239, -7.9407)
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
BUS_ROUTE_TYPES = {"3", "700", "702", "704", "711", "712", "715"}  # GTFS bus/coach types


def km_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[0] + b[0]) / 2)
    dy = math.radians(a[0] - b[0])
    dx = math.radians(a[1] - b[1]) * math.cos(lat)
    return 6371 * math.hypot(dx, dy)


def gtfs_minutes(hms: str) -> int:
    """GTFS times can pass 24:00 for trips after midnight; keep them as minutes."""
    h, m, s = hms.split(":")
    return int(h) * 60 + int(m) + round(int(s) / 60)


def active_dates(
    service: dict[str, str] | None, exceptions: dict[date, str], start: date, days: int
) -> str:
    """Bitmask string over `days` days from `start`: '1' if the service runs."""
    bits = []
    for i in range(days):
        d = start + timedelta(days=i)
        runs = False
        if service is not None:
            in_range = service["start_date"] <= d.strftime("%Y%m%d") <= service["end_date"]
            runs = in_range and service[WEEKDAYS[d.weekday()]] == "1"
        if exceptions.get(d) == "1":
            runs = True
        elif exceptions.get(d) == "2":
            runs = False
        bits.append("1" if runs else "0")
    return "".join(bits)


def build_pack(
    gtfs_zip: Path,
    center: tuple[float, float] = ATHLONE,
    radius_km: float = 40,
    start: date | None = None,
    days: int = 120,
) -> dict[str, Any]:
    start = start or date.today()
    with zipfile.ZipFile(gtfs_zip) as z:

        def rows(name: str) -> Iterator[dict[str, str]]:
            yield from csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig"))

        agencies = {a["agency_id"]: a["agency_name"] for a in rows("agency.txt")}
        routes = {
            r["route_id"]: r for r in rows("routes.txt") if r["route_type"] in BUS_ROUTE_TYPES
        }
        stops = {
            s["stop_id"]: s
            for s in rows("stops.txt")
            if s["stop_lat"]
            and km_between(center, (float(s["stop_lat"]), float(s["stop_lon"]))) <= radius_km
        }
        trips = {t["trip_id"]: t for t in rows("trips.txt") if t["route_id"] in routes}

        calls: dict[str, list[tuple[int, str, int, int]]] = defaultdict(list)
        for st in rows("stop_times.txt"):
            if st["trip_id"] in trips and st["stop_id"] in stops:
                calls[st["trip_id"]].append(
                    (
                        int(st["stop_sequence"]),
                        st["stop_id"],
                        gtfs_minutes(st["arrival_time"]),
                        gtfs_minutes(st["departure_time"]),
                    )
                )

        calendar = {c["service_id"]: c for c in rows("calendar.txt")}
        exceptions: dict[str, dict[date, str]] = defaultdict(dict)
        for ex in rows("calendar_dates.txt"):
            d = date(int(ex["date"][:4]), int(ex["date"][4:6]), int(ex["date"][6:]))
            exceptions[ex["service_id"]][d] = ex["exception_type"]

    # Keep trips that call at 2+ stops in the region (a single stop can't be a journey).
    kept = {tid: sorted(c) for tid, c in calls.items() if len(c) >= 2}
    service_ids = sorted({trips[t]["service_id"] for t in kept})
    services = {
        sid: active_dates(calendar.get(sid), exceptions[sid], start, days) for sid in service_ids
    }
    kept = {t: c for t, c in kept.items() if "1" in services[trips[t]["service_id"]]}

    used_stops = sorted({stop for c in kept.values() for _, stop, _, _ in c})
    stop_index = {s: i for i, s in enumerate(used_stops)}
    used_routes = sorted({trips[t]["route_id"] for t in kept})
    route_index = {r: i for i, r in enumerate(used_routes)}
    used_services = sorted({trips[t]["service_id"] for t in kept})
    service_index = {s: i for i, s in enumerate(used_services)}

    return {
        "format": "commuteer-bus-pack/1",
        "start": start.isoformat(),
        "days": days,
        "center": center,
        "radius_km": radius_km,
        "stops": [
            [
                s,
                stops[s]["stop_name"],
                round(float(stops[s]["stop_lat"]), 5),
                round(float(stops[s]["stop_lon"]), 5),
            ]
            for s in used_stops
        ],
        "routes": [
            [r, routes[r]["route_short_name"], agencies.get(routes[r]["agency_id"], "")]
            for r in used_routes
        ],
        "services": [services[s] for s in used_services],
        # [trip_id, route, service, headsign, [[stop, sequence, arrive_min, depart_min], ...]]
        "trips": [
            [
                tid,
                route_index[trips[tid]["route_id"]],
                service_index[trips[tid]["service_id"]],
                trips[tid]["trip_headsign"],
                [[stop_index[stop], seq, arr, dep] for seq, stop, arr, dep in c],
            ]
            for tid, c in sorted(kept.items())
        ],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="commuteer-buses")
    sub = parser.add_subparsers(dest="command", required=True)
    pk = sub.add_parser("pack", help="build a regional bus timetable pack for the app")
    pk.add_argument("--gtfs", type=Path, required=True)
    pk.add_argument("--out", type=Path, default=Path("app/src/data/bus-pack.json"))
    pk.add_argument("--lat", type=float, default=ATHLONE[0])
    pk.add_argument("--lon", type=float, default=ATHLONE[1])
    pk.add_argument("--radius-km", type=float, default=40)
    pk.add_argument("--days", type=int, default=120)
    args = parser.parse_args(argv)

    pack = build_pack(args.gtfs, (args.lat, args.lon), args.radius_km, days=args.days)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(pack, separators=(",", ":")), encoding="utf-8")
    size_kb = args.out.stat().st_size / 1024
    print(
        f"{len(pack['stops'])} stops, {len(pack['routes'])} routes, {len(pack['trips'])} trips, "
        f"{len(pack['services'])} services -> {args.out} ({size_kb:.0f} KB)"
    )


if __name__ == "__main__":
    main()
