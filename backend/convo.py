"""Conversation truth on D1: messages, receipts, turns, presence, push outbox.

One row per (user, unit); one message row per bubble (global AUTOINCREMENT id is
the cursor). The scheduler is the only writer of a turn, so a reply cannot be
lost to a stale full-document save. Persona availability comes from
contact.json's hours table; offline means frozen (no reads, no generation, no
push)."""

import json
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
JOB_LEASE_MS = 180_000
TICK_MS = 300_000
ENSURE_MS = 600_000
JOB_MAX_ATTEMPTS = {"reply": 6, "burst": 4, "proactive": 4,
                    "proactive_tick": 5, "life_day": 4}


def backoff_ms(attempts: int) -> int:
    return min(15 * 60_000, 60_000 * (2 ** max(0, attempts - 1)))


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


# ── job queue ─────────────────────────────────────────────────────────────
# jobs 是唯一的调度真源。state 只走 pending -> leased -> done|dead；
# leased 过期由 recover() 拉回 pending，因此任何孤儿都会被重新推进。


async def enqueue(env, user: str, unit: str, kind: str, due_at: int, key: str,
                  payload: dict | None = None, now: int | None = None) -> None:
    now = now or now_ms()
    await env.DB.prepare(
        "INSERT INTO jobs(user,unit,kind,state,due_at,attempts,max_attempts,"
        "dedupe_key,payload,created_at,updated_at) "
        "VALUES(?,?,?,'pending',?,0,?,?,?,?,?) "
        "ON CONFLICT(dedupe_key) DO NOTHING"
    ).bind(user, unit, kind, int(due_at), JOB_MAX_ATTEMPTS.get(kind, 4), key,
           json.dumps(payload or {}, ensure_ascii=False), now, now).run()


async def claim_job(env, job_id: int, now: int):
    return await env.DB.prepare(
        "UPDATE jobs SET state='leased', lease_until=?, attempts=attempts+1, updated_at=? "
        "WHERE id=? AND state='pending' RETURNING *"
    ).bind(now + JOB_LEASE_MS, now, job_id).first()


async def claim_jobs(env, now: int, limit: int = 8) -> list:
    rows = await _all(env,
        "SELECT id FROM jobs WHERE state='pending' AND due_at<=? "
        "ORDER BY due_at LIMIT ?", now, limit)
    out = []
    for r in rows:
        job = await claim_job(env, r["id"], now)
        if job is not None:
            out.append(job)
    return out


async def due_job(env, user: str, unit: str, now: int):
    return await _first(env,
        "SELECT * FROM jobs WHERE user=? AND unit=? AND state='pending' AND due_at<=? "
        "AND kind IN ('reply','burst','proactive') ORDER BY due_at LIMIT 1",
        user, unit, now)


async def pending_due(env, user: str, unit: str):
    return await _first(env,
        "SELECT due_at FROM jobs WHERE user=? AND unit=? AND state IN ('pending','leased') "
        "AND kind IN ('reply','burst','proactive') ORDER BY due_at LIMIT 1", user, unit)


async def retry(env, job: dict, now: int, error: str | None = None) -> None:
    attempts = int(job["attempts"] or 0)
    if attempts >= int(job["max_attempts"] or 4):
        await env.DB.prepare(
            "UPDATE jobs SET state='dead', lease_until=0, updated_at=?, last_error=? "
            "WHERE id=? AND state='leased'").bind(
                now, (error or "max attempts")[:300], job["id"]).run()
        return
    await env.DB.prepare(
        "UPDATE jobs SET state='pending', due_at=?, lease_until=0, updated_at=?, "
        "last_error=? WHERE id=? AND state='leased'"
    ).bind(now + backoff_ms(attempts), now, (error or "")[:300], job["id"]).run()


async def defer(env, job: dict, due_at: int, now: int) -> None:
    """Soft defer (busy/offline): does not count toward max_attempts."""
    await env.DB.prepare(
        "UPDATE jobs SET state='pending', due_at=?, lease_until=0, "
        "attempts=MAX(0,attempts-1), updated_at=? WHERE id=? AND state='leased'"
    ).bind(int(due_at), now, job["id"]).run()


