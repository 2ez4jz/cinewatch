import json
from pathlib import Path

import watcher


FIXTURE = Path(__file__).parent / "fixtures" / "showtimes.json"


def test_parse_only_odyssey_imax_70mm():
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    found = watcher.parse_showtimes(payload, "7408", "2026-09-19")
    assert len(found) == 1
    assert found[0].showtime_id == "539585"
    assert found[0].format == "IMAX + 70mm"
    assert "theatreId=7408" in found[0].buy_url


def test_first_run_seeds_silently(monkeypatch):
    monkeypatch.delenv("NOTIFY_ON_FIRST_RUN", raising=False)
    item = watcher.Showtime("7408", "Vaughan", "2026-09-19", "15:00", "IMAX + 70mm", "1", "https://example.com")
    assert watcher.new_showtimes([item], None) == []


def test_detects_new_session():
    old = {"version": 1, "showtimes": [{"key": "7408:1"}]}
    existing = watcher.Showtime("7408", "Vaughan", "2026-09-19", "15:00", "IMAX + 70mm", "1", "https://example.com/1")
    added = watcher.Showtime("7408", "Vaughan", "2026-09-19", "19:00", "IMAX + 70mm", "2", "https://example.com/2")
    assert watcher.new_showtimes([existing, added], old) == [added]


def test_extracts_key_near_theatrical_api():
    source = 'x="apis.cineplex.com/prod/cpx/theatrical/api";h={"Ocp-Apim-Subscription-Key":"0123456789abcdef0123456789abcdef"}'
    assert watcher.extract_subscription_key(source) == "0123456789abcdef0123456789abcdef"
