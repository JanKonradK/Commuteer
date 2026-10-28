"""Actual bus stop times, reconstructed from GPS positions.

TFI's live feed only *predicts* delays, and its predictions far from the start
of a route are poor. The vehicle-position feed, though, says where every bus
was, minute by minute. From that we work out when each bus really passed each
stop: the ground truth a bus delay model needs.

Method: for each trip, take its time-stamped positions in order. For each stop
(in route order), project the stop onto every segment between consecutive GPS
fixes after the previous stop's match, and take the closest approach. The
passage time is interpolated along that segment. Stops the bus never came
within MATCH_RADIUS_M of are left unknown rather than guessed.

The output has the same columns as the train stop table, so the train model's
pipeline (`commuteer.delays`) trains on buses unchanged.
"""

from __future__ import annotations

import csv
import gzip
import io
import math
import struct
import zipfile
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from commuteer.buses.gtfsrt import _int, _msg, _str, parse_fields
from commuteer.collector.keys import bronze_prefix, timestamp_from_key
from commuteer.collector.storage import Sink


def _last_sunday(year: int, month: int) -> date:
    d = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def ireland_offset_s(utc: datetime) -> int:
    """Irish summer time (UTC+1) runs from the last Sunday of March to the last Sunday of
    October, 01:00 UTC each. Computed directly: Lambda images may lack time-zone data."""
    start = datetime.combine(_last_sunday(utc.year, 3), datetime.min.time(), UTC) + timedelta(
        hours=1
    )
    end = datetime.combine(_last_sunday(utc.year, 10), datetime.min.time(), UTC) + timedelta(
        hours=1
    )
    return 3600 if start <= utc < end else 0


def ireland_time(unix: float) -> datetime:
    utc = datetime.fromtimestamp(unix, UTC)
    return (utc + timedelta(seconds=ireland_offset_s(utc))).replace(tzinfo=None)


MATCH_RADIUS_M = 300
EARTH_M = 6_371_000


@dataclass(frozen=True)
class Fix:
    trip_id: str
    start_date: str
    route_id: str
    lat: float
    lon: float
    t: int  # unix seconds (GPS timestamp)


def _float(f: dict[int, list[int | bytes]], n: int) -> float | None:
    v = f.get(n)
    if not v or not isinstance(v[0], int):
        return None
    return float(struct.unpack("<f", v[0].to_bytes(4, "little"))[0])


def decode_vehicles(feed: bytes) -> list[Fix]:
    """GTFS-Realtime VehiclePositions -> fixes (FeedEntity.vehicle = field 4)."""
    fixes: list[Fix] = []
    for raw in parse_fields(feed).get(2, []):
        assert isinstance(raw, bytes)
        vp = _msg(parse_fields(raw), 4)
        if vp is None:
            continue
        trip, pos = _msg(vp, 1) or {}, _msg(vp, 2) or {}
        lat, lon, t = _float(pos, 1), _float(pos, 2), _int(vp, 5)
        trip_id = _str(trip, 1)
        if trip_id and lat is not None and lon is not None and t:
            fixes.append(Fix(trip_id, _str(trip, 3), _str(trip, 5), lat, lon, t))
    return fixes


def load_fixes(blobs: Iterable[bytes]) -> dict[tuple[str, str], list[Fix]]:
    """All fixes per (trip_id, start_date), time-ordered, duplicates (same GPS time) removed."""
    by_trip: dict[tuple[str, str], dict[int, Fix]] = defaultdict(dict)
    for blob in blobs:
        for fix in decode_vehicles(gzip.decompress(blob)):
            by_trip[(fix.trip_id, fix.start_date)][fix.t] = fix
    return {k: [v[t] for t in sorted(v)] for k, v in by_trip.items()}


@dataclass(frozen=True)
class StopTime:
    stop_id: str
    sequence: int
    sched_s: int  # departure, seconds since the service day's midnight (can exceed 24 h)
    lat: float
    lon: float


