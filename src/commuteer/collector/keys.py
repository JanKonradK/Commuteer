"""Object key layout. Hive-style partitions so Athena/DuckDB can prune by date."""

from __future__ import annotations

from datetime import UTC, date, datetime


def bronze_prefix(source: str, day: date) -> str:
    return f"bronze/{source}/date={day.isoformat()}/"


def bronze_key(source: str, fetched_at: datetime, extension: str) -> str:
    ts = fetched_at.astimezone(UTC)
    return f"{bronze_prefix(source, ts.date())}hour={ts:%H}/{ts:%Y%m%dT%H%M%S}Z.{extension}.gz"


def timestamp_from_key(key: str) -> datetime:
    stamp = key.rsplit("/", 1)[-1].split(".", 1)[0]
    return datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