async def reschedule(env, job_id: int, due_at: int, now: int) -> None:
    """Recurring jobs: back to pending at the next due time, attempts reset."""
    await env.DB.prepare(
        "UPDATE jobs SET state='pending', due_at=?, lease_until=0, attempts=0, updated_at=? "
        "WHERE id=?").bind(int(due_at), now, job_id).run()


async def recover(env, now: int) -> None:
    await env.DB.prepare(
        "UPDATE jobs SET state='pending', due_at=?, lease_until=0, updated_at=? "
        "WHERE state='leased' AND lease_until<?").bind(now, now, now).run()
    await env.DB.prepare(
        "UPDATE conversations SET turn_id=NULL, turn_expires_at=0, updated_at=? "
        "WHERE turn_id IS NOT NULL AND turn_expires_at<?").bind(now, now).run()


async def ensure_job(env, user: str, unit: str, kind: str, key: str,
                     due_at: int, now: int) -> None:
    """Idempotent recurring job. Revives only if missing or done/dead."""
    await env.DB.prepare(
        "INSERT INTO jobs(user,unit,kind,state,due_at,attempts,max_attempts,"
        "dedupe_key,payload,created_at,updated_at) "
        "VALUES(?,?,?,'pending',?,0,?,?,'{}',?,?) "
        "ON CONFLICT(dedupe_key) DO UPDATE SET "
        "state=CASE WHEN jobs.state IN ('done','dead') THEN 'pending' ELSE jobs.state END, "
        "due_at=CASE WHEN jobs.state IN ('done','dead') THEN excluded.due_at ELSE jobs.due_at END, "
        "attempts=CASE WHEN jobs.state IN ('done','dead') THEN 0 ELSE jobs.attempts END, "
        "updated_at=excluded.updated_at "
        "WHERE jobs.state IN ('done','dead')"
    ).bind(user, unit, kind, int(due_at), JOB_MAX_ATTEMPTS.get(kind, 4), key, now, now).run()


async def ensure_due(env, now: int) -> bool:
    row = await _first(env, "SELECT ensured_at FROM cron_health WHERE id=1")
    return row is None or now - int(row["ensured_at"] or 0) >= ENSURE_MS


async def mark_ensured(env, now: int) -> None:
    await env.DB.prepare(
        "INSERT INTO cron_health(id,last_drain_at,ensured_at) VALUES(1,?,?) "
        "ON CONFLICT(id) DO UPDATE SET ensured_at=excluded.ensured_at"
    ).bind(now, now).run()


async def heartbeat(env, now: int) -> None:
    row = await _first(env,
        "SELECT SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS p, "
        "SUM(CASE WHEN state='leased' THEN 1 ELSE 0 END) AS l, "
        "SUM(CASE WHEN state='dead' THEN 1 ELSE 0 END) AS d FROM jobs")
    p = int(row["p"] or 0) if row else 0
    l = int(row["l"] or 0) if row else 0
    d = int(row["d"] or 0) if row else 0
    await env.DB.prepare(
        "INSERT INTO cron_health(id,last_drain_at,pending,leased,dead) VALUES(1,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET last_drain_at=excluded.last_drain_at, "
        "pending=excluded.pending, leased=excluded.leased, dead=excluded.dead"
    ).bind(now, p, l, d).run()


async def health(env) -> dict:
    row = await _first(env, "SELECT * FROM cron_health WHERE id=1")
    return row or {}


async def jobs_migrated(env) -> bool:
    row = await _first(env, "SELECT jobs_migrated FROM cron_health WHERE id=1")
    return bool(row and int(row["jobs_migrated"] or 0))


async def mark_jobs_migrated(env, now: int) -> None:
    await env.DB.prepare(
        "INSERT INTO cron_health(id,last_drain_at,jobs_migrated) VALUES(1,?,1) "
        "ON CONFLICT(id) DO UPDATE SET jobs_migrated=1"
    ).bind(now).run()