@dataclass(frozen=True)
class TripInfo:
    route: str  # e.g. "466 > Cavan"
    stops: list[StopTime]


def _hms(text: str) -> int:
    h, m, s = text.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def load_timetable(gtfs_zip: Path, trip_ids: set[str]) -> dict[str, TripInfo]:
    """Scheduled stops for the given trips (streams stop_times, so memory stays small)."""
    with zipfile.ZipFile(gtfs_zip) as z:

        def rows(name: str) -> Iterator[dict[str, str]]:
            yield from csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig"))

        trips = {t["trip_id"]: t for t in rows("trips.txt") if t["trip_id"] in trip_ids}
        routes = {r["route_id"]: r["route_short_name"] for r in rows("routes.txt")}
        calls: dict[str, list[tuple[int, str, int]]] = defaultdict(list)
        for st in rows("stop_times.txt"):
            if st["trip_id"] in trips:
                calls[st["trip_id"]].append(
                    (int(st["stop_sequence"]), st["stop_id"], _hms(st["departure_time"]))
                )
        needed = {stop for c in calls.values() for _, stop, _ in c}
        coords = {
            s["stop_id"]: (float(s["stop_lat"]), float(s["stop_lon"]))
            for s in rows("stops.txt")
            if s["stop_id"] in needed
        }
    out = {}
    for tid, c in calls.items():
        t = trips[tid]
        stops = [
            StopTime(stop, seq, sched, *coords[stop])
            for seq, stop, sched in sorted(c)
            if stop in coords
        ]
        out[tid] = TripInfo(f"{routes.get(t['route_id'], '?')} > {t['trip_headsign']}", stops)
    return out


def _xy(lat: float, lon: float, lat0: float) -> tuple[float, float]:
    """Local flat-earth metres (fine over a few km)."""
    return (
        math.radians(lon) * EARTH_M * math.cos(math.radians(lat0)),
        math.radians(lat) * EARTH_M,
    )


def passage_times(fixes: list[Fix], stops: list[StopTime]) -> list[float | None]:
    """When the bus passed each stop (unix seconds), or None if it never came close."""
    if len(fixes) < 2:
        return [None] * len(stops)
    lat0 = fixes[0].lat
    pts = [(*_xy(f.lat, f.lon, lat0), f.t) for f in fixes]
    out: list[float | None] = []
    seg_from = 0  # stops are visited in order: never match a segment before the last match
    for stop in stops:
        sx, sy = _xy(stop.lat, stop.lon, lat0)
        best: tuple[float, float, int] | None = None  # distance, time, segment
        for i in range(seg_from, len(pts) - 1):
            (x1, y1, t1), (x2, y2, t2) = pts[i], pts[i + 1]
            dx, dy = x2 - x1, y2 - y1
            length2 = dx * dx + dy * dy
            u = (
                0.0
                if length2 == 0
                else max(0.0, min(1.0, ((sx - x1) * dx + (sy - y1) * dy) / length2))
            )
            d = math.hypot(x1 + u * dx - sx, y1 + u * dy - sy)
            if best is None or d < best[0]:
                best = (d, t1 + u * (t2 - t1), i)
            elif best[0] < MATCH_RADIUS_M and d > best[0] + 2 * MATCH_RADIUS_M:
                break  # passed the stop and moved well away: stop searching
        if best is not None and best[0] <= MATCH_RADIUS_M:
            out.append(best[1])
            seg_from = best[2]
        else:
            out.append(None)
    return out


def service_midnight(start_date: str) -> int:
    """Unix time of Irish local midnight at the start of a GTFS service date (YYYYMMDD).

    (GTFS times count from "noon minus 12 h", which equals midnight except on the
    two clock-change days; the difference there is accepted.)"""
    d = datetime(int(start_date[:4]), int(start_date[4:6]), int(start_date[6:]), tzinfo=UTC)
    return int(d.timestamp()) - ireland_offset_s(d)


