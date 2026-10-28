from __future__ import annotations

import gzip
import zipfile
from datetime import date
from pathlib import Path

import pytest

from commuteer.buses import gtfsrt
from commuteer.buses.pack import active_dates, build_pack, gtfs_minutes

FIXTURE = Path(__file__).parent / "fixtures" / "nta_trip_updates.pb.gz"


def test_decoder_matches_official_bindings() -> None:
    rt = pytest.importorskip("google.transit.gtfs_realtime_pb2")
    raw = gzip.decompress(FIXTURE.read_bytes())
    official = rt.FeedMessage()
    official.ParseFromString(raw)

    timestamp, trips = gtfsrt.decode_trip_updates(raw)

    assert timestamp == official.header.timestamp
    # Extra (ADDED) trips have no trip_id, so they can't be matched to a timetable: skipped.
    expected = [
        e.trip_update
        for e in official.entity
        if e.HasField("trip_update") and e.trip_update.trip.trip_id
    ]
    assert len(trips) == len(expected) > 1000
    for tu in expected:
        got = trips[tu.trip.trip_id]
        assert got.route_id == tu.trip.route_id
        assert got.start_date == tu.trip.start_date
        assert len(got.stops) == len(tu.stop_time_update)
        for mine, theirs in zip(got.stops, tu.stop_time_update, strict=True):
            assert mine.stop_id == theirs.stop_id
            assert mine.stop_sequence == (
                theirs.stop_sequence if theirs.HasField("stop_sequence") else None
            )
            if theirs.HasField("arrival") and theirs.arrival.HasField("delay"):
                assert mine.arrival_delay_s == theirs.arrival.delay
            if theirs.HasField("departure") and theirs.departure.HasField("delay"):
                assert mine.departure_delay_s == theirs.departure.delay


def test_decoder_handles_negative_delays() -> None:
    _, trips = gtfsrt.decode_trip_updates(gzip.decompress(FIXTURE.read_bytes()))
    delays = [s.arrival_delay_s for t in trips.values() for s in t.stops if s.arrival_delay_s]
    assert min(delays) < 0 < max(delays)  # early and late buses both decode correctly


def test_gtfs_minutes_keeps_times_after_midnight() -> None:
    assert gtfs_minutes("07:30:00") == 450
    assert gtfs_minutes("25:10:45") == 25 * 60 + 11  # nearest minute


def test_active_dates_applies_calendar_and_exceptions() -> None:
    weekdays_only = {
        "monday": "1", "tuesday": "1", "wednesday": "1", "thursday": "1", "friday": "1",
        "saturday": "0", "sunday": "0", "start_date": "20261026", "end_date": "20261231",
    }  # fmt: skip
    # Mon 26 Oct .. Sun 1 Nov; Tue removed, Sat added by exceptions.
    exceptions = {date(2026, 10, 27): "2", date(2026, 10, 31): "1"}
    assert active_dates(weekdays_only, exceptions, date(2026, 10, 26), 7) == "1011110"
    assert active_dates(None, {date(2026, 10, 28): "1"}, date(2026, 10, 26), 4) == "0010"


def _write_gtfs(path: Path) -> None:
    files = {
        "agency.txt": "agency_id,agency_name\nBE,Bus Eireann\n",
        "routes.txt": (
            "route_id,agency_id,route_short_name,route_type\nR466,BE,466,3\nRAIL,BE,X,2\n"
        ),
        "stops.txt": (
            "stop_id,stop_name,stop_lat,stop_lon\n"
            "ATH,Athlone Stn,53.4268,-7.9352\n"
            "BAL,Ballymahon,53.5653,-7.7664\n"
            "CAV,Cavan Bus Stn,53.9904,-7.3636\n"  # ~75 km away: outside a 40 km radius
        ),
        "trips.txt": (
            "route_id,service_id,trip_id,trip_headsign\n"
            "R466,WK,T1,Cavan\nR466,NEVER,T2,Cavan\nRAIL,WK,T3,Train\n"
        ),
        "stop_times.txt": (
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "T1,07:30:00,07:30:00,ATH,1\nT1,07:56:00,07:56:00,BAL,4\nT1,09:32:00,09:32:00,CAV,13\n"
            "T2,10:00:00,10:00:00,ATH,1\nT2,10:26:00,10:26:00,BAL,4\n"
            "T3,10:00:00,10:00:00,ATH,1\nT3,10:26:00,10:26:00,BAL,2\n"
        ),
        "calendar.txt": (
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "WK,1,1,1,1,1,0,0,20260101,20271231\nNEVER,0,0,0,0,0,0,0,20260101,20271231\n"
        ),
        "calendar_dates.txt": "service_id,date,exception_type\n",
    }
    with zipfile.ZipFile(path, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)


def test_build_pack_keeps_regional_bus_journeys(tmp_path: Path) -> None:
    gtfs = tmp_path / "gtfs.zip"
    _write_gtfs(gtfs)
    pack = build_pack(gtfs, radius_km=40, start=date(2026, 10, 26), days=7)

    assert [s[1] for s in pack["stops"]] == ["Athlone Stn", "Ballymahon"]  # Cavan is too far
    assert [t[0] for t in pack["trips"]] == ["T1"]  # T2 never runs; T3 is a train
    _, route, service, headsign, calls = pack["trips"][0]
    assert pack["routes"][route][1] == "466" and headsign == "Cavan"
    assert pack["services"][service] == "1111100"
    assert calls == [[0, 1, 450, 450], [1, 4, 476, 476]]
