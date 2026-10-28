"""Polls every source on its own interval within one run window (one Lambda invocation)."""

from __future__ import annotations

import gzip
import logging
import time
from collections import defaultdict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime

from commuteer.collector.config import Source
from commuteer.collector.http import Fetcher, FetchError
from commuteer.collector.keys import bronze_key
from commuteer.collector.storage import Sink

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PollResult:
    source: str
    key: str | None
    size: int
    error: str | None = None


def _utc_now() -> datetime:
    return datetime.now(UTC)


def poll_source(
    source: Source, sink: Sink, fetcher: Fetcher, now: Callable[[], datetime] = _utc_now
) -> PollResult:
    fetched_at = now()
    try:
        payload = fetcher(source.url, source.headers)
    except FetchError as e:
        log.warning("poll_error source=%s error=%s", source.name, e)
        return PollResult(source.name, None, 0, str(e))
    if not payload:
        log.warning("poll_error source=%s error=empty payload", source.name)
        return PollResult(source.name, None, 0, "empty payload")
    key = bronze_key(source.name, fetched_at, source.extension)
    sink.put(key, gzip.compress(payload, mtime=0))
    return PollResult(source.name, key, len(payload))


def schedule(sources: list[Source], window_s: int) -> list[tuple[int, list[Source]]]:
    """Offsets (seconds into the window) at which each source is due."""
    due: dict[int, list[Source]] = defaultdict(list)
    for source in sources:
        for offset in range(0, window_s, source.interval_s):
            due[offset].append(source)
    return sorted(due.items(), key=lambda item: item[0])


def run_window(
    sources: list[Source],
    sink: Sink,
    fetcher: Fetcher,
    window_s: int = 60,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = _utc_now,
) -> list[PollResult]:
    start = clock()
    results: list[PollResult] = []
    for offset, batch in schedule(sources, window_s):
        delay = start + offset - clock()
        if delay > 0:
            sleep(delay)
        # Fetch the batch in parallel so a slow feed doesn't skew the others' timestamps.
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            results.extend(pool.map(lambda s: poll_source(s, sink, fetcher, now), batch))
    return results
