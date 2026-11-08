"""Conversation truth on D1: messages, receipts, turns, presence, push outbox.

One row per (user, unit); one message row per bubble (global AUTOINCREMENT id is
the cursor). The scheduler is the only writer of a turn, so a reply cannot be
lost to a stale full-document save. Persona availability comes from
contact.json's hours table; offline means frozen (no reads, no generation, no
push)."""

import math
import random
import time
import uuid
from datetime import timedelta

from backend import cloud_npc, life

DRIFT = {"active": [0.8, 0.2, 0], "away": [0.1, 0.8, 0.1], "busy": [0.05, 0.15, 0.8]}
FACTOR = {"away": 4, "busy": 9}
VISIBLE_MS = 130_000
TURN_TTL_MS = 120_000


def now_ms() -> int:
    return int(time.time() * 1000)


def _local(now: float, tz: int):
    return life._local(now, tz)


def _hours(contact: dict, dt) -> list:
    off = dt.weekday() >= 5 or dt.strftime("%Y-%m-%d") in (contact.get("holidays") or [])
    return contact.get("hoursWeekend" if off else "hours") or contact.get("hours") or []


def _roll(lo, hi) -> float:
    lo = max(1.0, float(lo))
    hi = max(lo, float(hi))
    return math.exp(math.log(lo) + random.random() * math.log(hi / lo))


def sample_reply(contact: dict) -> float:
    reply = contact.get("reply")
    if isinstance(reply, list) and reply:
        r = random.random()
        for item in reply:
            weight, lo, hi = item
            r -= weight
            if r < 0:
                return _roll(lo, hi) if lo > 0 else random.random() * hi
        _, lo, hi = reply[-1]
        return _roll(lo, hi) if lo > 0 else random.random() * hi
    if reply == "spike":
        return random.random() * 2 if random.random() < 0.7 else _roll(8, 240)
    if reply == "normal":
        u1, u2 = 1 - random.random(), random.random()
        return min(12, max(0.5, 4.5 + math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2) * 1.2))
    if reply == "skew":
        return _roll(6, 300)
    base = contact.get("base") or [30, 180]
    return _roll(base[0], base[1])


def reply_delay(contact: dict, status: str, warm: bool = False) -> int | None:
    if status == "offline":
        return None
    if status == "busy" and random.random() > 0.35:
        return 5 * 60_000
    if warm:
        if random.random() >= 0.15:
            return int(min(sample_reply(contact), sample_reply(contact)) * 1000)
        return int((45 + random.random() * 135) * 1000)
    factor = FACTOR.get(status, 1)
    sec = max(sample_reply(contact), _roll(5, 15)) * factor if factor > 1 else sample_reply(contact)
    return int(sec * 1000)


def wake_at(contact: dict, now: float, tz: int) -> int:
    start = _local(now, tz).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    for i in range(48):
        dt = start + timedelta(hours=i)
        hours = _hours(contact, dt)
        if len(hours) == 24 and hours[dt.hour] != "offline":
            dt = dt + timedelta(minutes=random.randint(1, 12))
            return int((dt.timestamp() + tz * 60) * 1000)
    return now + 8 * 3600_000


