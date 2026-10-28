"""Backfill past days of Irish Rail train movements.

Irish Rail serves scheduled and actual stop times for past dates (months back),
so we don't have to wait for the live collector to build a history. Train codes
come from the national GTFS timetable (`trip_short_name` on Irish Rail trips).
"""

from __future__ import annotations

import csv
import gzip
import io
import logging
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from commuteer.collector.http import Fetcher, FetchError
from commuteer.collector.irish_rail import NS, movements_key, movements_url
from commuteer.collector.storage import Sink

log = logging.getLogger(__name__)

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def train_codes_by_weekday(gtfs_zip: Path) -> dict[int, set[str]]:
    """Irish Rail train codes that run on each weekday (0 = Monday)."""
    with zipfile.ZipFile(gtfs_zip) as z:

        def rows(name: str) -> Iterable[dict[str, str]]:
            return csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig"))

        rail_routes = {r["route_id"] for r in rows("routes.txt") if r["agency_id"] == "IR"}
        calendar = {c["service_id"]: c for c in rows("calendar.txt")}
        codes: dict[int, set[str]] = defaultdict(set)
        for trip in rows("trips.txt"):
            service = calendar.get(trip["service_id"])
            if trip["route_id"] not in rail_routes or not service or not trip["trip_short_name"]:
                continue
            for i, day in enumerate(WEEKDAYS):
                if service[day] == "1":
                    codes[i].add(trip["trip_short_name"])
    return dict(codes)


def has_movements(xml_bytes: bytes) -> bool:
    return ET.fromstring(xml_bytes).find("ir:objTrainMovements", NS) is not None


@dataclass
class BackfillSummary:
    requested: int = 0
    stored: int = 0
    already_had: int = 0
    not_running: int = 0
    failed: int = 0


def backfill(
    sink: Sink,
    fetcher: Fetcher,
    dates: Iterable[date],
    codes_by_weekday: dict[int, set[str]],
    workers: int = 4,
) -> BackfillSummary:
    summary = BackfillSummary()
    jobs: list[tuple[date, str]] = []
    for d in dates:
        for code in sorted(codes_by_weekday.get(d.weekday(), set())):
            if sink.exists(movements_key(d, code)):
                summary.already_had += 1  # makes the backfill safe to re-run
            else:
                jobs.append((d, code))

    def run(job: tuple[date, str]) -> str:
        d, code = job
        try:
            payload = fetcher(movements_url(code, d), {})
        except FetchError as e:
            log.warning("backfill failed %s %s: %s", d, code, e)
            return "failed"
        if not has_movements(payload):
            return "not_running"  # e.g. a train that doesn't run on that date
        sink.put(movements_key(d, code), gzip.compress(payload, mtime=0))
        return "stored"

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, outcome in enumerate(pool.map(run, jobs), 1):
            summary.requested += 1
            setattr(summary, outcome, getattr(summary, outcome) + 1)
            if i % 500 == 0:
                log.info("backfill progress %d/%d %s", i, len(jobs), summary)
    return summary
