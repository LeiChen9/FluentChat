"""Persona 的自主时间线：他的一天从哪来、怎么走、怎么进 prompt。

分工：cloud_npc 管「什么时候主动开口」（抽签账本），本模块管「他此刻在
过什么日子」（内容状态源）。状态存 R2 {user}/life/{unit}.json，每人一份，
和历史镜像同一约定。纯 stdlib，不碰 workers / 模型 —— 生成他的一天由
worker 拿本模块拼好的 messages 去调链。

状态位形：
{"day": {"date": "YYYY-MM-DD", "events": [...], "attempted": ms},
 "energy": 0.0-1.0, "energy_at": ms,
 "threads": [...], "ledger": [...], "digest": "..."}
"""

import json
import re
from datetime import datetime, timedelta, timezone

from backend.prompt_data import PROMPTS
from backend.time_context import DEFAULT_TZ_OFFSET

# 作息基调 → 能量目标（active 手边有劲，offline 基本没电）
STATE_ENERGY = {"active": 0.68, "away": 0.45, "busy": 0.3, "offline": 0.12}
STATE_PHRASE = {
    "active": "in the middle of it, phone in hand",
    "away": "around but not glued to the phone",
    "busy": "busy with your own thing",
    "offline": "off your feet, nearly asleep",
}

ENERGY_HALF_MIN = 90.0   # 能量向目标靠拢的半衰期（分钟）
MAX_EVENTS = 3
MAX_THREADS = 6
MAX_LEDGER = 12
MAX_DIGEST = 900
RETRY_MS = 30 * 60 * 1000  # 日界生成失败后 30 分钟内不重试


def _local(now_ms: float, tz_offset: int) -> datetime:
    return datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc) - timedelta(minutes=tz_offset)


def day_stamp(now_ms: float, tz_offset: int = DEFAULT_TZ_OFFSET) -> str:
    return _local(now_ms, tz_offset).strftime("%Y-%m-%d")


