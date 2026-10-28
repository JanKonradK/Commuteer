"""Daily snapshot of the national GTFS timetable, stored only when it changes.

Realtime feeds refer to trips and stops by ID, so we keep every timetable
version in order to join historical realtime data to the right schedule.
"""

from __future__ import annotations

import hashlib
import tempfile
from collections.abc import Callable
from datetime import date
from pathlib import Path

from commuteer.collector.config import GTFS_STATIC_URL
from commuteer.collector.http import download
from commuteer.collector.storage import Sink

SOURCE = "gtfs_static"
LATEST_KEY = f"bronze/{SOURCE}/LATEST_SHA256"

Downloader = Callable[[str, Path], None]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot(
    sink: Sink,
    today: date,
    url: str = GTFS_STATIC_URL,
    downloader: Downloader = download,
    tmp_dir: Path | None = None,
) -> str | None:
    """Returns the new object key, or None if the timetable hasn't changed."""
    with tempfile.TemporaryDirectory(dir=tmp_dir) as tmp:
        path = Path(tmp) / "gtfs.zip"
        downloader(url, path)
        digest = _sha256(path)
        if sink.exists(LATEST_KEY) and sink.get(LATEST_KEY).decode().strip() == digest:
            return None
        key = f"bronze/{SOURCE}/date={today.isoformat()}/GTFS_All_{digest[:12]}.zip"
        sink.put_file(key, path)
        sink.put(LATEST_KEY, digest.encode())
        return key
