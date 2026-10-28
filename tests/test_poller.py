from __future__ import annotations

import gzip
from datetime import UTC, datetime

from commuteer.collector.config import Source, build_sources
from commuteer.collector.http import FetchError
from commuteer.collector.keys import bronze_key, timestamp_from_key
from commuteer.collector.poller import poll_source, run_window, schedule
from commuteer.collector.storage import LocalSink
from tests.conftest import FakeFetcher

NOW = datetime(2026, 10, 28, 7, 15, 30, tzinfo=UTC)
RAIL = Source("rail", "https://rail.example/trains", "xml", 30)
BUS = Source("bus", "https://bus.example/updates", "pb", 60, {"x-api-key": "k"})


def test_nta_sources_only_added_with_key() -> None:
    assert [s.name for s in build_sources(None)] == ["irish_rail_trains"]
    with_key = build_sources("secret")
    assert {s.name for s in with_key} == {"irish_rail_trains", "nta_trip_updates", "nta_vehicles"}
    assert all(s.headers == {"x-api-key": "secret"} for s in with_key if s.name.startswith("nta"))


def test_bronze_key_is_partitioned_and_reversible() -> None:
    key = bronze_key("rail", NOW, "xml")
    assert key == "bronze/rail/date=2026-10-28/hour=07/20261028T071530Z.xml.gz"
    assert timestamp_from_key(key) == NOW


def test_poll_source_stores_gzipped_payload(sink: LocalSink) -> None:
    fetcher = FakeFetcher({"rail.example": b"<xml/>"})
    result = poll_source(RAIL, sink, fetcher, now=lambda: NOW)
    assert result.error is None and result.key is not None
    assert gzip.decompress(sink.get(result.key)) == b"<xml/>"


def test_poll_source_passes_headers(sink: LocalSink) -> None:
    fetcher = FakeFetcher({"bus.example": b"\x08\x01"})
    poll_source(BUS, sink, fetcher, now=lambda: NOW)
    assert fetcher.calls[0][1] == {"x-api-key": "k"}


def test_poll_source_reports_errors_without_raising(sink: LocalSink) -> None:
    fetcher = FakeFetcher({"rail.example": FetchError("boom")})
    result = poll_source(RAIL, sink, fetcher, now=lambda: NOW)
    assert result.key is None and result.error == "boom"
    assert sink.list_keys("bronze/") == []


def test_poll_source_rejects_empty_payload(sink: LocalSink) -> None:
    result = poll_source(RAIL, sink, FakeFetcher({"rail.example": b""}), now=lambda: NOW)
    assert result.error == "empty payload"


def test_schedule_polls_each_source_on_its_interval() -> None:
    assert schedule([RAIL, BUS], 60) == [(0, [RAIL, BUS]), (30, [RAIL])]


def test_run_window_waits_between_offsets(sink: LocalSink) -> None:
    clock = [0.0]
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        clock[0] += seconds

    fetcher = FakeFetcher({"rail.example": b"r", "bus.example": b"b"})
    results = run_window(
        [RAIL, BUS],
        sink,
        fetcher,
        window_s=60,
        clock=lambda: clock[0],
        sleep=sleep,
        now=lambda: NOW,
    )
    assert slept == [30.0]
    assert sorted(r.source for r in results) == ["bus", "rail", "rail"]
