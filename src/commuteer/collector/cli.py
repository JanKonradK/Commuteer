"""Run the collector locally: `uv run commuteer-collect poll --loop`."""

from __future__ import annotations

import argparse
import logging
import os
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from commuteer.collector import backfill, gtfs_static, irish_rail
from commuteer.collector.config import build_sources
from commuteer.collector.http import fetch
from commuteer.collector.poller import run_window
from commuteer.collector.storage import LocalSink, S3Sink, Sink


def _sink(args: argparse.Namespace) -> Sink:
    return S3Sink(args.bucket) if args.bucket else LocalSink(Path(args.out))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="commuteer-collect")
    parser.add_argument("--out", default="data", help="local output folder (default: data)")
    parser.add_argument("--bucket", help="write to this S3 bucket instead of --out")
    sub = parser.add_subparsers(dest="command", required=True)

    poll = sub.add_parser("poll", help="poll realtime feeds")
    poll.add_argument("--window", type=int, default=60, help="seconds per run window")
    poll.add_argument("--loop", action="store_true", help="keep polling until Ctrl+C")

    rail = sub.add_parser("rail-movements", help="fetch stop-by-stop times for a day's trains")
    rail.add_argument("--date", type=date.fromisoformat, help="service date (default: yesterday)")

    sub.add_parser("gtfs-static", help="snapshot the national timetable if it changed")

    bf = sub.add_parser("backfill", help="fetch past days of train movements")
    bf.add_argument("--days", type=int, default=42, help="how many past days (default: 42)")
    bf.add_argument("--gtfs", type=Path, required=True, help="path to GTFS_All.zip")
    bf.add_argument("--workers", type=int, default=4)

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sink = _sink(args)

    if args.command == "poll":
        sources = build_sources(os.environ.get("NTA_API_KEY"))
        print(f"Polling: {', '.join(s.name for s in sources)}")
        while True:
            for r in run_window(sources, sink, fetch, window_s=args.window):
                status = f"error: {r.error}" if r.error else f"{r.size:,} bytes -> {r.key}"
                print(f"{r.source}: {status}")
            if not args.loop:
                break
    elif args.command == "rail-movements":
        service_date = args.date or datetime.now(UTC).date() - timedelta(days=1)
        print(irish_rail.collect_movements(sink, fetch, service_date))
    elif args.command == "gtfs-static":
        key = gtfs_static.snapshot(sink, datetime.now(UTC).date())
        print(f"stored {key}" if key else "timetable unchanged")
    elif args.command == "backfill":
        codes = backfill.train_codes_by_weekday(args.gtfs)
        yesterday = datetime.now(UTC).date() - timedelta(days=1)
        dates = [yesterday - timedelta(days=i) for i in range(args.days)]
        print(backfill.backfill(sink, fetch, dates, codes, workers=args.workers))


if __name__ == "__main__":
    main()
