"""Irish Rail publishes scheduled *and actual* times for every stop of every train.

That is exact ground truth for train delays. Each night we collect the full
stop-by-stop record for every train that ran the previous day.
"""

from __future__ import annotations

import gzip
import logging
import time
import urllib.parse
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta

from commuteer.collector.config import IRISH_RAIL_BASE
from commuteer.collector.http import Fetcher, FetchError
from commuteer.collector.keys import bronze_prefix
from commuteer.collector.storage import Sink

log = logging.getLogger(__name__)

NS = {"ir": "http://api.irishrail.ie/realtime/"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
TRAINS_SOURCE = "irish_rail_trains"
MOVEMENTS_SOURCE = "irish_rail_movements"


def format_train_date(d: date) -> str:
    # Built by hand: strftime("%b") depends on the machine's locale.
    return f"{d.day:02d} {MONTHS[d.month - 1]} {d.year}"


def parse_train_date(text: str) -> date:
    day, month, year = text.split()
    return date(int(year), MONTHS.index(month) + 1, int(day))


def parse_trains(xml_bytes: bytes) -> set[tuple[str, date]]:
    """(train code, service date) pairs from a getCurrentTrainsXML snapshot."""
    root = ET.fromstring(xml_bytes)
    trains: set[tuple[str, date]] = set()
    for el in root.iterfind("ir:objTrainPositions", NS):
        code = (el.findtext("ir:TrainCode", "", NS) or "").strip()
        raw_date = (el.findtext("ir:TrainDate", "", NS) or "").strip()
        if code and raw_date:
            trains.add((code, parse_train_date(raw_date)))
    return trains


def movements_url(code: str, service_date: date) -> str:
    query = urllib.parse.urlencode({"TrainId": code, "TrainDate": format_train_date(service_date)})
    return f"{IRISH_RAIL_BASE}/getTrainMovementsXML?{query}"


def movements_key(service_date: date, code: str) -> str:
    return f"{bronze_prefix(MOVEMENTS_SOURCE, service_date)}{code}.xml.gz"


def trains_seen(sink: Sink, service_date: date, sample_every: int = 10) -> set[str]:
    """Train codes that ran on `service_date`, read from our own position snapshots.

    Snapshots are partitioned by UTC date while service dates are Irish local time,
    so we also scan the following UTC day and filter on each train's TrainDate.
    Sampling every Nth snapshot (~5 min apart) is plenty: every train is listed for
    far longer than that.
    """
    codes: set[str] = set()
    for day in (service_date, service_date + timedelta(days=1)):
        keys = sink.list_keys(bronze_prefix(TRAINS_SOURCE, day))
        for key in keys[::sample_every]:
            try:
                trains = parse_trains(gzip.decompress(sink.get(key)))
            except (ET.ParseError, OSError) as e:
                log.warning("skipping unreadable snapshot %s: %s", key, e)
                continue
            codes.update(code for code, d in trains if d == service_date)
    return codes


@dataclass(frozen=True)
class MovementsSummary:
    service_date: date
    trains: int
    stored: int
    skipped: int
    failed: list[str] = field(default_factory=list)


def collect_movements(
    sink: Sink,
    fetcher: Fetcher,
    service_date: date,
    pause_s: float = 0.2,
    sleep: Callable[[float], None] = time.sleep,
) -> MovementsSummary:
    codes = sorted(trains_seen(sink, service_date))
    stored = skipped = 0
    failed: list[str] = []
    for code in codes:
        key = movements_key(service_date, code)
        if sink.exists(key):
            skipped += 1
            continue
        try:
            payload = fetcher(movements_url(code, service_date), {})
        except FetchError as e:
            log.warning("movements_error train=%s error=%s", code, e)
            failed.append(code)
            continue
        sink.put(key, gzip.compress(payload, mtime=0))
        stored += 1
        sleep(pause_s)  # be polite to a free public API
    return MovementsSummary(service_date, len(codes), stored, skipped, failed)
