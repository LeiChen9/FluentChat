"""云端 NPC 账本与抽签：前端 proactive.js 的离线对应层（纯逻辑，不碰链路）。

分工：前端页开着时浏览器每分钟抽签（localStorage 账本）；页面关闭（心跳停）
即由 scheduled cron 每 5 分钟来撞这里。云册合一份 state.json：
{"lastSeen": 毫秒, "ledger": {persona_id: {date, sent, lastAt}},
 "activeTurn": {persona_id: [bid, 认领毫秒]}}。

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


def _max_map(a, b):
    """两张 per-unit 数值表按取大合并（水位只进不退）。"""
    out = {}
    for src in (a, b):
        if isinstance(src, dict):
            for k, v in src.items():
                if isinstance(v, (int, float)) and v > out.get(k, float("-inf")):
                    out[k] = v
    return out


def _ledger_merge(a, b):
    """代打台账按日合并：date 新者赢；同日 sent 取大（配额只紧不松）。"""
    if not isinstance(a, dict):
        return b if isinstance(b, dict) else None
    if not isinstance(b, dict):
        return a
    out = dict(a)
    for unit, led in b.items():
        old = out.get(unit)
        if not (isinstance(old, dict) and isinstance(led, dict)):
            out[unit] = led
            continue
        da, db = str(old.get("date") or ""), str(led.get("date") or "")
        if db > da:
            out[unit] = led
        elif db == da:
            out[unit] = {**old, **led,
                          "sent": max(int(led.get("sent") or 0), int(old.get("sent") or 0))}
    return out


def _turn_merge(a, b):
    """活动回合账按 unit 取新：同一线并发写只保留认领毫秒更大的在途 bid。

    一条会话只认一个活动回合（latest-state / single-turn），谁后认领谁有
    权落库；旧回合的迟到结果由调用方判活动后丢弃，绝不双写。"""
    out = dict(a) if isinstance(a, dict) else {}
    if isinstance(b, dict):
        for unit, rec in b.items():
            old = out.get(unit)
            new_at = rec[1] if isinstance(rec, list) and len(rec) > 1 else 0
            old_at = old[1] if isinstance(old, list) and len(old) > 1 else -1
            if not (isinstance(old, list) and old_at >= new_at):
                out[unit] = rec
    return out or None


async def save_state(env, user: str, state: dict) -> None:
    """单调合并写：落盘前把盘上册重读回来并成一份。

    R2 没有 CAS，读改写有四路人马（ping/away、/chat 预写、hist/seen、
    两个 cron sweep）在并发——旧快照整册覆盖会把别人刚写的字段回滚掉：
    lastSeen 被滚旧 → 在线误判离线 → 已读消息又被推，就是这条。合并规则：
      lastAi/notified 按 unit 取 max；devices 按设备字段取新时间戳；
      ledger 按日取新（同日 sent 取大）；eng/notif 与未知键取本次值，
      盘上独有的键保留。剩余交错窗口只剩 put 之间几毫秒，且下次写入自愈。"""
    try:
        obj = await env.DATA.get(f"{user}/state.json")
        disk = json.loads(await obj.text()) if obj is not None else None
    except Exception:
        disk = None
    if not isinstance(disk, dict) or disk is state:
        await env.DATA.put(f"{user}/state.json", json.dumps(state, ensure_ascii=False))
        return

    merged = {**disk, **state}
    for key in ("lastAi", "notified"):
        m = _max_map(disk.get(key), state.get(key))
        if m:
            merged[key] = m
        else:
            merged.pop(key, None)
    da, db = disk.get("devices"), state.get("devices")
    if isinstance(da, dict) or isinstance(db, dict):
        devs = dict(da) if isinstance(da, dict) else {}
        for dev, rec in (db or {}).items():
            old = devs.get(dev)
            if isinstance(old, dict) and isinstance(rec, dict):
                rec = {**old, **{k: v for k, v in rec.items()
                                 if not isinstance(old.get(k), (int, float))
                                 or not isinstance(v, (int, float)) or v >= old.get(k)}}
            devs[dev] = rec
        merged["devices"] = devs
    led = _ledger_merge(disk.get("ledger"), state.get("ledger"))
    if led:
        merged["ledger"] = led
    at = _turn_merge(disk.get("activeTurn"), state.get("activeTurn"))
    if at:
        merged["activeTurn"] = at
    await env.DATA.put(f"{user}/state.json", json.dumps(merged, ensure_ascii=False))
