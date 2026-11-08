"""FluentChat backend: Gemini Live tokens, persona text chat, Web Push.

The message chain lives in D1 (backend/convo.py). A send only stores the user
message and schedules a reply; the server-side scheduler generates when the
persona is actually available. Offline personas do nothing: no read, no model
call, no push. The phone is a renderer, not a timing source."""

import json
import re
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint, fetch as js_fetch
from workers import wait_until
from workers.asgi import run_in_background
from backend import auth, cloud_npc, convo, life
from backend.common import (ENDPOINTS, _load_subs, _save_subs,
                            bind_worker_env, env_key, run_chain, vapid_pubkey)
from backend.prompt_data import PROMPTS
from backend.time_context import DEFAULT_TZ_OFFSET, build_time_context, clamp_tz
from backend.units import UNIT_META
from backend.config import (AUTH_TOKENS_URL, HEAVY_USERS_PER_TICK,
                            HIST_MAX_CHARS, HIST_MAX_ITEMS, MODEL, NAMES,
                            PERSONAS, SPLIT_CAPS, UNITS, VOICE, VOICE_BY_ID)


def to_messages(unit: str, history: list[dict], tz_offset: int = DEFAULT_TZ_OFFSET,
                life_state: dict | None = None,
                contact: dict | None = None) -> list[dict]:
    """NPC only: persona prompt + life + time sense; history as user/assistant."""
    ctx = build_time_context(history, tz_offset)
    sys_text = (_persona_system(unit, tz_offset, ctx['header'], life_state, contact)
                + "\n\n" + read_prompt('chat_json'))
    msgs = [{"role": "system", "content": sys_text}]
    if not history:
        msgs.append({"role": "user", "content": "(Wait for the user to start.)"})
        return msgs
    for h, dated in zip(history, ctx["history"]):
        prefix = f"{dated['prefix']} " if dated["prefix"] else ""
        msgs.append({"role": "user" if h["who"] == "me" else "assistant",
                     "content": prefix + h["text"]})
    return msgs


def read_prompt(name: str) -> str:
    return PROMPTS[name.removesuffix(".md")]


def _persona_system(unit: str, tz_offset: int, header: str,
                    life_state: dict | None, contact: dict | None) -> str:
    blocks = [read_prompt('text_style'), read_prompt(unit)]
    if life_state is not None:
        blocks.append(life.render(life_state, contact or {},
                                  cloud_npc.now_ms(), tz_offset))
    blocks.append(header)
    return "\n\n".join(blocks)


SENT_RE = re.compile(r"(?<=[.!?…])\s+")


def reply_bucket(energy) -> str:
    e = energy if isinstance(energy, (int, float)) and not isinstance(energy, bool) else 0.5
    if e < 0.4:
        return "short"
    if e < 0.7:
        return "medium"
    return "long"


def parse_chat(raw: str) -> dict:
    """Take reply/energy/thread from JSON; otherwise treat the raw text as reply."""
    s = raw.strip()
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
    reply = obj.get("reply") if isinstance(obj, dict) else None
    if not isinstance(reply, str) or not reply.strip():
        reply = "" if s.startswith("{") else raw.strip()
        return {"reply": reply, "energy": None, "thread": ""}
    energy = obj.get("energy")
    if not isinstance(energy, (int, float)) or isinstance(energy, bool):
        energy = None
    else:
        energy = max(0.0, min(1.0, float(energy)))
    return {"reply": reply.strip(), "energy": energy,
            "thread": str(obj.get("thread") or "").strip()}


def split_reply(unit: str, raw: str) -> list[str]:
    p = parse_chat(raw)
    if not p["reply"]:
        return []
    cap = SPLIT_CAPS.get(unit, {}).get(reply_bucket(p["energy"]), 2)
    parts = []
    for line in re.split(r"\n+", p["reply"]):
        heap = []
        for sentence in (x.strip() for x in SENT_RE.split(line.strip()) if x.strip()):
            heap.append(sentence)
            if len(heap) >= cap:
                parts.append(" ".join(heap))
                heap = []
        if heap:
            parts.append(" ".join(heap))
    if len(parts) > 3:
        parts = parts[:2] + [" ".join(parts[2:])]
    return parts


