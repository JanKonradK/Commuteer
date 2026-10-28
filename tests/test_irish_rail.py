from __future__ import annotations

import gzip
from datetime import UTC, date, datetime

from commuteer.collector import irish_rail
from commuteer.collector.http import FetchError
from commuteer.collector.keys import bronze_key
from commuteer.collector.storage import LocalSink
from tests.conftest import FakeFetcher

SERVICE_DATE = date(2026, 10, 28)


def _store_snapshot(sink: LocalSink, xml: bytes, at: datetime) -> None:
    sink.put(bronze_key(irish_rail.TRAINS_SOURCE, at, "xml"), gzip.compress(xml))


def _train_xml(*trains: tuple[str, str]) -> bytes:
    rows = "".join(
        f"<objTrainPositions><TrainCode>{code} </TrainCode><TrainDate>{d}</TrainDate>"
        "</objTrainPositions>"
        for code, d in trains
    )
    return (
        '<ArrayOfObjTrainPositions xmlns="http://api.irishrail.ie/realtime/">'
        f"{rows}</ArrayOfObjTrainPositions>"
    ).encode()


def test_train_date_round_trip() -> None:
    assert irish_rail.format_train_date(date(2026, 3, 5)) == "05 Mar 2026"
    assert irish_rail.parse_train_date("28 Oct 2026") == SERVICE_DATE


def test_parse_real_snapshot(current_trains_xml: bytes) -> None:
    trains = irish_rail.parse_trains(current_trains_xml)
    assert trains, "fixture should contain trains"
    assert all(code == code.strip() and code for code, _ in trains)
    assert {d for _, d in trains} == {SERVICE_DATE}


def test_movements_url_encodes_date() -> None:
    url = irish_rail.movements_url("A701", SERVICE_DATE)
    assert url.endswith("getTrainMovementsXML?TrainId=A701&TrainDate=28+Oct+2026")


def test_trains_seen_spans_utc_midnight_and_filters_by_service_date(sink: LocalSink) -> None:
    _store_snapshot(
        sink, _train_xml(("A701", "28 Oct 2026")), datetime(2026, 10, 28, 6, tzinfo=UTC)
    )
    # Late train after UTC midnight still belongs to the 28th; a new day's train does not.
    _store_snapshot(
        sink,
        _train_xml(("E999", "28 Oct 2026"), ("A701", "29 Oct 2026")),
        datetime(2026, 10, 29, 0, 5, tzinfo=UTC),
    )
    assert irish_rail.trains_seen(sink, SERVICE_DATE, sample_every=1) == {"A701", "E999"}


def test_collect_movements_stores_skips_and_reports_failures(
    sink: LocalSink, movements_xml: bytes
) -> None:
    _store_snapshot(
        sink,
        _train_xml(("A701", "28 Oct 2026"), ("B100", "28 Oct 2026"), ("C200", "28 Oct 2026")),
        datetime(2026, 10, 28, 9, tzinfo=UTC),
    )
    sink.put(irish_rail.movements_key(SERVICE_DATE, "C200"), b"already here")
    fetcher = FakeFetcher({"TrainId=A701": movements_xml, "TrainId=B100": FetchError("down")})

    summary = irish_rail.collect_movements(sink, fetcher, SERVICE_DATE, sleep=lambda _: None)

    assert (summary.trains, summary.stored, summary.skipped) == (3, 1, 1)
    assert summary.failed == ["B100"]
    stored = sink.get(irish_rail.movements_key(SERVICE_DATE, "A701"))
    assert gzip.decompress(stored) == movements_xml