def _drift(user: str, unit: str, anchor: str, contact: dict, now: float) -> str:
    w = DRIFT[anchor]
    r = 2166136261
    for ch in f"{user}|{unit}|{int(now // 120_000)}":
        r = ((r ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    r /= 4294967296
    chance = (contact.get("activeChance") or {}).get(anchor)
    if chance is not None:
        if r < chance:
            return "active"
        return "away" if (r - chance) / (1 - chance) < w[1] / (1 - w[0]) else "busy"
    return ["active", "away", "busy"][0 if r < w[0] else 1 if r < w[0] + w[1] else 2]


def status(contact: dict, conv: dict, user: str, unit: str, now: float, tz: int) -> str:
    if (conv["glow_until"] or 0) > now:
        return "active"
    anchor = life.schedule_state(contact, now, tz)
    if anchor == "offline":
        return "offline"
    return _drift(user, unit, anchor, contact, now)


async def _first(env, sql: str, *args):
    return await env.DB.prepare(sql).bind(*args).first()


async def _all(env, sql: str, *args):
    res = await env.DB.prepare(sql).bind(*args).all()
    return res.results


async def ensure(env, user: str, unit: str, now: int) -> None:
    await env.DB.prepare(
        "INSERT INTO conversations(user,unit,updated_at) VALUES(?,?,?) "
        "ON CONFLICT(user,unit) DO NOTHING").bind(user, unit, now).run()


async def load(env, user: str, unit: str, now: int | None = None) -> dict:
    await ensure(env, user, unit, now or now_ms())
    return await _first(env, "SELECT * FROM conversations WHERE user=? AND unit=?", user, unit)


async def prefs(env, user: str) -> dict:
    row = await _first(env, "SELECT * FROM prefs WHERE user=?", user)
    if row is None:
        await env.DB.prepare("INSERT INTO prefs(user) VALUES(?) ON CONFLICT(user) DO NOTHING").bind(user).run()
        row = await _first(env, "SELECT * FROM prefs WHERE user=?", user)
    return row


async def set_tz(env, user: str, tz: int) -> None:
    await env.DB.prepare(
        "INSERT INTO prefs(user,tz_offset) VALUES(?,?) "
        "ON CONFLICT(user) DO UPDATE SET tz_offset=excluded.tz_offset").bind(user, tz).run()


async def set_notif(env, user: str, notif: str) -> None:
    await env.DB.prepare(
        "INSERT INTO prefs(user,notif) VALUES(?,?) "
        "ON CONFLICT(user) DO UPDATE SET notif=excluded.notif").bind(user, notif).run()


async def set_migrated(env, user: str) -> None:
    await env.DB.prepare(
        "INSERT INTO prefs(user,migrated) VALUES(?,1) "
        "ON CONFLICT(user) DO UPDATE SET migrated=1").bind(user).run()


async def seed_proactive(env, user: str, unit: str, led: dict, eng,
                         now: int) -> None:
    if not isinstance(led, dict) and eng is None:
        return
    led = led if isinstance(led, dict) else {}
    await ensure(env, user, unit, now)
    await env.DB.prepare(
        "UPDATE conversations SET proactive_date=?, proactive_sent=?, "
        "proactive_last_at=?, engagement=?, engagement_at=? "
        "WHERE user=? AND unit=? AND proactive_date IS NULL"
    ).bind(str(led.get("date") or ""), int(led.get("sent") or 0),
           int(led.get("lastAt") or 0),
           float(eng) if isinstance(eng, (int, float)) else 0.15,
           now, user, unit).run()


async def append(env, user: str, unit: str, role: str, text: str, t: int,
                 kind: str = "text", client_id: str | None = None,
                 turn_id: str | None = None, hidden: int = 0) -> tuple[int, bool]:
    row = await env.DB.prepare(
        "INSERT INTO messages(user,unit,role,kind,text,t,client_id,turn_id,hidden) "
        "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user,unit,client_id) DO NOTHING RETURNING id"
    ).bind(user, unit, role, kind, text, t, client_id, turn_id, hidden).first()
    if row is not None:
        return int(row["id"]), True
    if client_id:
        row = await _first(env, "SELECT id FROM messages WHERE user=? AND unit=? AND client_id=?",
                           user, unit, client_id)
        if row:
            return int(row["id"]), False
    return 0, False


async def recent(env, user: str, unit: str, limit: int = 30) -> list:
    rows = await _all(env,
        "SELECT id,role,text,t,kind,hidden FROM messages "
        "WHERE user=? AND unit=? AND kind IN ('text','transcript') "
        "ORDER BY id DESC LIMIT ?", user, unit, limit)
    return list(reversed(rows))


async def tail(env, user: str, unit: str, after: int = 0, limit: int = 50) -> list:
    if after:
        return await _all(env,
            "SELECT id,role,kind,text,t,hidden,client_id FROM messages "
            "WHERE user=? AND unit=? AND id>? ORDER BY id LIMIT ?",
            user, unit, after, limit)
    rows = await _all(env,
        "SELECT id,role,kind,text,t,hidden,client_id FROM messages "
        "WHERE user=? AND unit=? ORDER BY id DESC LIMIT ?", user, unit, limit)
    return list(reversed(rows))


async def last_text(env, user: str, unit: str):
    return await _first(env,
        "SELECT id,role,text,t,kind,hidden,client_id FROM messages "
        "WHERE user=? AND unit=? AND kind='text' AND hidden=0 "
        "ORDER BY id DESC LIMIT 1", user, unit)


async def last_any(env, user: str, unit: str):
    return await _first(env,
        "SELECT id,role,text,t,kind,hidden,client_id FROM messages "
        "WHERE user=? AND unit=? AND kind IN ('text','call') AND hidden=0 "
        "ORDER BY id DESC LIMIT 1", user, unit)


async def last_ai_t(env, user: str, unit: str) -> int:
    row = await _first(env,
        "SELECT t FROM messages WHERE user=? AND unit=? AND role='ai' AND kind='text' "
        "ORDER BY id DESC LIMIT 1", user, unit)
    return int(row["t"]) if row else 0


async def unread(env, user: str, unit: str, seen: int) -> int:
    row = await _first(env,
        "SELECT COUNT(*) AS n FROM messages WHERE user=? AND unit=? AND role='ai' "
        "AND kind='text' AND hidden=0 AND id>?", user, unit, seen)
    return int(row["n"]) if row else 0


async def has_messages(env, user: str) -> bool:
    return await _first(env, "SELECT 1 AS x FROM messages WHERE user=? LIMIT 1", user) is not None


async def import_messages(env, user: str, unit: str, rows: list[dict],
                          seen_t: int, now: int) -> None:
    await ensure(env, user, unit, now)
    stmts = [
        env.DB.prepare(
            "INSERT INTO messages(user,unit,role,kind,text,t,client_id,hidden) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user,unit,client_id) DO NOTHING")
        .bind(user, unit, r["role"], r["kind"], r["text"], r["t"],
              r["client_id"], r["hidden"])
        for r in rows
    ]
    for i in range(0, len(stmts), 50):
        await env.DB.batch(stmts[i:i + 50])
    top = await _first(env,
        "SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE user=? AND unit=?",
        user, unit)
    seen = await _first(env,
        "SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE user=? AND unit=? "
        "AND role='ai' AND t<=?", user, unit, seen_t)
    await env.DB.prepare(
        "UPDATE conversations SET npc_read_seq=?, user_seen_seq=?, reply_due_at=NULL, "
        "turn_id=NULL, turn_expires_at=0, turn_kind=NULL, updated_at=? "
        "WHERE user=? AND unit=?").bind(
            int(top["id"]) if top else 0, int(seen["id"]) if seen else 0,
            now, user, unit).run()


async def schedule(env, user: str, unit: str, kind: str, due: int, now: int,
                   burst_left: int | None = None, only_if_idle: bool = False) -> None:
    sql = ("UPDATE conversations SET reply_due_at=?, turn_kind=?, turn_id=NULL, "
           "turn_expires_at=0, updated_at=?")
    args = [due, kind, now]
    if burst_left is not None:
        sql += ", burst_left=?"
        args.append(burst_left)
    sql += " WHERE user=? AND unit=?"
    args += [user, unit]
    if only_if_idle:
        sql += " AND reply_due_at IS NULL AND (turn_id IS NULL OR turn_expires_at<?)"
        args.append(now)
    await env.DB.prepare(sql).bind(*args).run()


async def claim(env, user: str, unit: str, now: int) -> tuple[str | None, dict | None]:
    turn = uuid.uuid4().hex
    await env.DB.prepare(
        "UPDATE conversations SET turn_id=?, turn_expires_at=?, updated_at=? "
        "WHERE user=? AND unit=? AND reply_due_at IS NOT NULL AND reply_due_at<=? "
        "AND (turn_id IS NULL OR turn_expires_at<?)"
    ).bind(turn, now + TURN_TTL_MS, now, user, unit, now, now).run()
    row = await _first(env,
        "SELECT turn_id,turn_kind,reply_due_at FROM conversations WHERE user=? AND unit=?",
        user, unit)
    return (turn, row) if row and row["turn_id"] == turn else (None, None)


async def complete(env, user: str, unit: str, turn: str, parts: list[str],
                   now: int, glow_ms: int) -> bool:
    read = await _first(env,
        "SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE user=? AND unit=? "
        "AND role='me' AND kind='text'", user, unit)
    read = int(read["id"]) if read else 0
    stmts = [
        env.DB.prepare(
            "INSERT INTO messages(user,unit,role,kind,text,t,turn_id) "
            "SELECT ?,?,'ai','text',?,?,? WHERE EXISTS("
            "SELECT 1 FROM conversations WHERE user=? AND unit=? AND turn_id=?)")
        .bind(user, unit, part, now + i, turn, user, unit, turn)
        for i, part in enumerate(parts)
    ]
    stmts.append(env.DB.prepare(
        "UPDATE conversations SET turn_id=NULL, turn_expires_at=0, reply_due_at=NULL, "
        "turn_kind=NULL, glow_until=?, npc_read_seq=MAX(npc_read_seq,?), updated_at=? "
        "WHERE user=? AND unit=? AND turn_id=?").bind(
            now + glow_ms, read, now, user, unit, turn))
    await env.DB.batch(stmts)
    row = await _first(env,
        "SELECT turn_id, reply_due_at FROM conversations WHERE user=? AND unit=?",
        user, unit)
    return row is not None and row["turn_id"] is None and row["reply_due_at"] is None


async def fail(env, user: str, unit: str, turn: str, retry_at: int, now: int) -> None:
    await env.DB.prepare(
        "UPDATE conversations SET turn_id=NULL, turn_expires_at=0, reply_due_at=?, "
        "updated_at=? WHERE user=? AND unit=? AND turn_id=?"
    ).bind(retry_at, now, user, unit, turn).run()


async def set_seen(env, user: str, unit: str, seq: int, now: int) -> None:
    await env.DB.prepare(
        "UPDATE conversations SET user_seen_seq=MAX(user_seen_seq,?), updated_at=? "
        "WHERE user=? AND unit=?").bind(seq, now, user, unit).run()


async def touch_device(env, user: str, device: str, now: int, visible: bool) -> None:
    await env.DB.prepare(
        "INSERT INTO devices(user,device_id,visible,last_seen) VALUES(?,?,?,?) "
        "ON CONFLICT(user,device_id) DO UPDATE SET visible=excluded.visible, "
        "last_seen=excluded.last_seen"
    ).bind(user, device, 1 if visible else 0, now).run()


async def visible_devices(env, user: str, now: int) -> set[str]:
    rows = await _all(env,
        "SELECT device_id FROM devices WHERE user=? AND visible=1 AND last_seen>?",
        user, now - VISIBLE_MS)
    return {r["device_id"] for r in rows}


async def due(env, now: int, limit: int = 5) -> list:
    return await _all(env,
        "SELECT user,unit FROM conversations WHERE reply_due_at IS NOT NULL "
        "AND reply_due_at<=? AND (turn_id IS NULL OR turn_expires_at<?) "
        "ORDER BY reply_due_at LIMIT ?", now, now, limit)


async def users_with_unpushed(env, limit: int = 20) -> list[str]:
    rows = await _all(env,
        "SELECT DISTINCT user FROM messages WHERE pushed_at IS NULL AND role='ai' "
        "AND kind='text' AND hidden=0 LIMIT ?", limit)
    return [r["user"] for r in rows]


async def next_push(env, user: str, unit: str, seen: int):
    row = await _first(env,
        "SELECT turn_id, MIN(id) AS id, MIN(t) AS t FROM messages "
        "WHERE user=? AND unit=? AND role='ai' AND kind='text' AND hidden=0 "
        "AND pushed_at IS NULL AND id>? GROUP BY turn_id ORDER BY id DESC LIMIT 1",
        user, unit, seen)
    if row is None:
        return None
    msg = await _first(env, "SELECT text FROM messages WHERE id=?", row["id"])
    return {**row, "text": msg["text"] if msg else ""}


async def mark_pushed(env, user: str, unit: str, now: int) -> None:
    await env.DB.prepare(
        "UPDATE messages SET pushed_at=? WHERE user=? AND unit=? AND pushed_at IS NULL "
        "AND role='ai' AND kind='text' AND hidden=0").bind(now, user, unit).run()


async def bump_engagement(env, user: str, unit: str, now: int, warm: bool) -> None:
    await ensure(env, user, unit, now)
    await env.DB.prepare(
        "UPDATE conversations SET engagement=MIN(1,engagement+?), engagement_at=?, "
        "proactive_counted=1, updated_at=? WHERE user=? AND unit=?"
    ).bind(0.3 if warm else 0.2, now, now, user, unit).run()


async def maybe_burst(env, user: str, unit: str, contact: dict, now: int) -> None:
    conv = await load(env, user, unit, now)
    if conv["reply_due_at"] is not None or int(conv["burst_left"] or 0) <= 0:
        return
    chance, _ = contact.get("burst") or [0, 0]
    if random.random() >= chance:
        await env.DB.prepare(
            "UPDATE conversations SET burst_left=0 WHERE user=? AND unit=?").bind(user, unit).run()
        return
    await env.DB.prepare(
        "UPDATE conversations SET burst_left=burst_left-1, reply_due_at=?, turn_kind='burst', "
        "turn_id=NULL, turn_expires_at=0, updated_at=? "
        "WHERE user=? AND unit=? AND reply_due_at IS NULL"
    ).bind(now + 2000 + int(random.random() * 6000), now, user, unit).run()


async def proactive(env, user: str, unit: str, contact: dict, now: int, tz: int) -> bool:
    conv = await load(env, user, unit, now)
    st = status(contact, conv, user, unit, now, tz)
    if st == "offline" or conv["reply_due_at"] is not None:
        return False
    last = await last_text(env, user, unit)
    if last and last["role"] == "me":
        return False
    sent = int(conv["proactive_sent"] or 0)
    date = life.day_stamp(now, tz)
    if conv["proactive_date"] != date:
        sent = 0
    at = int(conv["engagement_at"] or now)
    engine = float(conv["engagement"] or 0.15) * (0.9997 ** (max(0, now - at) / 60_000.0))
    counted = int(conv["proactive_counted"] or 1)
    last_at = int(conv["proactive_last_at"] or 0)
    if last_at and not counted and now - last_at > 2 * 3600_000:
        engine *= 0.6
        counted = 1
    hit = cloud_npc.pick_proactive(
        contact, {"date": date, "sent": sent}, engine, now / 1000,
        slot_minutes=5)
    if hit:
        sent += 1
        last_at, counted = now, 0
        await schedule(env, user, unit, "proactive", now, now)
    await env.DB.prepare(
        "UPDATE conversations SET engagement=?, engagement_at=?, proactive_date=?, "
        "proactive_sent=?, proactive_last_at=?, proactive_counted=?, updated_at=? "
        "WHERE user=? AND unit=?"
    ).bind(engine, now, date, sent, last_at, counted, now, user, unit).run()
    return hit


async def defer_to_wake(env, user: str, unit: str, contact: dict,
                        now: int, tz: int, kind: str) -> None:
    due_at = wake_at(contact, now, tz) + (reply_delay(contact, "active") or 5000)
    await schedule(env, user, unit, kind or "reply", due_at, now)


async def reset(env, user: str, unit: str, now: int) -> None:
    await env.DB.prepare("DELETE FROM messages WHERE user=? AND unit=?").bind(user, unit).run()
    await env.DB.prepare(
        "UPDATE conversations SET npc_read_seq=0, user_seen_seq=0, reply_due_at=NULL, "
        "turn_id=NULL, turn_expires_at=0, turn_kind=NULL, glow_until=0, burst_left=0, "
        "updated_at=? WHERE user=? AND unit=?").bind(now, user, unit).run()
