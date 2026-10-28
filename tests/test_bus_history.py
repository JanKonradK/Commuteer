from __future__ import annotations

import gzip
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from commuteer.buses import history as h

FIXTURES = Path(__file__).parent / "fixtures"


def test_vehicle_decoder_matches_official_bindings() -> None:
    rt = pytest.importorskip("google.transit.gtfs_realtime_pb2")
    raw = gzip.decompress((FIXTURES / "nta_vehicles.pb.gz").read_bytes())
    official = rt.FeedMessage()
    official.ParseFromString(raw)
    expected = [
        e.vehicle for e in official.entity if e.HasField("vehicle") and e.vehicle.trip.trip_id
    ]

    fixes = h.decode_vehicles(raw)

    assert len(fixes) == len(expected) > 1000
    for mine, theirs in zip(fixes, expected, strict=True):
        assert mine.trip_id == theirs.trip.trip_id
        assert mine.t == theirs.timestamp
        assert mine.lat == pytest.approx(theirs.position.latitude, abs=1e-5)
        assert mine.lon == pytest.approx(theirs.position.longitude, abs=1e-5)


def _stop(seq: int, lat: float, lon: float = -7.9) -> h.StopTime:
    return h.StopTime(f"S{seq}", seq, 0, lat, lon)


def _fix(t: int, lat: float, lon: float = -7.9) -> h.Fix:
    return h.Fix("T", "20261028", "R", lat, lon, t)


def test_passage_times_interpolate_between_gps_fixes() -> None:
    # Bus heads north at ~0.001 deg latitude (~111 m) per 10 s, one GPS fix a minute.
    fixes = [_fix(t, 53.400 + 0.0001 * t) for t in range(0, 601, 60)]
    stops = [_stop(1, 53.403), _stop(2, 53.4255), _stop(3, 53.459)]
    times = h.passage_times(fixes, stops)
    assert times[0] == pytest.approx(30, abs=1)  # halfway between the 0 s and 60 s fixes
    assert times[1] == pytest.approx(255, abs=1)
    assert times[2] == pytest.approx(590, abs=1)


def test_passage_times_leave_unvisited_stops_unknown() -> None:
    fixes = [_fix(t, 53.400 + 0.0001 * t) for t in range(0, 301, 60)]
    far_away = _stop(1, 53.41, lon=-7.7)  # ~13 km east of the route
    assert h.passage_times(fixes, [far_away]) == [None]


def test_passage_times_respect_stop_order_on_out_and_back_routes() -> None:
    # Out to the north and back past the same point: the 2nd visit must match the 2nd stop.
    out = [_fix(t, 53.400 + 0.0001 * t) for t in range(0, 301, 60)]
    back = [_fix(300 + t, 53.430 - 0.0001 * t) for t in range(60, 301, 60)]
    stops = [_stop(1, 53.403), _stop(2, 53.430), _stop(3, 53.403)]
    times = h.passage_times(out + back, stops)
    assert times[0] == pytest.approx(30, abs=1)
    assert times[2] == pytest.approx(570, abs=1)


def test_irish_summer_time() -> None:
    assert h.ireland_offset_s(datetime(2026, 7, 1, tzinfo=UTC)) == 3600
    assert h.ireland_offset_s(datetime(2026, 12, 1, tzinfo=UTC)) == 0
    # Clocks went back at 01:00 UTC on Sunday 25 October 2026.
    assert h.ireland_offset_s(datetime(2026, 10, 25, 0, 59, tzinfo=UTC)) == 3600
    assert h.ireland_offset_s(datetime(2026, 10, 25, 1, 0, tzinfo=UTC)) == 0
    assert h.service_midnight("20261028") == int(datetime(2026, 10, 28, tzinfo=UTC).timestamp())


def test_examples_only_use_information_known_when_predicting() -> None:
    """Regression test for a leak: model inputs must not depend on the actual arrival."""
    from commuteer.buses.train import CATEGORICAL, NUMERIC

    assert "lead_min" not in NUMERIC and "lead_target_min" not in NUMERIC
    assert "actual" not in NUMERIC + CATEGORICAL


def test_stop_events_use_the_train_table_schema() -> None:
    fixes = {("T", "20261028"): [_fix(t, 53.400 + 0.0001 * t) for t in range(0, 601, 60)]}
    midnight = h.service_midnight("20261028")
    timetable = {
        "T": h.TripInfo(
            "466 > Cavan",
            [h.StopTime("A", 1, 0, 53.403, -7.9), h.StopTime("B", 2, 0, 53.4255, -7.9)],
        )
    }
    # Shift the fixes to 07:30 local time and schedule both stops then.
    start = 7 * 3600 + 30 * 60
    fixes = {
        k: [
            h.Fix(f.trip_id, f.start_date, f.route_id, f.lat, f.lon, midnight + start + f.t)
            for f in v
        ]
        for k, v in fixes.items()
    }
    timetable["T"] = h.TripInfo(
        "466 > Cavan",
        [h.StopTime("A", 1, start, 53.403, -7.9), h.StopTime("B", 2, start + 120, 53.4255, -7.9)],
    )
    rows = h.stop_events(fixes, timetable)
    assert [r["loc_type"] for r in rows] == ["O", "D"]
    assert rows[0]["service_date"] == date(2026, 10, 28)
    assert rows[0]["arr_delay_min"] == pytest.approx(0.5, abs=0.02)  # passed 30 s after 07:30
    assert rows[1]["arr_delay_min"] == pytest.approx(255 / 60 - 2, abs=0.02)
