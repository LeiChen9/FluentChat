"""Moments feed: global canon + per-user overlay.

Canon is shared by every user. Echo/user rows and all reactions are scoped by
user and must never leak across accounts.
"""

import json
import random
import re
import time
import uuid

from backend import convo, life
from backend.config import NAMES
from backend.moment_data import STYLE, next_beat
from backend.prompt_data import PROMPTS

DEFAULT_LIMIT = 20
MAX_LIMIT = 50
CANON_WINDOW_MS = 28 * 86400_000
COMMENT_COOLDOWN_MS = 3 * 86400_000
ECHO_COOLDOWN_MS = 14 * 86400_000
ECHO_WEEK_MS = 7 * 86400_000
USER_UNIT = "me"

TRAITS = {
    "persona-leo": {"see": 0.9, "react": 0.55, "comment": 0.42},
    "persona-chole": {"see": 0.6, "react": 0.35, "comment": 0.48},
    "persona-sam": {"see": 0.35, "react": 0.18, "comment": 0.35},
    "persona-Fiona": {"see": 0.55, "react": 0.28, "comment": 0.5},
}

BAD_COMMENT = (
    "proud of you", "you inspire", "you're amazing", "you are amazing",
    "so happy for you", "you're doing great", "you are doing great",
)

SEED = (
    ("canon:persona-leo:seed-1", "persona-leo", "Runner-up today! Sold every last cup before 2pm 🔥", 2),
    ("canon:persona-chole:seed-1", "persona-chole", "Found a shopping list tucked inside a secondhand novel. Keeping it, obviously.", 4),
    ("canon:persona-sam:seed-1", "persona-sam", "One bass, two hours of patience. Worth it.", 7),
    ("canon:persona-Fiona:seed-1", "persona-Fiona", "A good class starts with one sentence.", 10),
)


def now_ms() -> int:
    return int(time.time() * 1000)


def _week_key(now: int) -> str:
    return time.strftime("%Y-%W", time.gmtime(now / 1000))


def reaction_delay_ms(unit: str) -> int:
    lo, hi = {
        "persona-leo": (8, 45),
        "persona-chole": (25, 120),
        "persona-sam": (45, 180),
        "persona-Fiona": (20, 90),
    }.get(unit, (20, 120))
    return random.randint(lo, hi) * 60_000


def _text(value, cap: int = 500) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())[:cap]


