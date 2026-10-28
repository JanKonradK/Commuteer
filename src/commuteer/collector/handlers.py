"""AWS Lambda entry points. Each is triggered by an EventBridge Scheduler schedule."""

from __future__ import annotations

import gzip
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any

from commuteer.buses.gtfsrt import TripDelay, decode_trip_updates
from commuteer.collector import gtfs_static, irish_rail
from commuteer.collector.config import build_sources
from commuteer.collector.http import fetch
from commuteer.collector.keys import latest_key
from commuteer.collector.poller import run_window
from commuteer.collector.storage import S3Sink

logging.getLogger().setLevel(logging.INFO)
log = logging.getLogger(__name__)

PLACEHOLDER_KEY = "CHANGE_ME"


def _emit(event: str, **fields: Any) -> None:
    """One JSON line per event, so CloudWatch metric filters can match on fields."""
    print(json.dumps({"event": event, **fields}, default=str))


@cache
def _sink() -> S3Sink:
    return S3Sink(os.environ["DATA_BUCKET"])


# Warm Lambda containers live for hours, so the key is re-read every few minutes.
# That way adding or rotating the key takes effect without a redeploy.
KEY_TTL_S = 300
_key_cache: dict[str, Any] = {}


def _clear_key_cache() -> None:
    _key_cache.clear()


def _nta_api_key(clock: Callable[[], float] = time.monotonic) -> str | None:
    if key := os.environ.get("NTA_API_KEY"):
        return key
    param = os.environ.get("NTA_API_KEY_PARAM")
    if not param:
        return None
    if _key_cache and clock() - _key_cache["fetched_at"] < KEY_TTL_S:
        cached: str | None = _key_cache["value"]
        return cached
    import boto3

    value = boto3.client("ssm").get_parameter(Name=param, WithDecryption=True)
    raw = value["Parameter"].get("Value", "")
    key = None if raw in ("", PLACEHOLDER_KEY) else raw
    _key_cache.update(value=key, fetched_at=clock())
    return key


def poll(event: dict[str, Any], context: Any) -> dict[str, Any]:
    sources = build_sources(_nta_api_key())
    window_s = int(os.environ.get("POLL_WINDOW_S", "60"))
    results = run_window(sources, _sink(), fetch, window_s=window_s)
    for r in results:
        if r.error:
            _emit("poll_error", source=r.source, error=r.error)
    ok = sum(1 for r in results if r.error is None)
    _emit("poll_done", ok=ok, failed=len(results) - ok, sources=[s.name for s in sources])
    if ok == 0:
        # Fail the invocation so the Lambda Errors alarm fires.
        raise RuntimeError("every poll in this window failed")
    return {"ok": ok, "failed": len(results) - ok}


def _yesterday_in_ireland() -> date:
    # The job runs at 02:30 Irish time, when the UTC date always equals the Irish date
    # (Ireland is UTC+0 or UTC+1). Avoids zoneinfo, as Lambda images may lack tzdata.
    return datetime.now(UTC).date() - timedelta(days=1)


def rail_movements(event: dict[str, Any], context: Any) -> dict[str, Any]:
    service_date = date.fromisoformat(event["date"]) if "date" in event else _yesterday_in_ireland()
    summary = irish_rail.collect_movements(_sink(), fetch, service_date)
    _emit("rail_movements_done", **asdict(summary))
    return asdict(summary) | {"service_date": service_date.isoformat()}


def gtfs_snapshot(event: dict[str, Any], context: Any) -> dict[str, Any]:
    key = gtfs_static.snapshot(_sink(), datetime.now(UTC).date(), tmp_dir=Path("/tmp"))
    _emit("gtfs_snapshot_done", changed=key is not None, key=key)
    return {"changed": key is not None, "key": key}


# --- Live bus delays (Lambda function URL) -----------------------------------------------

MAX_TRIPS_PER_REQUEST = 50
FEED_CACHE_S = 20  # the collector refreshes the feed every 60 s
_feed_cache: dict[str, Any] = {}


def _latest_trip_updates(
    clock: Callable[[], float] = time.monotonic,
) -> tuple[int, dict[str, TripDelay]]:
    """Decode the newest bus feed snapshot, reusing it briefly across requests."""
    if _feed_cache and clock() - _feed_cache["at"] < FEED_CACHE_S:
        cached: tuple[int, dict[str, TripDelay]] = _feed_cache["feed"]
        return cached
    raw = gzip.decompress(_sink().get(latest_key("nta_trip_updates", "pb")))
    feed = decode_trip_updates(raw)
    _feed_cache.update(at=clock(), feed=feed)
    return feed


def _response(status: int, body: dict[str, Any], max_age: int = 0) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "cache-control": f"public, max-age={max_age}" if max_age else "no-store",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }


def bus_live(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """GET ?trips=ID1,ID2 -> live delays for those trips (seconds; negative = early).

    Reads the snapshot the poller already saved, so phones never call the
    Transport for Ireland API (or need its key) themselves.
    """
    params = event.get("queryStringParameters") or {}
    wanted = [t for t in (params.get("trips") or "").split(",") if t][:MAX_TRIPS_PER_REQUEST]
    if not wanted:
        return _response(400, {"error": "pass ?trips=TRIP_ID,..."})
    try:
        timestamp, trips = _latest_trip_updates()
    except Exception as e:  # missing or unreadable snapshot: report it, don't crash
        _emit("bus_live_error", error=str(e))
        return _response(503, {"error": "live bus data unavailable"})
    found = {
        t: {
            "date": trips[t].start_date,
            "canceled": trips[t].canceled,
            # [stop_sequence, stop_id, arrival_delay_s, departure_delay_s, skipped]
            "stops": [
                [s.stop_sequence, s.stop_id, s.arrival_delay_s, s.departure_delay_s, s.skipped]
                for s in trips[t].stops
            ],
        }
        for t in wanted
        if t in trips
    }
    return _response(200, {"feed_timestamp": timestamp, "trips": found}, max_age=15)


# --- Nightly bus history (actual stop times from GPS + scored live predictions) -----------


def bus_history(event: dict[str, Any], context: Any) -> dict[str, Any]:
    from commuteer.buses.history import build_day

    day = (
        date.fromisoformat(event["date"])
        if "date" in event
        else datetime.now(UTC).date() - timedelta(days=1)
    )
    sink = _sink()
    zips = [k for k in sink.list_keys("bronze/gtfs_static/") if k.endswith(".zip")]
    if not zips:
        raise RuntimeError("no timetable snapshot in S3 yet")
    gtfs = Path("/tmp/gtfs.zip")
    gtfs.write_bytes(sink.get(sorted(zips)[-1]))  # keys sort by date: newest last
    stats = build_day(sink, day, gtfs)
    _emit("bus_history_done", date=day.isoformat(), **stats)
    return {"date": day.isoformat(), **stats}
