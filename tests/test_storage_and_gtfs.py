from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from commuteer.collector import gtfs_static
from commuteer.collector.storage import LocalSink, S3Sink, Sink


@pytest.fixture
def s3_sink() -> Iterator[S3Sink]:
    with mock_aws():
        client = boto3.client("s3", region_name="eu-north-1")
        client.create_bucket(
            Bucket="test-bucket", CreateBucketConfiguration={"LocationConstraint": "eu-north-1"}
        )
        yield S3Sink("test-bucket", client)


@pytest.fixture(params=["local", "s3"])
def any_sink(request: pytest.FixtureRequest, sink: LocalSink, s3_sink: S3Sink) -> Sink:
    return sink if request.param == "local" else s3_sink


def test_sink_round_trip(any_sink: Sink, tmp_path: Path) -> None:
    assert not any_sink.exists("a/b.txt")
    any_sink.put("a/b.txt", b"hello")
    any_sink.put("a/c/d.txt", b"world")
    file = tmp_path / "f.bin"
    file.write_bytes(b"file")
    any_sink.put_file("z/f.bin", file)

    assert any_sink.exists("a/b.txt")
    assert any_sink.get("a/b.txt") == b"hello"
    assert any_sink.list_keys("a/") == ["a/b.txt", "a/c/d.txt"]
    assert any_sink.list_keys("missing/") == []
    assert any_sink.get("z/f.bin") == b"file"


def _downloader(content: bytes) -> gtfs_static.Downloader:
    def download(url: str, dest: Path) -> None:
        dest.write_bytes(content)

    return download


def test_gtfs_snapshot_only_stores_when_timetable_changes(any_sink: Sink, tmp_path: Path) -> None:
    day1, day2, day3 = date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 3)

    first = gtfs_static.snapshot(any_sink, day1, downloader=_downloader(b"v1"), tmp_dir=tmp_path)
    same = gtfs_static.snapshot(any_sink, day2, downloader=_downloader(b"v1"), tmp_dir=tmp_path)
    second = gtfs_static.snapshot(any_sink, day3, downloader=_downloader(b"v2"), tmp_dir=tmp_path)

    assert first is not None and first.startswith("bronze/gtfs_static/date=2026-10-01/")
    assert same is None
    assert second is not None and second.startswith("bronze/gtfs_static/date=2026-10-03/")
    assert any_sink.get(second) == b"v2"