def _parse_text(raw: str) -> str:
    s = (raw or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[A-Za-z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            s = str(obj.get("text") or "")
    except Exception:
        m = re.search(r"\{.*\}", s, re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
                if isinstance(obj, dict):
                    s = str(obj.get("text") or "")
            except Exception:
                pass
    return _text(s)


def _looks_bad(text: str) -> bool:
    low = text.lower()
    return not text or any(x in low for x in BAD_COMMENT)


async def _chain(messages: list[dict]) -> str:
    from backend.common import run_chain
    out = await run_chain(messages)
    return str((out or {}).get("content") or "")


async def ensure_seed(env, now: int | None = None) -> None:
    row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM moment_posts WHERE scope='canon'").first()
    if row and int(row["n"] or 0):
        return
    now = now or now_ms()
    for post_id, unit, text, days in SEED:
        await env.DB.prepare(
            "INSERT INTO moment_posts(id,scope,user,unit,kind,text,published_at) "
            "VALUES(?, 'canon', '', ?, 'life', ?, ?) "
            "ON CONFLICT(id) DO NOTHING"
        ).bind(post_id, unit, text, now - days * 86400_000).run()


async def _reactions(env, user: str, ids: list[str]) -> dict:
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    rows = await env.DB.prepare(
        "SELECT id,moment_id,actor,kind,text,parent_id,created_at "
        f"FROM moment_reactions WHERE user=? AND moment_id IN ({marks}) "
        "ORDER BY created_at"
    ).bind(user, *ids).all()
    out = {}
    for r in rows.results:
        out.setdefault(r["moment_id"], []).append(dict(r))
    return out


async def feed(env, user: str, before: int = 0, limit: int = DEFAULT_LIMIT) -> list[dict]:
    now = now_ms()
    await ensure_seed(env, now)
    limit = min(MAX_LIMIT, max(1, int(limit or DEFAULT_LIMIT)))
    before = max(0, int(before or 0))
    rows = await env.DB.prepare(
        "SELECT id,scope,unit,kind,text,published_at FROM moment_posts "
        "WHERE published_at<=? "
        "AND ((scope='canon' AND published_at>=?) OR (user=? AND scope IN ('echo','user'))) "
        "AND (?=0 OR published_at<?) "
        "ORDER BY published_at DESC LIMIT ?"
    ).bind(now, now - CANON_WINDOW_MS, user, before, before, limit).all()
    items = [dict(r) for r in rows.results]
    reacts = await _reactions(env, user, [r["id"] for r in items])
    for item in items:
        rs = reacts.get(item["id"], [])
        item["reactions"] = rs
        item["liked"] = any(r["kind"] == "like" and r["actor"] == "me" for r in rs)
    return items


async def canon_context(env, unit: str, limit: int = 3) -> str:
    rows = await env.DB.prepare(
        "SELECT text FROM moment_posts WHERE scope='canon' AND unit=? "
        "AND published_at<=? ORDER BY published_at DESC LIMIT ?"
    ).bind(unit, now_ms(), limit).all()
    texts = [str(r["text"]) for r in rows.results]
    if not texts:
        return ""
    return ("# Your recent public Moments\n"
            + "\n".join(f"- {t}" for t in texts)
            + "\nThese are public facts about your own life. Do not contradict them.")


async def visible_post(env, moment_id: str, user: str):
    return await env.DB.prepare(
        "SELECT * FROM moment_posts WHERE id=? AND (scope='canon' OR user=?)"
    ).bind(moment_id, user).first()


async def create_post(env, user: str, text: str) -> dict | None:
    clean = _text(text)
    if not clean:
        return None
    now = now_ms()
    post_id = f"user:{user}:{uuid.uuid4().hex}"
    await env.DB.prepare(
        "INSERT INTO moment_posts(id,scope,user,unit,kind,text,published_at) "
        "VALUES(?, 'user', ?, 'me', 'user', ?, ?)"
    ).bind(post_id, user, clean, now).run()
    return {"id": post_id, "scope": "user", "unit": USER_UNIT,
            "kind": "user", "text": clean, "published_at": now}


async def toggle_like(env, user: str, moment_id: str) -> bool | None:
    if not await visible_post(env, moment_id, user):
        return None
    row = await env.DB.prepare(
        "SELECT id FROM moment_reactions WHERE moment_id=? AND user=? "
        "AND actor='me' AND kind='like'").bind(moment_id, user).first()
    if row:
        await env.DB.prepare("DELETE FROM moment_reactions WHERE id=?").bind(row["id"]).run()
        return False
    await env.DB.prepare(
        "INSERT OR IGNORE INTO moment_reactions(moment_id,user,actor,kind,created_at) "
        "VALUES(?,?,'me','like',?)").bind(moment_id, user, now_ms()).run()
    return True


async def add_comment(env, user: str, moment_id: str, text: str,
                      parent_id: int | None = None) -> dict | None:
    clean = _text(text, 500)
    if not clean or not await visible_post(env, moment_id, user):
        return None
    now = now_ms()
    row = await env.DB.prepare(
        "INSERT INTO moment_reactions(moment_id,user,actor,kind,text,parent_id,created_at) "
        "VALUES(?,?,'me','comment',?,?,?) RETURNING id"
    ).bind(moment_id, user, clean, parent_id, now).first()
    return {"id": int(row["id"]) if row else 0, "moment_id": moment_id,
            "actor": "me", "kind": "comment", "text": clean,
            "parent_id": parent_id, "created_at": now}


async def relationship(env, user: str, unit: str) -> dict:
    row = await env.DB.prepare(
        "SELECT * FROM moment_relationship WHERE user=? AND unit=?").bind(user, unit).first()
    if row is None:
        await env.DB.prepare(
            "INSERT INTO moment_relationship(user,unit) VALUES(?,?) "
            "ON CONFLICT(user,unit) DO NOTHING").bind(user, unit).run()
        row = await env.DB.prepare(
            "SELECT * FROM moment_relationship WHERE user=? AND unit=?").bind(user, unit).first()
    return dict(row or {"user": user, "unit": unit, "closeness": 0.1,
                        "last_echo_at": 0, "last_comment_at": 0,
                        "weekly_comments": 0, "week_start": ""})


async def _refresh_closeness(env, user: str, unit: str) -> float:
    rel = await relationship(env, user, unit)
    row = await env.DB.prepare(
        "SELECT "
        "SUM(CASE WHEN kind='text' THEN 1 ELSE 0 END) AS texts, "
        "SUM(CASE WHEN kind='call' THEN 1 ELSE 0 END) AS calls "
        "FROM messages WHERE user=? AND unit=?").bind(user, unit).first()
    texts = int(row["texts"] or 0) if row else 0
    calls = int(row["calls"] or 0) if row else 0
    score = min(0.95, 0.1 + min(0.55, texts / 300) + min(0.3, calls / 8))
    if abs(score - float(rel["closeness"] or 0)) >= 0.01:
        await env.DB.prepare(
            "UPDATE moment_relationship SET closeness=? WHERE user=? AND unit=?"
        ).bind(score, user, unit).run()
    return score


async def _can_comment(env, user: str, unit: str, now: int) -> bool:
    rel = await relationship(env, user, unit)
    if now - int(rel["last_comment_at"] or 0) < COMMENT_COOLDOWN_MS:
        return False
    week = _week_key(now)
    weekly = int(rel["weekly_comments"] or 0) if rel["week_start"] == week else 0
    return weekly < 2


async def _touch_comment(env, user: str, unit: str, now: int) -> None:
    rel = await relationship(env, user, unit)
    week = _week_key(now)
    weekly = int(rel["weekly_comments"] or 0) if rel["week_start"] == week else 0
    await env.DB.prepare(
        "UPDATE moment_relationship SET last_comment_at=?, weekly_comments=?, week_start=? "
        "WHERE user=? AND unit=?").bind(now, weekly + 1, week, user, unit).run()


def _system(unit: str, prompt: str, lines: list[str]) -> list[dict]:
    text = "\n\n".join([PROMPTS[prompt], f"# Persona\n{NAMES.get(unit, unit)}",
                        f"# Voice\n{STYLE.get(unit, '')}", *lines])
    return [{"role": "system", "content": text},
            {"role": "user", "content": "(Write the JSON.)"}]


async def generate_reaction(env, unit: str, post_text: str,
                            comment_text: str = "") -> str:
    lines = [f"# The post\n{_text(post_text, 700)}"]
    if comment_text:
        lines.append(f"# Your friend's comment\n{_text(comment_text, 400)}")
    try:
        raw = await _chain(_system(unit, "moment_reaction", lines))
    except Exception as e:
        print(f"[moment] reaction {unit} failed: {type(e).__name__}: {str(e)[:120]}")
        return ""
    text = _parse_text(raw)
    return "" if _looks_bad(text) else text[:240]


async def react_to_post(env, user: str, unit: str, moment_id: str,
                        contact: dict, tz: int) -> None:
    post = await visible_post(env, moment_id, user)
    if not post or post["scope"] != "user" or post["user"] != user:
        return
    now = now_ms()
    existing = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM moment_reactions WHERE moment_id=? AND user=? "
        "AND actor=? AND kind IN ('like','comment')").bind(moment_id, user, unit).first()
    if existing and int(existing["n"] or 0):
        return
    total = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM moment_reactions WHERE moment_id=? AND user=? "
        "AND actor LIKE 'persona-%' AND kind IN ('like','comment')").bind(moment_id, user).first()
    if total and int(total["n"] or 0) >= 2:
        return
    if life.schedule_state(contact, now, tz) == "offline":
        return
    traits = TRAITS.get(unit) or {"see": 0.4, "react": 0.25, "comment": 0.4}
    closeness = await _refresh_closeness(env, user, unit)
    if random.random() > traits["see"] * (0.35 + 0.65 * closeness):
        return
    if random.random() > traits["react"] * (0.35 + 0.65 * closeness):
        return
    if random.random() < traits["comment"] and await _can_comment(env, user, unit, now):
        text = await generate_reaction(env, unit, post["text"])
        if text:
            await env.DB.prepare(
                "INSERT INTO moment_reactions(moment_id,user,actor,kind,text,created_at) "
                "VALUES(?,?,?,'comment',?,?)").bind(moment_id, user, unit, text, now).run()
            await _touch_comment(env, user, unit, now)
            return
    await env.DB.prepare(
        "INSERT OR IGNORE INTO moment_reactions(moment_id,user,actor,kind,created_at) "
        "VALUES(?,?,?,'like',?)").bind(moment_id, user, unit, now).run()


async def reply_to_comment(env, user: str, unit: str, moment_id: str,
                           parent_id: int, comment_text: str,
                           contact: dict, tz: int) -> None:
    post = await visible_post(env, moment_id, user)
    if not post or (post["unit"] != unit and post["scope"] != "user"):
        return
    now = now_ms()
    if life.schedule_state(contact, now, tz) == "offline":
        return
    if not await _can_comment(env, user, unit, now):
        return
    text = await generate_reaction(env, unit, post["text"], comment_text)
    if not text:
        return
    await env.DB.prepare(
        "INSERT INTO moment_reactions(moment_id,user,actor,kind,text,parent_id,created_at) "
        "VALUES(?,?,?,'comment',?,?,?)").bind(
            moment_id, user, unit, text, parent_id, now).run()
    await _touch_comment(env, user, unit, now)


async def schedule_echo(env, user: str, unit: str, now: int | None = None) -> None:
    now = now or now_ms()
    rel = await relationship(env, user, unit)
    if now - int(rel["last_echo_at"] or 0) < ECHO_COOLDOWN_MS:
        return
    recent = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM moment_posts WHERE user=? AND scope='echo' "
        "AND published_at>=?").bind(user, now - ECHO_WEEK_MS).first()
    if recent and int(recent["n"] or 0):
        return
    pending = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE user=? AND unit=? AND kind='moment_echo' "
        "AND state IN ('pending','leased')").bind(user, unit).first()
    if pending and int(pending["n"] or 0):
        return
    due = now + random.randint(2, 7) * 86400_000
    await convo.enqueue(env, user, unit, "moment_echo", due,
                        f"mecho:{user}:{unit}:{now // 86400_000}", now=now)


