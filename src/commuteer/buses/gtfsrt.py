"""Minimal GTFS-Realtime TripUpdates decoder (standard library only).

Decodes just the fields Commuteer needs from the protobuf wire format, so the
Lambda stays dependency-free. Field numbers follow gtfs-realtime.proto;
tests/test_gtfsrt.py checks the output against Google's official bindings.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

VARINT, I64, LEN, I32 = 0, 1, 2, 5

Fields = dict[int, list[int | bytes]]


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, pos
        shift += 7


def parse_fields(buf: bytes) -> Fields:
    """One protobuf message -> {field number: [values]} (nested messages left as bytes)."""
    out: Fields = defaultdict(list)
    pos = 0
    while pos < len(buf):
        key, pos = _varint(buf, pos)
        number, wire = key >> 3, key & 7
        if wire == VARINT:
            value, pos = _varint(buf, pos)
            out[number].append(value)
        elif wire == LEN:
            length, pos = _varint(buf, pos)
            out[number].append(buf[pos : pos + length])
            pos += length
        elif wire == I64:
            out[number].append(int.from_bytes(buf[pos : pos + 8], "little"))
            pos += 8
        elif wire == I32:
            out[number].append(int.from_bytes(buf[pos : pos + 4], "little"))
            pos += 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
    return out


def _int32(v: int) -> int:
    """int32 fields are sent as 64-bit two's complement varints when negative."""
    return v - (1 << 64) if v >= 1 << 63 else v


def _str(f: Fields, n: int) -> str:
    v = f.get(n)
    return v[0].decode() if v and isinstance(v[0], bytes) else ""


def _int(f: Fields, n: int) -> int | None:
    v = f.get(n)
    return _int32(v[0]) if v and isinstance(v[0], int) else None


def _msg(f: Fields, n: int) -> Fields | None:
    v = f.get(n)
    return parse_fields(v[0]) if v and isinstance(v[0], bytes) else None


@dataclass(frozen=True)
class StopDelay:
    stop_sequence: int | None
    stop_id: str
    arrival_delay_s: int | None
    departure_delay_s: int | None
    skipped: bool


@dataclass
class TripDelay:
    trip_id: str
    route_id: str
    start_date: str
    canceled: bool
    stops: list[StopDelay] = field(default_factory=list)


CANCELED = 3  # TripDescriptor.ScheduleRelationship
SKIPPED = 1  # StopTimeUpdate.ScheduleRelationship


def decode_trip_updates(feed: bytes) -> tuple[int, dict[str, TripDelay]]:
    """Returns (feed timestamp, {trip_id: TripDelay})."""
    msg = parse_fields(feed)
    header = _msg(msg, 1) or {}
    timestamp = _int(header, 3) or 0
    trips: dict[str, TripDelay] = {}
    for raw_entity in msg.get(2, []):
        assert isinstance(raw_entity, bytes)
        update = _msg(parse_fields(raw_entity), 3)
        if update is None:
            continue
        trip = _msg(update, 1) or {}
        trip_id = _str(trip, 1)
        if not trip_id:
            continue
        delay = TripDelay(
            trip_id=trip_id,
            route_id=_str(trip, 5),
            start_date=_str(trip, 3),
            canceled=_int(trip, 4) == CANCELED,
        )
        for raw_stu in update.get(2, []):
            assert isinstance(raw_stu, bytes)
            stu = parse_fields(raw_stu)
            arrival, departure = _msg(stu, 2), _msg(stu, 3)
            delay.stops.append(
                StopDelay(
                    stop_sequence=_int(stu, 1),
                    stop_id=_str(stu, 4),
                    arrival_delay_s=_int(arrival, 1) if arrival else None,
                    departure_delay_s=_int(departure, 1) if departure else None,
                    skipped=_int(stu, 5) == SKIPPED,
                )
            )
        trips[trip_id] = delay
    return timestamp, trips
