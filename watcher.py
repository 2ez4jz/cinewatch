from __future__ import annotations

import html
import json
import logging
import os
import re
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urljoin
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "data" / "state.json"
API_BASE = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1"
CINEPLEX_HOME = "https://www.cineplex.com/"
TORONTO = ZoneInfo("America/Toronto")
THEATRES = {
    "7408": "Cineplex Cinemas Vaughan",
    "7420": "Cineplex Cinemas Mississauga (Square One)",
}
TITLE = "The Odyssey"
USER_AGENT = "CineplexShowtimeWatcher/1.0 (personal-use; low-frequency monitor)"


@dataclass(frozen=True)
class Showtime:
    theatre_id: str
    theatre: str
    date: str
    start_time: str
    format: str
    showtime_id: str
    buy_url: str

    @property
    def key(self) -> str:
        # A Vista session id is unique at a theatre. The fallback makes tests and
        # unexpected incomplete API records deterministic.
        return f"{self.theatre_id}:{self.showtime_id or self.date + ':' + self.start_time}"


def make_session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=1,
        status_forcelist=(408, 429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "POST"}),
        respect_retry_after_header=True,
    )
    session = requests.Session()
    session.headers.update({"Accept": "application/json", "User-Agent": USER_AGENT})
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


def extract_subscription_key(source: str) -> str | None:
    anchor = "apis.cineplex.com/prod/cpx/theatrical/api"
    pattern = re.compile(r'Ocp-Apim-Subscription-Key"?\s*:\s*"([0-9a-f]{32})"', re.I)
    start = 0
    while (at := source.find(anchor, start)) >= 0:
        around = source[max(0, at - 400) : at + 400]
        if match := pattern.search(around):
            return match.group(1)
        start = at + len(anchor)
    return None


def discover_subscription_key(session: requests.Session) -> str:
    logging.info("Discovering Cineplex's public frontend subscription key")
    response = session.get(CINEPLEX_HOME, timeout=20)
    response.raise_for_status()
    chunks = list(dict.fromkeys(re.findall(r'["\'(]([^"\'()]*_next/static/[^"\'()]*?\.js)', response.text)))
    for ref in chunks[:30]:
        try:
            chunk = session.get(urljoin(CINEPLEX_HOME, ref), timeout=20)
            chunk.raise_for_status()
        except requests.RequestException as exc:
            logging.warning("Skipping unreadable frontend chunk: %s", exc)
            continue
        if key := extract_subscription_key(chunk.text):
            return key
    raise RuntimeError(
        "Could not discover the Cineplex subscription key. Set "
        "CINEPLEX_SUBSCRIPTION_KEY from the current Cineplex web app."
    )


def api_headers(key: str) -> dict[str, str]:
    return {"Ocp-Apim-Subscription-Key": key}


def fetch_day(session: requests.Session, key: str, theatre_id: str, day: str) -> Any:
    response = session.get(
        f"{API_BASE}/showtimes",
        params={"language": "en", "locationId": theatre_id, "date": day},
        headers=api_headers(key),
        timeout=20,
    )
    response.raise_for_status()
    return response.json() if response.content else []


def normalized_tags(experience: dict[str, Any]) -> list[str]:
    raw = experience.get("experienceTypes") or []
    return [str(tag).strip() for tag in raw if str(tag).strip()]


def is_target_format(tags: list[str]) -> bool:
    normalized = {re.sub(r"[^a-z0-9]", "", tag.lower()) for tag in tags}
    return "imax" in normalized and "70mm" in normalized


