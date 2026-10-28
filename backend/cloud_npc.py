"""云端 NPC 账本与抽签：前端 proactive.js 的离线对应层（纯逻辑，不碰链路）。

分工：前端页开着时浏览器每分钟抽签（localStorage 账本）；页面关闭（心跳停）
即由 scheduled cron 每 5 分钟来撞这里。云册合一份 state.json：
{"lastSeen": 毫秒, "ledger": {persona_id: {date, sent, lastAt}}}。

与浏览器账本不同册：云册只在离线期记账，两册各倒各的名额 —— 一天的总主动
频率可能高于浏览器单册（可接受，dev_log 有记）。作息真源仍是 contact.json
（与浏览器同一份），cron 从 ASSETS 拉取。

数字语义与 proactive.js 逐条对齐（perDay/engagement/windows/offline 不发）。
"""

import json
import random
import time

# 心跳超过这个时长没收到的用户才算离线（cron 才接手代打）
OFFLINE_MS = 7 * 60_000
# 云册慢衰减：浏览器每分钟 ×0.9997（半衰 ~19h）；cron 5 分钟一步按
# 0.9997**5 ≈ 0.9985 折算，量级一致
ENG_DECAY = 0.9985
ENG_DEFAULT = 0.15
# 服务器按 UTC 走：天账本与小时窗口全换算成东八区（用户盘子），别让 UTC
# 错位一天。浏览器用设备本地时区，两边日界差最多 8 小时，可接受。
CST = 8 * 3600


def now_ms() -> int:
    return int(time.time() * 1000)


def day_stamp(now: float) -> str:
    t = time.gmtime(now + CST)
    return f"{t.tm_year}-{t.tm_mon:02d}-{t.tm_mday:02d}"


def minutes_left_cst(windows, now: float) -> int:
    """windows [[from,to]] 期望小时（24=当日封口）。返回当前时刻还剩多少
    可抽分钟；不在任何窗内为 0。窗口坏数据照浏览器 normWindows 一样跳过。"""
    t = time.gmtime(now + CST)
    m = t.tm_hour * 60 + t.tm_min
    total = 0
    for w in windows or []:
        try:
            a, b = round(w[0] * 60), min(1440, round(w[1] * 60))
        except (TypeError, ValueError, IndexError):
            continue
        if 0 <= a < b and a <= m < b:
            total += b - m
    return total


def pick_proactive(contact: dict, led: dict, eng: float, now: float,
                   force: bool = False, slot_minutes: int = 5) -> bool:
    """这一 tick 该不该开口。led 为该 persona 云册账本（缺= {"date", "sent"}），
    命中与否由调用方记账 —— 账本读写留编排层，这里纯判定。

    与浏览器差一档：浏览器分钟粒度，剩余「可抽分钟数」≈ 剩余格数；cron
    5 分钟一格，把剩余分钟折成 5 分钟格再抽，撞中率才与撒匀语义对得上。

    force=True 跳过随机格抽（要求仍在窗内、仍有名额才 True），给自检
    路由用；定时调度永远 False。"""
    s = contact.get("proactive")
    if not isinstance(s, dict) or not isinstance(led, dict):
        return False
    # 基调 offline 直接哑（浏览器有邻档漂移云侧不模拟，只看 hours 表）
    import datetime as _dt
    _cst = _dt.datetime.utcfromtimestamp(now + CST)
    _day = _cst.weekday()  # 0=Mon..6=Sun
    _is_off = _day >= 5
    hours = contact.get("hoursWeekend" if _is_off else "hours") or contact.get("hours") or []
    if len(hours) != 24:
        hours = contact.get("hours") or []
    if len(hours) == 24 and hours[_cst.hour] == "offline":
        return False
    if led.get("date") != day_stamp(now):
        led = {"date": day_stamp(now), "sent": 0}
    left = minutes_left_cst(s.get("windows"), now)
    if left <= 0:
        return False
    per_day = s.get("perDay")
    span_ok = (isinstance(per_day, list) and len(per_day) == 2
               and all(isinstance(x, (int, float)) for x in per_day))
    lo, hi = (per_day[0], per_day[1]) if span_ok else (1, 1)
    rem = round(lo + max(0.0, min(1.0, eng)) * max(0.0, hi - lo)) - int(led.get("sent") or 0)
    if rem <= 0:
        return False
    if force:
        return True
    slots = max(1, left // max(1, int(slot_minutes)))
    return random.random() < min(1.0, rem / slots)


async def load_state(env, user: str) -> dict:
    """云册读取；坏页/缺页一律当空册（谁存谁负责保证 json 合法）。"""
    try:
        obj = await env.DATA.get(f"{user}/state.json")
        data = json.loads(await obj.text()) if obj is not None else {}
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[cron] state.json {user} read failed: {type(e).__name__}: {e}")
        return {}


async def save_state(env, user: str, state: dict) -> None:
    await env.DATA.put(f"{user}/state.json", json.dumps(state, ensure_ascii=False))
