"""Prompt time sense: current local date, last-exchange gap, day labels."""

from datetime import datetime, timedelta, timezone
import time

# JS getTimezoneOffset() for UTC+8. Browser value wins when present.
DEFAULT_TZ_OFFSET = -480


def clamp_tz(raw) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TZ_OFFSET
    return max(-840, min(840, value))


def _local(ms, tz_offset: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc) - timedelta(minutes=tz_offset)


def _valid_ts(value) -> bool:
    return isinstance(value, (int, float)) and value > 0


def _part_of_day(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    if 18 <= hour < 23:
        return "evening"
    return "night"


def _date_label(dt: datetime, now: datetime) -> str:
    days = (now.date() - dt.date()).days
    if days <= 0:
        rel = "Today"
    elif days == 1:
        rel = "Yesterday"
    elif days < 7:
        rel = f"{days} days ago"
    elif days < 14:
        rel = "Last week"
    elif days < 30:
        rel = f"{days // 7} weeks ago"
    elif days < 365:
        rel = f"{days // 30} months ago"
    else:
        rel = "Over a year ago"
    year = f", {dt.year}" if dt.year != now.year else ""
    return f"{rel} · {dt.strftime('%a, %b')} {dt.day}{year}"


def _gap_label(last: datetime, now: datetime) -> str:
    seconds = max(0, (now - last).total_seconds())
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)} minutes ago"
    days = (now.date() - last.date()).days
    if days == 0:
        return "earlier today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days} days ago"
    if days < 14:
        return "last week"
    if days < 30:
        return f"{days // 7} weeks ago"
    if days < 365:
        return f"{days // 30} months ago"
    return "over a year ago"


def _last_exchange(history) -> int | None:
    # The current user message is already in history; use the last AI reply so
    # "Hey" after a week does not collapse the gap to zero.
    for item in reversed(history):
        if item.get("who") == "ai" and _valid_ts(item.get("t")):
            return int(item["t"])
    return None


def build_time_context(history, tz_offset=DEFAULT_TZ_OFFSET, now_ms=None) -> dict:
    tz_offset = clamp_tz(tz_offset)
    now = _local(now_ms if _valid_ts(now_ms) else time.time() * 1000, tz_offset)

    dated = []
    prev_day = None
    for item in history:
        prefix = ""
        t = item.get("t")
        if _valid_ts(t):
            dt = _local(t, tz_offset)
            if dt.date() != prev_day:
                prefix = f"[{_date_label(dt, now)}]"
                prev_day = dt.date()
        dated.append({
            "who": item.get("who"),
            "text": item.get("text", ""),
            "prefix": prefix,
        })

    last_ts = _last_exchange(history)
    if last_ts is None:
        last_line = ("The earlier messages don't have dates."
                     if any(i.get("who") == "ai" for i in history)
                     else "This is the first time you're exchanging messages in this chat.")
    else:
        last = _local(last_ts, tz_offset)
        year = f", {last.year}" if last.year != now.year else ""
        last_line = (
            f"Your last exchange: {_gap_label(last, now)}, on "
            f"{last.strftime('%A')} {_part_of_day(last.hour)} "
            f"({last.strftime('%b')} {last.day}{year})."
        )

    header = (
        "# Time sense\n"
        "You text with the user across days. A same-day gap is a pause in one "
        "conversation; a longer gap is a reconnection. Let the gap shape your first "
        "line: after a short pause, continue the thread; after a longer gap, a fresh "
        "hello is natural, with only a light callback to what you last discussed. "
        "You don't have to mention the gap.\n\n"
        f"Now: {now.strftime('%A')} {_part_of_day(now.hour)}, "
        f"{now.strftime('%b')} {now.day}, {now.year}.\n"
        f"{last_line}\n"
        "History dates are shown when the day changes."
    )
    return {"header": header, "history": dated}