def parse_showtimes(payload: Any, theatre_id: str, requested_day: str) -> list[Showtime]:
    entries = payload if isinstance(payload, list) else []
    theatre = next(
        (item for item in entries if str(item.get("theatreId", "")) == theatre_id),
        entries[0] if entries else {},
    )
    dates = theatre.get("dates") or []
    date_entry = next(
        (item for item in dates if str(item.get("startDate", ""))[:10] == requested_day),
        dates[0] if len(dates) == 1 else {},
    )
    found: list[Showtime] = []
    for movie in date_entry.get("movies") or []:
        if str(movie.get("name", "")).strip().casefold() != TITLE.casefold():
            continue
        for experience in movie.get("experiences") or []:
            tags = normalized_tags(experience)
            if not is_target_format(tags):
                continue
            for item in experience.get("sessions") or []:
                if item.get("isInThePast") or item.get("isShowtimeEnabledOnline") is False:
                    continue
                start = str(item.get("showStartDateTime") or "")
                showtime_id = str(item.get("vistaSessionId") or "")
                if not start or not showtime_id:
                    logging.warning("Ignoring incomplete session at theatre %s on %s", theatre_id, requested_day)
                    continue
                query = urlencode({"theatreId": theatre_id, "showtimeId": showtime_id, "dbox": "false"})
                buy_url = f"https://www.cineplex.com/ticketing/preview?{query}"
                found.append(
                    Showtime(
                        theatre_id=theatre_id,
                        theatre=THEATRES[theatre_id],
                        date=start[:10] or requested_day,
                        start_time=start[11:16],
                        format=" + ".join(tags),
                        showtime_id=showtime_id,
                        buy_url=buy_url,
                    )
                )
    return found


def collect_showtimes(session: requests.Session, key: str, days: int) -> list[Showtime]:
    today = datetime.now(TORONTO).date()
    results: dict[str, Showtime] = {}
    for offset in range(days):
        day = (today + timedelta(days=offset)).isoformat()
        for theatre_id, theatre_name in THEATRES.items():
            logging.info("Checking %s for %s", theatre_name, day)
            payload = fetch_day(session, key, theatre_id, day)
            for showtime in parse_showtimes(payload, theatre_id, day):
                results[showtime.key] = showtime
            time.sleep(0.2)
    return sorted(results.values(), key=lambda item: (item.date, item.start_time, item.theatre))


def load_state(path: Path = STATE_PATH) -> dict[str, Any] | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as handle:
        state = json.load(handle)
    if state.get("version") != 1 or not isinstance(state.get("showtimes"), list):
        raise ValueError(f"Unsupported or corrupt state file: {path}")
    return state


def save_state(showtimes: list[Showtime], path: Path = STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "version": 1,
        "updated_at": datetime.now(TORONTO).isoformat(timespec="seconds"),
        "showtimes": [asdict(item) | {"key": item.key} for item in showtimes],
    }
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.replace(path)


def new_showtimes(current: list[Showtime], previous: dict[str, Any] | None) -> list[Showtime]:
    if previous is None:
        return current if env_bool("NOTIFY_ON_FIRST_RUN", False) else []
    old_keys = {str(item.get("key")) for item in previous["showtimes"]}
    return [item for item in current if item.key not in old_keys]


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


def telegram_message(showtimes: list[Showtime]) -> str:
    lines = ["🎬 <b>The Odyssey — 新增 IMAX 70mm 场次</b>"]
    for item in showtimes:
        day = date.fromisoformat(item.date).strftime("%a, %b %d")
        lines.extend(
            [
                "",
                f"🏢 <b>{html.escape(item.theatre)}</b>",
                f"📅 {html.escape(day)} · {html.escape(item.start_time)}",
                f"🎞 {html.escape(item.format)}",
                f'🎟 <a href="{html.escape(item.buy_url, quote=True)}">立即购票</a>',
            ]
        )
    return "\n".join(lines)


def notify_telegram(session: requests.Session, showtimes: list[Showtime]) -> None:
    token = require_env("TELEGRAM_BOT_TOKEN")
    chat_id = require_env("TELEGRAM_CHAT_ID")
    response = session.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={
            "chat_id": chat_id,
            "text": telegram_message(showtimes),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=20,
    )
    response.raise_for_status()
    body = response.json()
    if not body.get("ok"):
        raise RuntimeError(f"Telegram rejected the notification: {body.get('description', 'unknown error')}")


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def main() -> int:
    load_dotenv(ROOT / ".env")
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        session = make_session()
        key = os.getenv("CINEPLEX_SUBSCRIPTION_KEY", "").strip() or discover_subscription_key(session)
        days = int(os.getenv("WATCH_DAYS", "21"))
        if not 1 <= days <= 90:
            raise ValueError("WATCH_DAYS must be between 1 and 90")
        current = collect_showtimes(session, key, days)
        previous = load_state()
        additions = new_showtimes(current, previous)
        logging.info("Found %d matching showtimes (%d new)", len(current), len(additions))
        if additions:
            notify_telegram(session, additions)
            logging.info("Telegram notification sent")
        save_state(current)
        return 0
    except Exception:
        logging.exception("Watcher failed; previous state was not changed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