PRO_REQ = (
    "(Proactive turn. Nobody spoke just now: text me first like a friend would. "
    "Pick up whatever we talked about recently or something happening in your day "
    "right now. Approach it from a different angle than your previous proactive "
    "texts: share a slice of your day, wonder what I'm up to, or revisit an old "
    "topic with something new. Let the time since we last talked shape how you "
    "open. Keep it a quick text: usually a few words or one short sentence, two "
    "short sentences at most; a polished paragraph is not how friends text. "
    "Not a meta-greeting, don't mention that you haven't heard from me.)"
)
BURST_REQ = (
    "(Follow-up turn: you just texted and, like a real friend, you want to add one "
    "quick thing. 1-2 short casual lines. Don't start a big new topic.)"
)


async def _auth_route(fn, request) -> Response:
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return await fn(body)
    except auth.Bad as e:
        return Response.json({"error": e.detail}, status=e.status)


_SAFE_UNIT = re.compile(r"[A-Za-z0-9_-]{1,64}$")


def sanitize_history(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        who, text = item.get("who"), item.get("text")
        if who not in ("me", "ai") or not isinstance(text, str):
            continue
        text = text.strip()
        if not text:
            continue
        entry = {"who": who, "text": text[:HIST_MAX_CHARS]}
        ts = item.get("t")
        if isinstance(ts, (int, float)) and ts > 0:
            entry["t"] = int(ts)
        out.append(entry)
    return out[-HIST_MAX_ITEMS:]


def _rows_to_hist(rows: list) -> list[dict]:
    return [{"who": r["role"], "text": r["text"], "t": r["t"]} for r in rows]


def clean_call_turns(raw) -> list[dict]:
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        who, text = item.get("who"), item.get("text")
        if who not in ("me", "ai") or not isinstance(text, str):
            continue
        text = text.strip()[:500]
        if not text:
            continue
        out.append({"who": who, "text": text})
        if len(out) >= 60:
            break
    return out


def _review_json(text: str) -> dict:
    t = (text or "").strip()
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("模型没给出 JSON")
    return json.loads(t[a:b + 1], strict=False)


def clean_review(data) -> dict:
    if not isinstance(data, dict):
        raise ValueError("点评不是对象")

    def s(x, limit):
        return str(x).strip()[:limit] if isinstance(x, (str, int, float)) else ""

    def ls(x, limit=3, size=200):
        if not isinstance(x, list):
            return []
        return [s(i, size) for i in x if s(i, size)][:limit]

    lines = []
    for it in data.get("lines") or []:
        if not isinstance(it, dict):
            continue
        i, better, note = it.get("i"), s(it.get("better"), 300), s(it.get("note"), 200)
        if isinstance(i, int) and better:
            lines.append({"i": i, "better": better, "note": note})
    return {
        "overall": s(data.get("overall"), 500),
        "good": ls(data.get("good")),
        "improve": ls(data.get("improve")),
        "focus": ls(data.get("focus")),
        "lines": lines[:60],
    }


def call_review_messages(turns: list[dict]) -> list[dict]:
    lines = [
        f"[{i}] {'用户' if t['who'] == 'me' else 'NPC'}：{t['text']}"
        for i, t in enumerate(turns)
    ]
    return [
        {"role": "system", "content": read_prompt("call_review")},
        {"role": "user", "content": "# 通话转写\n" + "\n".join(lines)},
    ]


def build_system_instruction(
    unit: str, history: list[dict] | None = None,
    tz_offset: int = DEFAULT_TZ_OFFSET,
    life_state: dict | None = None, contact: dict | None = None,
    practice: bool = False,
) -> str:
    history = history or []
    base_name = "base-ch2.md" if unit in ("unit-07", "unit-08", "unit-09", "unit-10", "unit-11", "unit-12") else "base.md"
    if unit in PERSONAS:
        ctx = build_time_context(history, tz_offset)
        text = _persona_system(unit, tz_offset, ctx['header'], life_state, contact)
        dated = ctx["history"]
    else:
        parts = [read_prompt(base_name)]
        if practice:
            parts.append(read_prompt("practice_room"))
        parts.append(read_prompt(f"{unit}.md"))
        text = "\n\n".join(parts)
        dated = [{"who": h["who"], "text": h["text"], "prefix": ""} for h in history]
    if not history:
        return text
    speaker = {"me": "用户", "ai": "你"}
    lines = "\n".join(
        f"{d['prefix'] + ' ' if d['prefix'] else ''}{speaker[d['who']]}：{d['text']}"
        for d in dated
    )
    if unit in PERSONAS:
        return (
            f"{text}\n\n"
            "# 此前的对话记录\n"
            "这是你和该用户之前的聊天与通话记录（含语音通话的转写），"
            "按时间从早到晚，日期变化时标出：\n"
            f"{lines}"
        )
    return (
        f"{text}\n\n"
        "# 此前的对话记录\n"
        "这是你和该用户之前的聊天与通话记录（含语音通话的转写），"
        "按时间从早到晚：\n"
        f"{lines}\n\n"
        "用户这次回来是接着聊。收到唤醒输入后不要重说开场白、"
        "不要重新自我介绍，也不要再念【本次话题】里的开场白 —— "
        "用一两句自然接上上次聊到哪儿（或接着上次的问题），然后继续。"
    )


def build_token_payload(
    unit: str, history: list[dict] | None = None,
    tz_offset: int = DEFAULT_TZ_OFFSET,
    life_state: dict | None = None, contact: dict | None = None,
    practice: bool = False, voice: str | None = None,
) -> dict:
    return {
        "uses": 1,
        "bidiGenerateContentSetup": {
            "model": f"models/{MODEL}",
            "systemInstruction": {
                "parts": [
                    {"text": build_system_instruction(unit, history, tz_offset,
                                                      life_state, contact, practice)}
                ]
            },
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": voice or VOICE_BY_ID.get(unit, VOICE)
                        }
                    }
                },
            },
            "outputAudioTranscription": {},
            "inputAudioTranscription": {},
        },
    }