async def generate_echo(env, user: str, unit: str) -> None:
    now = now_ms()
    rel = await relationship(env, user, unit)
    if now - int(rel["last_echo_at"] or 0) < ECHO_COOLDOWN_MS:
        return
    recent = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM moment_posts WHERE user=? AND scope='echo' "
        "AND published_at>=?").bind(user, now - ECHO_WEEK_MS).first()
    if recent and int(recent["n"] or 0):
        return
    lif = await life.load(env, user, unit)
    if not _text(lif.get("digest")):
        return
    rows = await convo.recent(env, user, unit, 10)
    chat = "\n".join(f"{'user' if r['role'] == 'me' else 'you'}: {_text(r['text'], 160)}"
                     for r in rows)
    lines = [f"# What is between you\n{_text(lif['digest'], 900)}",
             f"# Recent messages\n{chat or '(none)'}"]
    try:
        raw = await _chain(_system(unit, "moment_echo", lines))
    except Exception as e:
        print(f"[moment] echo {user}/{unit} failed: {type(e).__name__}: {str(e)[:120]}")
        return
    text = _parse_text(raw)
    if _looks_bad(text):
        return
    post_id = f"echo:{user}:{unit}:{uuid.uuid4().hex}"
    await env.DB.prepare(
        "INSERT INTO moment_posts(id,scope,user,unit,kind,text,published_at) "
        "VALUES(?, 'echo', ?, ?, 'echo', ?, ?)").bind(
            post_id, user, unit, text[:500], now).run()
    await env.DB.prepare(
        "UPDATE moment_relationship SET last_echo_at=? WHERE user=? AND unit=?"
    ).bind(now, user, unit).run()