def part_of_day(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 18:
        return "afternoon"
    if 18 <= hour < 23:
        return "evening"
    return "night"


def schedule_state(contact: dict, now_ms: float, tz_offset: int = DEFAULT_TZ_OFFSET) -> str:
    """当前基调（active/away/busy/offline）。真源是 contact.json 的 hours 表。"""
    dt = _local(now_ms, tz_offset)
    off = dt.weekday() >= 5 or dt.strftime("%Y-%m-%d") in (contact.get("holidays") or [])
    hours = contact.get("hoursWeekend" if off else "hours") or contact.get("hours") or []
    if len(hours) == 24 and hours[dt.hour] in STATE_ENERGY:
        return hours[dt.hour]
    return "active"


def energy_target(contact: dict, now_ms: float, tz_offset: int = DEFAULT_TZ_OFFSET) -> float:
    return STATE_ENERGY[schedule_state(contact, now_ms, tz_offset)]


def default_life() -> dict:
    return {"day": {}, "energy": None, "energy_at": 0,
            "threads": [], "ledger": [], "digest": ""}


def _int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _num(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0.0, min(1.0, float(value)))
    return None


def _strs(value, cap: int, width: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        s = str(item or "").strip()[:width]
        if s and s not in out:
            out.append(s)
    return out[:cap]


def normalize(raw) -> dict:
    """坏数据一律降级成空册的对应字段，不抛。"""
    life = default_life()
    if not isinstance(raw, dict):
        return life
    day = raw.get("day") if isinstance(raw.get("day"), dict) else {}
    life["day"] = {
        "date": str(day.get("date") or ""),
        "events": _strs(day.get("events"), MAX_EVENTS, 180),
        "attempted": _int(day.get("attempted")),
    }
    energy = _num(raw.get("energy"))
    if energy is not None:
        life["energy"] = energy
    life["energy_at"] = _int(raw.get("energy_at"))
    life["threads"] = _strs(raw.get("threads"), MAX_THREADS, 180)
    life["ledger"] = _strs(raw.get("ledger"), MAX_LEDGER, 180)
    life["digest"] = str(raw.get("digest") or "").strip()[:MAX_DIGEST]
    return life


async def load(env, user: str, unit: str) -> dict:
    try:
        obj = await env.DATA.get(f"{user}/life/{unit}.json")
        return normalize(json.loads(await obj.text()) if obj is not None else {})
    except Exception as e:
        print(f"[life] {user}/{unit} read failed: {type(e).__name__}: {e}")
        return default_life()


async def save(env, user: str, unit: str, life: dict) -> None:
    await env.DATA.put(f"{user}/life/{unit}.json",
                       json.dumps(normalize(life), ensure_ascii=False))


def settle(life: dict, contact: dict, now_ms: float,
           tz_offset: int = DEFAULT_TZ_OFFSET) -> dict:
    """把能量按经过时间推向当前作息目标。纯计算，不写库、不调模型。"""
    life = normalize(life)
    target = energy_target(contact, now_ms, tz_offset)
    prev = life["energy"] if life["energy"] is not None else target
    at = life["energy_at"] or now_ms
    minutes = max(0.0, (now_ms - at) / 60000.0)
    k = 0.5 ** (minutes / ENERGY_HALF_MIN)
    life["energy"] = round(target + (prev - target) * k, 3)
    life["energy_at"] = int(now_ms)
    return life


def needs_day(life: dict, now_ms: float, tz_offset: int = DEFAULT_TZ_OFFSET) -> bool:
    """今天的一天还没生成过，且不在失败重试冷却里。"""
    life = normalize(life)
    if life["day"].get("date") == day_stamp(now_ms, tz_offset):
        return False
    return now_ms - (life["day"].get("attempted") or 0) >= RETRY_MS


def mark_attempt(life: dict, now_ms: float) -> dict:
    life = normalize(life)
    life["day"]["attempted"] = int(now_ms)
    return life


def _energy_word(energy) -> str:
    e = energy if energy is not None else 0.5
    if e < 0.25:
        return "running on empty"
    if e < 0.45:
        return "low"
    if e < 0.7:
        return "steady"
    return "wired"


def render(life: dict, contact: dict, now_ms: float,
           tz_offset: int = DEFAULT_TZ_OFFSET) -> str:
    """他此刻的状态块，直接拼进 system prompt。"""
    life = normalize(life)
    now = _local(now_ms, tz_offset)
    state = schedule_state(contact, now_ms, tz_offset)
    lines = [
        "# Your life right now",
        (f"It's {now.strftime('%A')} {part_of_day(now.hour)}, around "
         f"{now.strftime('%-I:%M %p')}. You're {STATE_PHRASE[state]}; "
         f"energy is {_energy_word(life['energy'])}."),
    ]
    events = life["day"].get("events") or []
    if events:
        lines.append("Today, on your side:")
        lines.extend(f"- {e}" for e in events)
    if life["threads"]:
        lines.append("On your mind:")
        lines.extend(f"- {t}" for t in life["threads"])
    if life["digest"]:
        lines.append(f"Between you two: {life['digest']}")
    lines.append("Speak from here, not about here.")
    return "\n".join(lines)


def _json_obj(raw: str) -> dict:
    s = (raw or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[A-Za-z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        obj = json.loads(s)
    except Exception:
        m = re.search(r"\{.*\}", s, re.S)
        try:
            obj = json.loads(m.group(0)) if m else {}
        except Exception:
            obj = {}
    return obj if isinstance(obj, dict) else {}


def parse_day(raw: str) -> dict:
    """解析日界生成结果；坏数据给空事件，绝不抛。"""
    obj = _json_obj(raw)
    return {
        "events": _strs(obj.get("events"), MAX_EVENTS, 180),
        "energy": _num(obj.get("energy")),
        "threads": _strs(obj.get("threads"), MAX_THREADS, 180),
        "digest": str(obj.get("digest") or "").strip()[:MAX_DIGEST],
    }


def apply_day(life: dict, day: dict, today: str, now_ms: float) -> dict:
    life = normalize(life)
    life["day"] = {"date": today, "events": list(day.get("events") or []),
                   "attempted": int(now_ms)}
    if day.get("energy") is not None:
        life["energy"] = day["energy"]
        life["energy_at"] = int(now_ms)
    if day.get("threads"):
        life["threads"] = list(day["threads"])[:MAX_THREADS]
    life["ledger"] = (life["ledger"] + list(day.get("events") or []))[-MAX_LEDGER:]
    if day.get("digest"):
        life["digest"] = day["digest"]
    return life


def apply_chat(life: dict, parsed: dict, now_ms: float) -> dict:
    """聊天返回的 state delta 写回：能量 + 一条值得记住的线索。"""
    life = normalize(life)
    energy = _num((parsed or {}).get("energy"))
    if energy is not None:
        life["energy"] = energy
        life["energy_at"] = int(now_ms)
    thread = str((parsed or {}).get("thread") or "").strip()[:180]
    if thread and thread not in life["threads"]:
        life["threads"] = (life["threads"] + [thread])[-MAX_THREADS:]
    return life


def day_messages(unit: str, contact: dict, life: dict, history: list[dict],
                 now_ms: float, tz_offset: int = DEFAULT_TZ_OFFSET) -> list[dict]:
    """日界生成用的 messages：persona 底座 + 今天的事实 + 最近的对话。"""
    life = normalize(life)
    now = _local(now_ms, tz_offset)
    state = schedule_state(contact, now_ms, tz_offset)
    used = "\n".join(f"- {x}" for x in life["ledger"][-MAX_LEDGER:]) or "(nothing yet)"
    chat = "\n".join(
        f"{'user' if h.get('who') == 'me' else 'you'}: {str(h.get('text') or '')[:200]}"
        for h in (history or [])[-12:]) or "(no recent messages)"
    sys_text = "\n\n".join([
        PROMPTS[unit],
        PROMPTS["day_plan"],
        "# Context",
        (f"Now: {now.strftime('%A')} {part_of_day(now.hour)}, "
         f"{now.strftime('%B')} {now.day}, {now.year}. Schedule: {state}."),
        f"Recent material already used (continue it only if something actually moved):\n{used}",
        f"Your memory of this friendship:\n{life['digest'] or '(still early)'}",
        f"Recent messages:\n{chat}",
    ])
    return [{"role": "system", "content": sys_text},
            {"role": "user", "content": "(Write today's JSON.)"}]
