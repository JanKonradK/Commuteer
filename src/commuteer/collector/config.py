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
            # NTA asks for fair use; once a minute matches how often the feed refreshes.
            Source("nta_trip_updates", f"{NTA_BASE}/TripUpdates", "pb", 60, headers),
            Source("nta_vehicles", f"{NTA_BASE}/Vehicles", "pb", 60, headers),
        ]
    return sources
