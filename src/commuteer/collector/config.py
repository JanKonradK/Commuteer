"""Which feeds we collect and how often."""

from __future__ import annotations

from dataclasses import dataclass, field

NTA_BASE = "https://api.nationaltransport.ie/gtfsr/v2"
IRISH_RAIL_BASE = "http://api.irishrail.ie/realtime/realtime.asmx"
GTFS_STATIC_URL = "https://www.transportforireland.ie/transitData/Data/GTFS_All.zip"


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    extension: str  # file extension of the raw payload
    interval_s: int  # how often to poll it
    headers: dict[str, str] = field(default_factory=dict, hash=False)


def build_sources(nta_api_key: str | None) -> list[Source]:
    """Irish Rail needs no key. NTA feeds (Bus Eireann etc.) are skipped until a key is set."""
    sources = [
        Source("irish_rail_trains", f"{IRISH_RAIL_BASE}/getCurrentTrainsXML", "xml", 30),
    ]
    if nta_api_key:
        headers = {"x-api-key": nta_api_key}
        sources += [
            # Every 30 s so the app is at most ~30 s behind the feed (TFI Live is about the
            # same). Unchanged snapshots are not stored again, so storage does not double.
            Source("nta_trip_updates", f"{NTA_BASE}/TripUpdates", "pb", 30, headers),
            Source("nta_vehicles", f"{NTA_BASE}/Vehicles", "pb", 30, headers),
        ]
    return sources
