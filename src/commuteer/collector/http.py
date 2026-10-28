"""Small HTTP client with retries. Standard library only, so the Lambda bundle stays tiny."""

from __future__ import annotations

import shutil
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import IO

USER_AGENT = "commuteer-collector/0.1"

Fetcher = Callable[[str, Mapping[str, str]], bytes]


class FetchError(Exception):
    pass


def _open(url: str, headers: Mapping[str, str], timeout: float) -> IO[bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
    resp: IO[bytes] = urllib.request.urlopen(req, timeout=timeout)
    return resp


def _with_retries[T](action: Callable[[], T], url: str, retries: int, backoff_s: float) -> T:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return action()
        except urllib.error.HTTPError as e:
            # Client errors (bad key, bad URL) won't fix themselves; rate limits might.
            if 400 <= e.code < 500 and e.code != 429:
                raise FetchError(f"{url}: HTTP {e.code}") from e
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        if attempt < retries:
            time.sleep(backoff_s * 2**attempt)
    raise FetchError(f"{url}: failed after {retries + 1} attempts: {last}") from last


def fetch(
    url: str,
    headers: Mapping[str, str] | None = None,
    timeout: float = 20,
    retries: int = 2,
    backoff_s: float = 1.0,
) -> bytes:
    def action() -> bytes:
        with _open(url, headers or {}, timeout) as resp:
            return resp.read()

    return _with_retries(action, url, retries, backoff_s)


def download(url: str, dest: Path, timeout: float = 60, retries: int = 2) -> None:
    """Stream a large file to disk without holding it in memory."""

    def action() -> None:
        with _open(url, {}, timeout) as resp, dest.open("wb") as f:
            shutil.copyfileobj(resp, f, length=1 << 20)

    _with_retries(action, url, retries, backoff_s=2.0)