def stop_events(
    fixes: dict[tuple[str, str], list[Fix]], timetable: dict[str, TripInfo]
) -> list[dict[str, object]]:
    """Rows in the train stop-table schema (see commuteer.delays.dataset)."""
    rows: list[dict[str, object]] = []
    for (trip_id, start_date), trip_fixes in fixes.items():
        info = timetable.get(trip_id)
        if info is None or not start_date:
            continue
        midnight = service_midnight(start_date)
        times = passage_times(trip_fixes, info.stops)
        last = len(info.stops) - 1
        for i, (stop, t) in enumerate(zip(info.stops, times, strict=True)):
            delay = None if t is None else (t - midnight - stop.sched_s) / 60
            rows.append(
                {
                    "service_date": date(
                        int(start_date[:4]), int(start_date[4:6]), int(start_date[6:])
                    ),
                    "train_code": trip_id,  # column names shared with the train pipeline
                    "route": info.route,
                    "station": stop.stop_id,
                    "loc_order": stop.sequence,
                    "loc_type": "O" if i == 0 else "D" if i == last else "S",
                    "sched_arr_s": float(stop.sched_s),
                    "sched_dep_s": float(stop.sched_s),
                    "arr_delay_min": delay,
                    "dep_delay_min": delay,
                }
            )
    return rows


def snapshot_keys(sink: Sink, source: str, day: date) -> list[str]:
    """Snapshots for a service day: its UTC date plus the early hours of the next."""
    keys: list[str] = []
    for d in (day, day + timedelta(days=1)):
        keys += sink.list_keys(bronze_prefix(source, d))
    return [k for k in keys if k.endswith(".gz")]


LEAD_TARGETS_MIN = (5, 10, 20, 30, 45, 60)
LEAD_TOLERANCE_MIN = 1.5
PREDICTION_SNAPSHOT_STEP = 2  # use every Nth TripUpdates snapshot (they're 1 min apart)


@dataclass(frozen=True)
class Observed:
    seq: int
    stop_id: str
    sched_s: float  # seconds since service-day midnight
    time: float  # actual unix time the bus passed
    delay_min: float


def observed_by_trip(events: list[dict[str, object]]) -> dict[str, list[Observed]]:
    out: dict[str, list[Observed]] = defaultdict(list)
    for r in events:
        delay, sd, sched = r["arr_delay_min"], r["service_date"], r["sched_arr_s"]
        if not isinstance(delay, float) or not isinstance(sd, date) or not isinstance(sched, float):
            continue
        t = service_midnight(sd.strftime("%Y%m%d")) + sched + delay * 60
        out[str(r["train_code"])].append(
            Observed(int(str(r["loc_order"])), str(r["station"]), sched, t, delay)
        )
    for v in out.values():
        v.sort(key=lambda o: o.seq)
    return out