async def reconcile(env, now: int) -> None:
    """One-time: clear stale turns and re-enqueue unanswered user messages."""
    await env.DB.prepare(
        "UPDATE conversations SET reply_due_at=NULL, turn_id=NULL, turn_expires_at=0, "
        "turn_kind=NULL, updated_at=?").bind(now).run()
    rows = await _all(env,
        "SELECT c.user, c.unit FROM conversations c WHERE EXISTS ("
        "SELECT 1 FROM messages m WHERE m.user=c.user AND m.unit=c.unit "
        "AND m.role='me' AND m.kind='text' AND m.hidden=0 AND m.id > COALESCE(("
        "SELECT MAX(a.id) FROM messages a WHERE a.user=c.user AND a.unit=c.unit "
        "AND a.role='ai' AND a.kind='text'),0))")
    for r in rows:
        last = await _first(env,
            "SELECT id FROM messages WHERE user=? AND unit=? AND role='me' AND kind='text' "
            "ORDER BY id DESC LIMIT 1", r["user"], r["unit"])
        if last:
            await enqueue(env, r["user"], r["unit"], "reply", now,
                          f"reply:{r['user']}:{r['unit']}:{last['id']}",
                          {"msg_id": last["id"]}, now)


# ── turn lease ────────────────────────────────────────────────────────────


async def claim_turn(env, user: str, unit: str, now: int) -> str | None:
    await ensure(env, user, unit, now)
    turn = uuid.uuid4().hex
    row = await env.DB.prepare(
        "UPDATE conversations SET turn_id=?, turn_expires_at=?, updated_at=? "
        "WHERE user=? AND unit=? AND (turn_id IS NULL OR turn_expires_at<?) "
        "RETURNING turn_id"
    ).bind(turn, now + TURN_TTL_MS, now, user, unit, now).first()
    return turn if row and row["turn_id"] == turn else None


async def release_turn(env, user: str, unit: str, turn: str, now: int) -> None:
    await env.DB.prepare(
        "UPDATE conversations SET turn_id=NULL, turn_expires_at=0, updated_at=? "
        "WHERE user=? AND unit=? AND turn_id=?").bind(now, user, unit, turn).run()


async def complete(env, user: str, unit: str, turn: str, parts: list[str],
                   now: int, glow_ms: int, job_id: int, proactive: bool = False) -> bool:
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
    if proactive:
        stmts.append(env.DB.prepare(
            "UPDATE conversations SET proactive_sent=proactive_sent+1, "
            "proactive_last_at=?, updated_at=? "
            "WHERE user=? AND unit=? AND turn_id=?"
        ).bind(now, now, user, unit, turn))
    stmts.append(env.DB.prepare(
        "UPDATE conversations SET turn_id=NULL, turn_expires_at=0, "
        "glow_until=?, npc_read_seq=MAX(npc_read_seq,?), updated_at=? "
        "WHERE user=? AND unit=? AND turn_id=?").bind(
            now + glow_ms, read, now, user, unit, turn))
    stmts.append(env.DB.prepare(
        "UPDATE jobs SET state='done', lease_until=0, updated_at=? WHERE id=?"
    ).bind(now, job_id))
    await env.DB.batch(stmts)
    row = await _first(env,
        "SELECT turn_id FROM conversations WHERE user=? AND unit=?", user, unit)
    return row is not None and row["turn_id"] is None


# ── proactive draw ────────────────────────────────────────────────────────