async def _contact(env, unit: str) -> dict | None:
    try:
        res = await env.ASSETS.fetch(
            f"https://assets.local/assets/contacts/{unit.removeprefix('persona-')}/contact.json")
        return await res.json() if res.ok else None
    except Exception:
        return None


async def _load_users(env) -> dict:
    try:
        obj = await env.DATA.get("users.json")
        users = json.loads(await obj.text()) if obj is not None else {}
    except Exception as e:
        print(f"[cron] users.json read failed: {type(e).__name__}: {e}")
        users = {}
    return users if isinstance(users, dict) else {}


async def _migrate(env, user: str) -> None:
    """One-time R2 hist -> D1 import. Runs only while the user has no rows."""
    pref = await convo.prefs(env, user)
    if pref["migrated"]:
        return
    if await convo.has_messages(env, user):
        await convo.set_migrated(env, user)
        return
    try:
        obj = await env.DATA.get(f"{user}/state.json")
        state = json.loads(await obj.text()) if obj is not None else {}
    except Exception:
        state = {}
    notified = state.get("notified") or {}
    if state.get("notif") in ("off", "ticker", "preview"):
        await convo.set_notif(env, user, state["notif"])
    ledger = state.get("ledger") if isinstance(state.get("ledger"), dict) else {}
    eng = state.get("eng") if isinstance(state.get("eng"), dict) else {}
    for unit in PERSONAS:
        try:
            obj = await env.DATA.get(f"{user}/hist/{unit}.json")
            hist = json.loads(await obj.text()) if obj is not None else []
        except Exception:
            continue
        rows = []
        for i, item in enumerate(hist if isinstance(hist, list) else []):
            if not isinstance(item, dict):
                continue
            who, t = item.get("who"), int(item.get("t") or 0)
            kind = item.get("kind") or ("transcript" if item.get("hidden") else "text")
            if kind == "call":
                dur = int(item.get("dur") or 0)
                text = f"{'Practice call' if item.get('practice') else 'Voice call'} · {dur // 60000}:{dur % 60000 // 1000:02d}"
                who = "me"
            else:
                text = str(item.get("text") or "")
            if who not in ("me", "ai") or not text:
                continue
            rows.append({
                "role": who,
                "kind": kind if kind in ("text", "call", "review", "transcript") else "text",
                "text": text[:2000],
                "t": t or convo.now_ms(),
                "hidden": 1 if item.get("hidden") else 0,
                "client_id": str(item.get("id") or f"mig:{i}:{t}"),
            })
        cut = notified.get(unit)
        await convo.import_messages(
            env, user, unit, rows,
            int(cut) if cut is not None else max((r["t"] for r in rows), default=0),
            convo.now_ms())
        await convo.seed_proactive(env, user, unit, ledger.get(unit), eng.get(unit),
                                   convo.now_ms())
    await convo.set_migrated(env, user)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        bind_worker_env(self.env)
        auth.bind_r2(self.env)
        path = str(request.url).split("?", 1)[0]
        query = dict(pair.split("=", 1) for pair in urlsplit(str(request.url)).query.split("&") if "=" in pair)

        if request.method == "POST" and path.endswith("/register"):
            return await _auth_route(auth.register, request)
        if request.method == "POST" and path.endswith("/login"):
            return await _auth_route(auth.login, request)
        if request.method == "POST" and path.endswith("/logout"):
            return await _auth_route(lambda body: auth.logout(), request)
        if request.method == "GET" and path.endswith("/me"):
            return auth.me(await auth.resolve_user(request))

        user = await auth.resolve_user(request)

        if request.method == "GET" and path.endswith("/health"):
            has = sum(bool(env_key(ep["env"])) for ep in ENDPOINTS.values())
            return Response.json({
                "ok": True,
                "model": MODEL,
                "voice": VOICE,
                "has_key": env_key("GEMINI_API_KEY") is not None,
                "chain_ready": has,
            })

        if request.method == "GET" and path.endswith("/practice/plan"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            return Response.json({
                "units": [
                    {"id": uid, "chapter": chapter, "title": title, "can_do": can_do}
                    for uid, (chapter, title, can_do) in UNIT_META.items()
                ]
            })

        if not user and request.method != "GET":
            return Response.json({"error": "请先登录"}, status=401)

        # ── message chain ────────────────────────────────────────────────
        if request.method == "POST" and path.endswith("/messages"):
            body = await request.json()
            unit = body.get("unit")
            text = str(body.get("text") or "").strip()[:2000]
            if unit not in PERSONAS:
                return Response.json({"error": f"unit 只收 {sorted(PERSONAS)}"}, status=400)
            if not text:
                return Response.json({"error": "消息不能为空"}, status=400)
            client_id = str(body.get("client_id") or "")[:64] or None
            now = convo.now_ms()
            tz = clamp_tz(body.get("tz"))
            await _migrate(self.env, user)
            await convo.set_tz(self.env, user, tz)
            contact = await _contact(self.env, unit) or {}
            conv = await convo.load(self.env, user, unit, now)
            st = convo.status(contact, conv, user, unit, now, tz)
            warm = now - await convo.last_ai_t(self.env, user, unit) < 90_000
            if st == "offline":
                wake = convo.wake_at(contact, now, tz)
                due = wake + (convo.reply_delay(contact, "active", warm) or 5000)
            else:
                wake = 0
                due = now + (convo.reply_delay(contact, st, warm) or 5000)
            mid, created = await convo.append(self.env, user, unit, "me", text, now,
                                              client_id=client_id)
            if created:
                burst = int((contact.get("burst") or [0, 1])[1] or 0)
                await convo.schedule(self.env, user, unit, "reply", due, now,
                                     burst_left=burst)
                await convo.bump_engagement(self.env, user, unit, now, warm)
                print(f"[msg] {user}/{unit} id={mid} status={st} due={due}")
            else:
                due = int(conv["reply_due_at"] or 0)
            return Response.json({"id": mid, "t": now, "status": st,
                                  "wake_at": wake, "reply_due_at": due})

        if request.method == "GET" and path.endswith("/conversation"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            unit = query.get("unit")
            if unit not in PERSONAS:
                return Response.json({"error": "unit 非法"}, status=400)
            after = int(query.get("after") or 0)
            limit = min(100, max(1, int(query.get("limit") or 50)))
            await _migrate(self.env, user)
            contact = await _contact(self.env, unit) or {}
            await self._kick_due(self.env, user, unit, contact)
            now = convo.now_ms()
            tz = int((await convo.prefs(self.env, user))["tz_offset"])
            conv = await convo.load(self.env, user, unit, now)
            st = convo.status(contact, conv, user, unit, now, tz)
            rows = await convo.tail(self.env, user, unit, after, limit)
            cursor = int(rows[-1]["id"]) if rows else after
            typing = bool(conv["turn_id"] and int(conv["turn_expires_at"] or 0) > now)
            return Response.json({
                "unit": unit,
                "status": st,
                "typing": typing,
                "wake_at": convo.wake_at(contact, now, tz) if st == "offline" else 0,
                "reply_due_at": conv["reply_due_at"],
                "cursor": cursor,
                "seen": int(conv["user_seen_seq"] or 0),
                "messages": rows,
            })

        if request.method == "GET" and path.endswith("/conversations"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            await _migrate(self.env, user)
            now = convo.now_ms()
            tz = int((await convo.prefs(self.env, user))["tz_offset"])
            out = []
            for unit in sorted(PERSONAS):
                contact = await _contact(self.env, unit) or {}
                conv = await convo.load(self.env, user, unit, now)
                st = convo.status(contact, conv, user, unit, now, tz)
                out.append({
                    "unit": unit,
                    "status": st,
                    "wake_at": convo.wake_at(contact, now, tz) if st == "offline" else 0,
                    "unread": await convo.unread(self.env, user, unit,
                                                 int(conv["user_seen_seq"] or 0)),
                    "last": await convo.last_any(self.env, user, unit),
                    "typing": bool(conv["turn_id"] and int(conv["turn_expires_at"] or 0) > now),
                })
            return Response.json({"conversations": out})

        if request.method == "POST" and path.endswith("/seen"):
            body = await request.json()
            unit = body.get("unit")
            seq = body.get("seq")
            if unit not in PERSONAS or not isinstance(seq, (int, float)):
                return Response.json({"error": "unit/seq 非法"}, status=400)
            await convo.set_seen(self.env, user, unit, int(seq), convo.now_ms())
            return Response.json({"ok": True})

        if request.method == "POST" and path.endswith("/transcript"):
            body = await request.json()
            unit = body.get("unit")
            turns = clean_call_turns(body.get("turns"))
            call = body.get("call") or {}
            if unit not in PERSONAS:
                return Response.json({"error": "unit 非法"}, status=400)
            now = convo.now_ms()
            cid = str(call.get("id") or "")
            for i, t in enumerate(turns):
                await convo.append(self.env, user, unit, t["who"], t["text"], now + i,
                                   kind="transcript", hidden=1,
                                   client_id=f"{cid}:t{i}" if cid else None)
            if cid and call.get("text"):
                await convo.append(self.env, user, unit, "me", str(call["text"])[:120],
                                   now, kind="call", client_id=cid)
            return Response.json({"ok": True})

        if request.method == "POST" and path.endswith("/reset"):
            body = await request.json()
            unit = body.get("unit")
            if unit not in PERSONAS:
                return Response.json({"error": "unit 非法"}, status=400)
            await convo.reset(self.env, user, unit, convo.now_ms())
            return Response.json({"ok": True})

        # ── presence ─────────────────────────────────────────────────────
        if request.method == "POST" and (path.endswith("/ping") or path.endswith("/away")):
            try:
                body = await request.json()
            except Exception:
                body = {}
            dev = str(body.get("d") or "anon")[:64]
            now = convo.now_ms()
            await convo.touch_device(self.env, user, dev, now, path.endswith("/ping"))
            if path.endswith("/away"):
                task = run_in_background(self._push_user(self.env, user))
                wait_until(task)
            return Response.json({"ok": True})

        # ── channel history for voice calls: the server owns it ─────────
        if request.method == "POST" and path.endswith("/token"):
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            unit = body.get("unit")
            if unit not in UNITS and unit not in PERSONAS:
                return Response.json(
                    {"error": f"unit 必须是 {sorted(UNITS | PERSONAS)} 之一"}, status=400)
            practice = bool(body.get("practice"))
            if practice and unit not in UNITS:
                return Response.json({"error": "practice 只收 unit-XX"}, status=400)
            tz_offset = clamp_tz(body.get("tz"))
            if unit in PERSONAS:
                await convo.set_tz(self.env, user, tz_offset)
                history = _rows_to_hist(await convo.recent(self.env, user, unit, 30))
            else:
                history = [] if practice else sanitize_history(body.get("history"))
            life_state, contact = None, None
            if unit in PERSONAS:
                contact = await _contact(self.env, unit) or {}
                life_state = life.settle(await life.load(self.env, user, unit),
                                         contact, cloud_npc.now_ms(), tz_offset)
            try:
                resp = await js_fetch(
                    AUTH_TOKENS_URL,
                    method="POST",
                    headers={"x-goog-api-key": env_key("GEMINI_API_KEY"),
                             "Content-Type": "application/json"},
                    body=json.dumps(build_token_payload(
                        unit, history, tz_offset, life_state, contact, practice,
                        VOICE_BY_ID["persona-Fiona"] if practice else None)),
                )
                if resp.status != 200:
                    detail = await resp.text()
                    return Response.json(
                        {"error": "Gemini 拒绝签发", "status": resp.status,
                         "detail": detail[:400]}, status=502)
                data = await resp.json()
            except Exception as e:
                return Response.json(
                    {"error": "签发失败", "type": type(e).__name__,
                     "detail": str(e)[:300]}, status=502)
            return Response.json({"token": data["name"], "model": MODEL})

        # ── call review ──────────────────────────────────────────────────
        if request.method == "POST" and path.endswith("/call-review"):
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            unit = body.get("unit")
            if unit not in PERSONAS and unit not in UNITS:
                return Response.json({"error": "unit 只收 persona 或 unit"}, status=400)
            turns = clean_call_turns(body.get("turns"))
            if not any(t["who"] == "me" for t in turns):
                return Response.json({"error": "没有可点评的用户发言"}, status=400)
            try:
                out = await run_chain(call_review_messages(turns))
            except RuntimeError as e:
                return Response.json({"error": str(e)}, status=502)
            raw = out.get("content", "")
            try:
                review = clean_review(_review_json(raw))
            except ValueError as e:
                print(f"call review parse failure unit={unit}: {e} raw={raw[:300]!r}")
                return Response.json({"error": "点评结果解析失败"}, status=502)
            return Response.json(review)

        # ── profile ──────────────────────────────────────────────────────
        if request.method == "GET" and path.endswith("/profile"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            obj = await self.env.DATA.get(f"{user}/avatar.txt")
            avatar = (await obj.text()) if obj is not None else ""
            return Response.json({"user": user, "avatar": avatar})

        if request.method == "PUT" and path.endswith("/avatar"):
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            data = body.get("data") or ""
            if not (data.startswith("data:image/") and len(data) < 120_000):
                return Response.json({"error": "头像只收 120KB 内的图片 dataURL"}, status=400)
            await self.env.DATA.put(f"{user}/avatar.txt", data)
            return Response.json({"ok": True})

        # ── Web Push ─────────────────────────────────────────────────────
        if request.method == "GET" and path.endswith("/push/pubkey"):
            return Response(vapid_pubkey(self.env), headers={"Content-Type": "text/plain"})

        if request.method == "POST" and path.endswith("/push/subscribe"):
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            endpoint = str(body.get("endpoint") or "")
            keys = body.get("keys") or {}
            dh = str(keys.get("p256dh") or "")
            au = str(keys.get("auth") or "")
            if not endpoint.startswith("https://") or not dh or not au:
                return Response.json({"error": "订阅缺 endpoint/keys(p256dh,auth)"}, status=400)
            dev = str(body.get("d") or "")[:64]
            subs = [dict(s) for s in await _load_subs(self.env, user)
                    if s.get("endpoint") != endpoint
                    and not (dev and s.get("d") == dev)
                    and not (dev and not s.get("d"))][:19]
            subs.append({"endpoint": endpoint, "keys": {"p256dh": dh, "auth": au},
                         **({"d": dev} if dev else {})})
            await _save_subs(self.env, user, subs)
            print(f"[push] {user} subscribe d={dev or '-'} total={len(subs)}")
            return Response.json({"ok": True, "count": len(subs)})

        if request.method == "PUT" and path.endswith("/prefs"):
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            notif = body.get("notif")
            if notif not in ("off", "ticker", "preview"):
                return Response.json({"error": "notif 只收 off/ticker/preview"}, status=400)
            await convo.set_notif(self.env, user, notif)
            return Response.json({"ok": True, "notif": notif})

        # ── static assets ────────────────────────────────────────────────
        if request.method in ("GET", "HEAD"):
            res = await self.env.ASSETS.fetch(request)
            p = urlsplit(str(request.url)).path
            kind = p.rsplit(".", 1)[-1].lower() if "." in p.rsplit("/", 1)[-1] else ""
            long_c = kind in ("js", "css", "m4a", "webp", "jpg", "jpeg", "png", "svg", "ico")
            if long_c or kind == "html" or p.endswith("/"):
                cc = ("public, max-age=86400, stale-while-revalidate=604800"
                      if long_c else "no-cache")
                headers = {k: v for k, v in res.headers.items()
                           if k.lower() != "cache-control"}
                headers["cache-control"] = cc
                return Response(res.body, status=res.status, headers=headers)
            return res

        return Response.json({"error": "用 POST"}, status=405)

    # ── scheduler ────────────────────────────────────────────────────────
    async def scheduled(self, controller, *rest):
        env = self.env
        now = convo.now_ms()
        if getattr(controller, "cron", "") == "* * * * *":
            await self._due_sweep(env, now)
            await self._push_sweep(env)
        else:
            await self._heavy_sweep(env, now / 1000.0)

    async def _kick_due(self, env, user: str, unit: str, contact: dict) -> None:
        now = convo.now_ms()
        conv = await convo.load(env, user, unit, now)
        if conv["reply_due_at"] is None or int(conv["reply_due_at"]) > now:
            return
        if conv["turn_id"] and int(conv["turn_expires_at"] or 0) > now:
            return
        tz = int((await convo.prefs(env, user))["tz_offset"])
        if convo.status(contact, conv, user, unit, now, tz) == "offline":
            task = run_in_background(convo.defer_to_wake(
                env, user, unit, contact, now, tz, conv["turn_kind"]))
        else:
            task = run_in_background(self._run_turn(env, user, unit, contact))
        wait_until(task)

    async def _run_turn(self, env, user: str, unit: str, contact: dict) -> None:
        now = convo.now_ms()
        turn, row = await convo.claim(env, user, unit, now)
        if not turn:
            return
        try:
            tz = int((await convo.prefs(env, user))["tz_offset"])
            conv = await convo.load(env, user, unit, now)
            if convo.status(contact, conv, user, unit, now, tz) == "offline":
                await convo.defer_to_wake(env, user, unit, contact, now, tz, row["turn_kind"])
                return
            hist = _rows_to_hist(await convo.recent(env, user, unit, 30))
            lif = life.settle(await life.load(env, user, unit), contact, now, tz)
            msgs = to_messages(unit, hist, tz, lif, contact)
            kind = row["turn_kind"] or "reply"
            if kind == "proactive":
                msgs.append({"role": "user", "content": PRO_REQ})
            elif kind == "burst":
                msgs.append({"role": "user", "content": BURST_REQ})
            out = await run_chain(msgs)
            parts = split_reply(unit, out.get("content") or "")
            if not parts:
                raise RuntimeError("empty reply")
            done = convo.now_ms()
            glow = int((contact.get("glow") or 15) * 60_000)
            if not await convo.complete(env, user, unit, turn, parts, done, glow):
                print(f"[turn] {user}/{unit} superseded, discard")
                return
            await life.save(env, user, unit,
                            life.apply_chat(lif, parse_chat(out.get("content") or ""), done))
            if kind == "reply":
                await convo.maybe_burst(env, user, unit, contact, done)
            await self._push_unit(env, user, unit)
            print(f"[turn] {user}/{unit} kind={kind} bubbles={len(parts)}")
        except Exception as e:
            print(f"[turn] {user}/{unit} failed: {type(e).__name__}: {str(e)[:160]}")
            await convo.fail(env, user, unit, turn, now + 60_000, now)

    async def _due_sweep(self, env, now: int) -> None:
        for user, unit in await convo.due(env, now, limit=4):
            contact = await _contact(env, unit)
            if contact:
                await self._run_turn(env, user, unit, contact)

    async def _push_sweep(self, env) -> None:
        for user in await convo.users_with_unpushed(env, 20):
            await self._push_user(env, user)

    async def _push_user(self, env, user: str) -> None:
        for unit in sorted(PERSONAS):
            await self._push_unit(env, user, unit)

    async def _push_unit(self, env, user: str, unit: str) -> None:
        now = convo.now_ms()
        pref = await convo.prefs(env, user)
        if pref["notif"] == "off":
            await convo.mark_pushed(env, user, unit, now)
            return
        conv = await convo.load(env, user, unit, now)
        nxt = await convo.next_push(env, user, unit, int(conv["user_seen_seq"] or 0))
        if not nxt:
            return
        if await convo.visible_devices(env, user, now):
            return  # in the app; /away will retry
        subs = await _load_subs(env, user)
        if not subs:
            await convo.mark_pushed(env, user, unit, now)
            return
        payload = {"title": NAMES.get(unit, unit),
                   "body": nxt["text"] if pref["notif"] == "preview" else "给你发来一条新消息",
                   "unit": unit}
        keep, gone, codes = [], [], []
        for sub in subs:
            try:
                res = await env.PUSHER.fetch(
                    "https://pusher.local/send", method="POST",
                    headers={"Content-Type": "application/json"},
                    body=json.dumps({"subscription": sub, "payload": payload},
                                    ensure_ascii=False))
                code = int((await res.json()).get("statusCode") or 0)
            except Exception as e:
                code = 0
                print(f"[push] send failed: {type(e).__name__} {str(e)[:120]}")
            codes.append(code)
            if code in (404, 410):
                gone.append(sub.get("endpoint"))
            else:
                keep.append(sub)
        if gone:
            await _save_subs(env, user, keep)
        print(f"[push] {user}/{unit} targets={[(s.get('d') or '-', c) for s, c in zip(subs, codes)]}")
        if codes and all(c == 0 or c >= 500 for c in codes) and keep:
            return  # transient failure: retry next tick
        await convo.mark_pushed(env, user, unit, now)

    async def _heavy_sweep(self, env, now: float) -> None:
        users = list(await _load_users(env))
        if users:
            k = int(now // 300) % len(users)
            users = (users[k:] + users[:k])[:HEAVY_USERS_PER_TICK]
        for user in users:
            await self._life_sweep(env, user, now)
            await self._proactive_sweep(env, user, int(now * 1000))

    async def _proactive_sweep(self, env, user: str, now: int) -> None:
        tz = int((await convo.prefs(env, user))["tz_offset"])
        for unit in sorted(PERSONAS):
            contact = await _contact(env, unit)
            if not contact:
                continue
            if await convo.proactive(env, user, unit, contact, now, tz):
                await self._run_turn(env, user, unit, contact)

    async def _life_sweep(self, env, user: str, now: float) -> None:
        now_ms = now * 1000.0
        for unit in sorted(PERSONAS):
            try:
                lif = await life.load(env, user, unit)
                if not life.needs_day(lif, now_ms):
                    continue
                contact = await _contact(env, unit)
                if not contact:
                    continue
                lif = life.mark_attempt(life.settle(lif, contact, now_ms), now_ms)
                await life.save(env, user, unit, lif)
                hist = _rows_to_hist(await convo.recent(env, user, unit, 12))
                out = await run_chain(life.day_messages(
                    unit, contact, lif, sanitize_history(hist), now_ms))
                day = life.parse_day(out.get("content") or "")
                await life.save(env, user, unit,
                                life.apply_day(lif, day, life.day_stamp(now_ms), now_ms))
                print(f"[life] {user}/{unit} day rolled events={len(day['events'])}")
            except Exception as e:
                print(f"[life] {user}/{unit} day failed: {type(e).__name__}: {str(e)[:120]}")