def prediction_examples(
    snapshots: Iterable[tuple[datetime, bytes]],
    events: list[dict[str, object]],
    leads_min: tuple[float, ...] = LEAD_TARGETS_MIN,
) -> list[dict[str, object]]:
    """Live predictions paired with what actually happened: training rows for the bus model.

    For each stop a bus later reached, take TFI's prediction from the snapshot
    closest to each lead time (5, 10, ... 60 minutes before the bus got there),
    alongside what was known at that moment from GPS. Rows include:
      - "tfi": TFI's predicted delay at the stop (GTFS-RT propagation rule);
      - "gps_delay": the bus's last delay measured from GPS, and its trend;
      - "actual": the delay the bus really had there.
    """
    from commuteer.buses.gtfsrt import decode_trip_updates

    observed = observed_by_trip(events)
    best: dict[tuple[str, int, float], tuple[float, dict[str, object]]] = {}
    for taken_at, blob in snapshots:
        now = taken_at.timestamp()
        _, trips = decode_trip_updates(gzip.decompress(blob))
        for trip_id, obs in observed.items():
            tu = trips.get(trip_id)
            passed = [o for o in obs if o.time <= now]
            if tu is None or not passed:
                continue  # only buses already on the road: GPS has seen them
            last = passed[-1]
            trend = last.delay_min - passed[-2].delay_min if len(passed) > 1 else 0.0
            for target in obs:
                lead = (target.time - now) / 60
                if lead <= 0:
                    continue
                goal = min(leads_min, key=lambda g: abs(g - lead))
                gap = abs(goal - lead)
                key = (trip_id, target.seq, goal)
                if gap > LEAD_TOLERANCE_MIN or (key in best and best[key][0] <= gap):
                    continue
                tfi = None
                for u in tu.stops:  # latest update at or before this stop
                    if u.stop_sequence is None or u.stop_sequence > target.seq:
                        break
                    v = u.arrival_delay_s if u.arrival_delay_s is not None else u.departure_delay_s
                    if v is not None:
                        tfi = v / 60
                if tfi is None:
                    continue
                local = ireland_time(now)
                best[key] = (
                    gap,
                    {
                        "service_date": local.date().isoformat(),
                        "trip": trip_id,
                        "route": tu.route_id,
                        "from_stop": last.stop_id,
                        "to_stop": target.stop_id,
                        # Reporting only: these use the actual arrival, unknown when predicting.
                        "lead_target_min": goal,
                        "lead_min": lead,
                        # Known at prediction time:
                        "sched_lead_min": (target.time - target.delay_min * 60 - now) / 60,
                        "since_last_stop_min": (now - last.time) / 60,
                        "stops_ahead": target.seq - last.seq,
                        "remaining_sched_min": (target.sched_s - last.sched_s) / 60,
                        "hour": local.hour + local.minute / 60,
                        "weekday": local.weekday(),
                        "tfi": tfi,
                        "gps_delay": last.delay_min,
                        "gps_trend": trend,
                        "actual": target.delay_min,
                    },
                )
    return [row for _, row in best.values()]


EVENT_COLUMNS = [
    "service_date", "train_code", "route", "station", "loc_order", "loc_type",
    "sched_arr_s", "sched_dep_s", "arr_delay_min", "dep_delay_min",
]  # fmt: skip


def to_csv_gz(rows: list[dict[str, object]], columns: list[str]) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return gzip.compress(buf.getvalue().encode(), mtime=0)


def silver_key(kind: str, day: date) -> str:
    return f"silver/{kind}/date={day.isoformat()}/{kind}.csv.gz"


def build_day(sink: Sink, day: date, gtfs_zip: Path) -> dict[str, int]:
    """One service day of bus history: actual stop times + scored live predictions."""
    vehicle_keys = snapshot_keys(sink, "nta_vehicles", day)
    fixes = {
        k: v
        for k, v in load_fixes(sink.get(key) for key in vehicle_keys).items()
        if k[1] == day.strftime("%Y%m%d")
    }
    timetable = load_timetable(gtfs_zip, {trip for trip, _ in fixes})
    events = stop_events(fixes, timetable)
    # Every 2nd prediction snapshot (2 min apart) is enough to land within
    # LEAD_TOLERANCE_MIN of each lead target, and halves the decoding time.
    snapshots = (
        (timestamp_from_key(key), sink.get(key))
        for key in snapshot_keys(sink, "nta_trip_updates", day)[::PREDICTION_SNAPSHOT_STEP]
    )
    examples = prediction_examples(snapshots, events)
    sink.put(silver_key("bus_stop_events", day), to_csv_gz(events, EVENT_COLUMNS))
    if examples:
        sink.put(silver_key("bus_examples", day), to_csv_gz(examples, list(examples[0])))
    known = sum(1 for e in events if e["arr_delay_min"] is not None)
    return {"trips": len(fixes), "stop_times": known, "examples": len(examples)}
