from __future__ import annotations

import json
from collections.abc import Iterator

import boto3
import pytest
from moto import mock_aws

from commuteer.collector import handlers
from commuteer.collector.http import FetchError
from tests.conftest import FakeFetcher


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("AWS_DEFAULT_REGION", "eu-north-1")
    monkeypatch.setenv("DATA_BUCKET", "data")
    monkeypatch.setenv("NTA_API_KEY_PARAM", "/commuteer/nta_api_key")
    monkeypatch.setenv("POLL_WINDOW_S", "1")  # one poll per source, no waiting
    monkeypatch.delenv("NTA_API_KEY", raising=False)
    handlers._sink.cache_clear()
    handlers._clear_key_cache()
    with mock_aws():
        boto3.client("s3").create_bucket(
            Bucket="data", CreateBucketConfiguration={"LocationConstraint": "eu-north-1"}
        )
        yield
    handlers._sink.cache_clear()
    handlers._clear_key_cache()


def _set_key(value: str) -> None:
    boto3.client("ssm").put_parameter(
        Name="/commuteer/nta_api_key", Value=value, Type="SecureString"
    )


def test_poll_skips_nta_while_key_is_placeholder(
    aws: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key("CHANGE_ME")
    monkeypatch.setattr(handlers, "fetch", FakeFetcher({"irishrail": b"<xml/>"}))
    assert handlers.poll({}, None) == {"ok": 1, "failed": 0}


def test_poll_uses_key_from_ssm(aws: None, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_key("real-key")
    fetcher = FakeFetcher({"irishrail": b"<xml/>", "nationaltransport": b"\x08\x01"})
    monkeypatch.setattr(handlers, "fetch", fetcher)
    assert handlers.poll({}, None) == {"ok": 3, "failed": 0}
    assert {"x-api-key": "real-key"} in [headers for _, headers in fetcher.calls]


def test_poll_raises_when_everything_fails(
    aws: None, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _set_key("CHANGE_ME")
    monkeypatch.setattr(handlers, "fetch", FakeFetcher({"irishrail": FetchError("down")}))
    with pytest.raises(RuntimeError):
        handlers.poll({}, None)
    events = [json.loads(line)["event"] for line in capsys.readouterr().out.splitlines()]
    assert events == ["poll_error", "poll_done"]


def test_key_is_reread_after_ttl(aws: None) -> None:
    now = [0.0]
    _set_key("CHANGE_ME")
    assert handlers._nta_api_key(clock=lambda: now[0]) is None
    boto3.client("ssm").put_parameter(
        Name="/commuteer/nta_api_key", Value="new-key", Type="SecureString", Overwrite=True
    )
    now[0] = handlers.KEY_TTL_S - 1
    assert handlers._nta_api_key(clock=lambda: now[0]) is None  # still cached
    now[0] = handlers.KEY_TTL_S + 1
    assert handlers._nta_api_key(clock=lambda: now[0]) == "new-key"
