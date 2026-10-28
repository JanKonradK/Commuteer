from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import pytest

from commuteer.collector.http import FetchError
from commuteer.collector.storage import LocalSink

FIXTURES = Path(__file__).parent / "fixtures"


class FakeFetcher:
    """Returns canned responses by URL substring and records every call."""

    def __init__(self, responses: Mapping[str, bytes | Exception]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: Mapping[str, str]) -> bytes:
        self.calls.append((url, dict(headers)))
        for fragment, response in self.responses.items():
            if fragment in url:
                if isinstance(response, Exception):
                    raise response
                return response
        raise FetchError(f"no fake response for {url}")


@pytest.fixture
def sink(tmp_path: Path) -> LocalSink:
    return LocalSink(tmp_path / "data")


@pytest.fixture
def current_trains_xml() -> bytes:
    return (FIXTURES / "current_trains.xml").read_bytes()


@pytest.fixture
def movements_xml() -> bytes:
    return (FIXTURES / "movements_A701.xml").read_bytes()