async def generate_canon(env, now: int | None = None) -> int:
    now = now or now_ms()
    week = _week_key(now)
    made = 0
    for offset, unit in enumerate(sorted(NAMES)):
        used = await env.DB.prepare(
            "SELECT arc_id,beat FROM moment_posts WHERE scope='canon' AND unit=?"
        ).bind(unit).all()
        arc_id, beat, outline = next_beat(unit, [dict(r) for r in used.results])
        if not outline:
            continue
        try:
            raw = await _chain(_system(unit, "moment_canon", [f"# The beat\n{outline}"]))
        except Exception as e:
            print(f"[moment] canon {unit} failed: {type(e).__name__}: {str(e)[:120]}")
            continue
        text = _parse_text(raw)
        if not text or "user" in text.lower():
            continue
        post_id = f"canon:{unit}:{arc_id}:{beat}:{week}"
        await env.DB.prepare(
            "INSERT INTO moment_posts(id,scope,user,unit,kind,text,published_at,arc_id,beat,meta) "
            "VALUES(?, 'canon', '', ?, 'life', ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO NOTHING"
        ).bind(post_id, unit, text[:500], now + offset * 36 * 3600_000,
               arc_id, beat, json.dumps({"arc": arc_id, "beat": beat})).run()
        made += 1
    return made