async def proactive_tick(env, user: str, unit: str, contact: dict,
                         now: int, tz: int) -> int:
    """One draw; enqueues a proactive send job on hit. Returns next tick ms.

    Quota is success-based: in-flight proactive jobs count as reservations, so a
    failed send refunds automatically and a broken chain cannot burn the day."""
    conv = await load(env, user, unit, now)
    st = status(contact, conv, user, unit, now, tz)
    date = life.day_stamp(now, tz)
    if conv["proactive_date"] != date:
        await env.DB.prepare(
            "UPDATE conversations SET proactive_sent=0, proactive_date=?, updated_at=? "
            "WHERE user=? AND unit=?").bind(date, now, user, unit).run()
    at = int(conv["engagement_at"] or now)
    engine = float(conv["engagement"] or 0.15) * (0.9997 ** (max(0, now - at) / 60_000.0))
    await env.DB.prepare(
        "UPDATE conversations SET engagement=?, engagement_at=?, updated_at=? "
        "WHERE user=? AND unit=?").bind(engine, now, now, user, unit).run()
    if st == "offline":
        return now + TICK_MS
    last = await last_text(env, user, unit)
    if last and last["role"] == "me":
        return now + TICK_MS
    span = await _first(env,
        "SELECT COALESCE(MAX(CASE WHEN role='me' THEN t END),0) AS user_t, "
        "MIN(CASE WHEN role='ai' THEN t END) AS ai_t FROM messages "
        "WHERE user=? AND unit=? AND kind='text'", user, unit)
    user_t = int(span["user_t"] or 0)
    anchor = user_t or int(span["ai_t"] or 0)
    if anchor and now - anchor >= 21 * 86_400_000:
        return now + TICK_MS
    unans = int((await _first(env,
        "SELECT COUNT(*) AS n FROM jobs WHERE user=? AND unit=? AND kind='proactive' "
        "AND state='done' AND updated_at>?", user, unit, user_t))["n"])
    last_ai = await last_ai_t(env, user, unit)
    seed = int(conv["proactive_last_at"] or 0) or 1
    if last_ai and now - last_ai < cloud_npc.proactive_gap_ms(unans, seed):
        return now + TICK_MS
    busy = await _first(env,
        "SELECT 1 AS x FROM jobs WHERE user=? AND unit=? AND kind IN ('reply','burst') "
        "AND state IN ('pending','leased') LIMIT 1", user, unit)
    if busy:
        return now + TICK_MS
    sent = int(conv["proactive_sent"] or 0) if conv["proactive_date"] == date else 0
    inflight = int((await _first(env,
        "SELECT COUNT(*) AS n FROM jobs WHERE user=? AND unit=? AND kind='proactive' "
        "AND state IN ('pending','leased')", user, unit))["n"])
    if cloud_npc.pick_proactive(contact, {"date": date, "sent": sent + inflight},
                                engine, now / 1000, slot_minutes=5):
        seq = sent + inflight + 1
        await enqueue(env, user, unit, "proactive", now,
                      f"proactive:{user}:{unit}:{date}:{seq}",
                      {"seq": seq, "unans": unans}, now)
    return now + TICK_MS


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


async def bump_push_attempts(env, user: str, unit: str, now: int) -> None:
    await env.DB.prepare(
        "UPDATE messages SET push_attempts=push_attempts+1 WHERE user=? AND unit=? "
        "AND pushed_at IS NULL AND role='ai' AND kind='text' AND hidden=0"
    ).bind(user, unit).run()
    await env.DB.prepare(
        "UPDATE messages SET pushed_at=? WHERE user=? AND unit=? AND pushed_at IS NULL "
        "AND push_attempts>=5").bind(now, user, unit).run()


async def bump_engagement(env, user: str, unit: str, now: int, warm: bool) -> None:
    await ensure(env, user, unit, now)
    await env.DB.prepare(
        "UPDATE conversations SET engagement=MIN(1,engagement+?), engagement_at=?, "
        "updated_at=? WHERE user=? AND unit=?"
    ).bind(0.3 if warm else 0.2, now, now, user, unit).run()


async def reset(env, user: str, unit: str, now: int) -> None:
    await env.DB.prepare("DELETE FROM messages WHERE user=? AND unit=?").bind(user, unit).run()
    await env.DB.prepare("DELETE FROM jobs WHERE user=? AND unit=?").bind(user, unit).run()
    await env.DB.prepare(
        "UPDATE conversations SET npc_read_seq=0, user_seen_seq=0, reply_due_at=NULL, "
        "turn_id=NULL, turn_expires_at=0, turn_kind=NULL, glow_until=0, burst_left=0, "
        "proactive_sent=0, proactive_last_at=0, updated_at=? WHERE user=? AND unit=?"
    ).bind(now, user, unit).run()
