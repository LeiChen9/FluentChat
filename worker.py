"""FluentChat 后端：给前端签发 Gemini Live 的一次性 token。

职责边界（很重要，别越界）：
- 只做一件事：拼 prompt → 调 Gemini 签发 ephemeral token → 返回给前端
- 音频不经过这里。浏览器拿 token 后 WSS 直连 Gemini，走自己的网络。
  原因：免费版 Worker CPU 上限扛不住音频流，中转还会产生费用。

这样前端就碰不到 API key，也碰不到 prompt —— prompt 钉在 token 里，
服务端强制生效，用户改不了。

目录分工：
- backend/auth.py     注册/登录/登出，用户表落 R2 users.json（cookie 会话）
- backend/common.py   模型容灾链、环境绑定与 secret 读取、KV 订阅存取（工具层）
- backend/config.py   全部常量与白名单（配置层）
- backend/prompt_data.py  自动生成的 prompt 数据，勿手改
- 本文件             路由与 prompt 组装（业务层）
"""

import json
import re
from urllib.parse import urlsplit
from workers import Response, WorkerEntrypoint, fetch as js_fetch
from backend import auth
from backend import cloud_npc
from backend.common import (ENDPOINTS, _load_subs, _save_subs,
                            bind_worker_env, env_key, run_chain, vapid_pubkey)
from backend.prompt_data import PROMPTS
from backend.time_context import DEFAULT_TZ_OFFSET, build_time_context, clamp_tz
from backend.config import (AUTH_TOKENS_URL, HIST_MAX_CHARS, HIST_MAX_ITEMS,
                            MODEL, PERSONAS, UNITS, VOICE, VOICE_BY_ID)


def to_messages(
    unit: str, history: list[dict], tz_offset: int = DEFAULT_TZ_OFFSET
) -> list[dict]:
    """NPC 只使用 contacts 下的人设 prompt，历史转 user/assistant。"""
    ctx = build_time_context(history, tz_offset)
    sys_text = (
        f"{read_prompt('text_style')}\n\n"
        f"{read_prompt(unit)}\n\n"
        f"{ctx['header']}"
    )
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
    """取 prompt 内容。种类与来源见 backend/prompt_data.py（tools/gen_prompts.py 生成）。"""
    return PROMPTS[name.removesuffix(".md")]


# 离线代打的主动指令，与 site/js/live.js 的 PRO_REQ 同一份文案。
# 真源在浏览器一侧（它管着在线时的主动开口），cron 这份是随行副本。
PRO_REQ = (
    "(Proactive turn. Nobody spoke just now: text me first like a friend would. "
    "Pick up whatever we talked about recently or something happening in your day "
    "right now. Approach it from a different angle than your previous proactive "
    "texts: share a slice of your day, wonder what I'm up to, or revisit an old "
    "topic with something new. Let the time since we last talked shape how you "
    "open. 1-2 short casual sentences. Not a meta-greeting, don't mention "
    "that you haven't heard from me.)"
)


async def _auth_route(fn, request) -> Response:
    """认证路由的壳：取 JSON → 业务（Bad 归 4xx），认证接口不碰链路。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return await fn(body)
    except auth.Bad as e:
        return Response.json({"error": e.detail}, status=e.status)


_SAFE_UNIT = re.compile(r"[A-Za-z0-9_-]{1,64}$")


async def _hist_route(env, user: str, request) -> Response:
    """聊天历史镜像：PUT 存、GET 取，R2 位形 {user}/hist/{unit}.json。

    localStorage 是使用中的活本，R2 是耐久备份（换设备接续、后续 cron 云端
    主动推都从这儿读）。unit 是 key 的一段路径，只认 persona-xxx/unit-XX。
    """
    unit = str(request.url).split("?", 1)[0].split("/hist/", 1)[1]
    if not _SAFE_UNIT.match(unit):
        return Response.json({"error": "unit 非法"}, status=400)
    key = f"{user}/hist/{unit}.json"

    if request.method == "PUT":
        try:
            hist = await request.json()
        except Exception:
            return Response.json({"error": "请求体不是合法 JSON"}, status=400)
        if not isinstance(hist, list):
            return Response.json({"error": "历史必须是数组"}, status=400)
        await env.DATA.put(key, json.dumps(hist, ensure_ascii=False))
        return Response.json({"ok": True})

    obj = await env.DATA.get(key)
    if obj is None:
        return Response.json({"error": "云端还没有这份对话"}, status=404)
    return Response(await obj.text(), headers={"Content-Type": "application/json"})


def sanitize_history(raw) -> list[dict]:
    """清洗前端带回来的聊天历史：[{"who": me|ai, "text": str, "t": ms}, ...]。

    历史会钉进 system instruction，所以条数和单条长度都要掐。
    t 只用于给模型时间感，不参与正文截断。
    复盘卡片（kind=review）前端就不带，带了也会在这里被丢掉。
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        who = item.get("who")
        text = item.get("text")
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
        if len(out) >= HIST_MAX_ITEMS:
            break
    return out


def clean_call_turns(raw) -> list[dict]:
    """通话点评入参：只留双方的转写，条数与单条长度都掐死。"""
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
    """模型偶尔裹代码块/寒暄：截出最外层对象再解析。"""
    t = (text or "").strip()
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("模型没给出 JSON")
    # strict=False：允许字符串里出现裸换行/制表符（模型常这么写）
    return json.loads(t[a:b + 1], strict=False)


def clean_review(data) -> dict:
    """点评结果兜底：字段类型、条数与长度都收一遍，前端拿到就能直接画。"""
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
    """system = 点评规则；user = 带编号的转写（i 就是 lines[].i 的锚点）。"""
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
    tz_offset: int = DEFAULT_TZ_OFFSET
) -> str:
    """把基础教学规则、persona 与本次话题拼成一份完整 prompt。

    顺序有讲究：先给通用对话规则，再给本次话题。
    后写的更贴近当前任务，模型更容易听话题部分的。
    有历史时历史钉在最后 —— 同理，它要盖过 base.md「第一轮直接说开场白」。
    """
    history = history or []
    base_name = "base-ch2.md" if unit in ("unit-07", "unit-08", "unit-09", "unit-10", "unit-11", "unit-12") else "base.md"
    if unit in PERSONAS:
        ctx = build_time_context(history, tz_offset)
        text = (
            f"{read_prompt('text_style')}\n\n"
            f"{read_prompt(unit)}\n\n"
            f"{ctx['header']}"
        )
        dated = ctx["history"]
    else:
        text = f"{read_prompt(base_name)}\n\n{read_prompt(f'{unit}.md')}"
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
    tz_offset: int = DEFAULT_TZ_OFFSET
) -> dict:
    """构造签发请求体。unit 参数横跨两类 id：unit-XX 和 persona-xxx。

    关键：不设 field_mask。按文档语义，整个 setup 都从 token 里读，
    客户端发来的 setup 会被完全忽略 —— 这正是 prompt 锁死在后端的机制。

    已实测踩过的坑：
    - speechConfig 必须嵌在 generationConfig 内，放顶层会报 Unknown name
    - outputAudioTranscription 给 {} 即可，用来把 AI 说的话转成文字
    """
    return {
        # 一次性的：每次建连签一个新 token
        "uses": 1,
        "bidiGenerateContentSetup": {
            "model": f"models/{MODEL}",
            "systemInstruction": {
                "parts": [
                    {"text": build_system_instruction(unit, history, tz_offset)}
                ]
            },
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {                    "voiceName": VOICE_BY_ID.get(unit, VOICE)}
                    }
                },
            },
            # 把 AI 的语音转成文字，前端用来显示字幕
            "outputAudioTranscription": {},
            # 也转用户说的话，复盘时要用
            "inputAudioTranscription": {},
        },
    }


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # 先绑定 env，链上取 key、读用户表全靠它
        bind_worker_env(self.env)
        auth.bind_r2(self.env)
        path = str(request.url).split("?", 1)[0]

        # ── 认证路由：不用先登录 ──
        if request.method == "POST" and path.endswith("/register"):
            return await _auth_route(auth.register, request)
        if request.method == "POST" and path.endswith("/login"):
            return await _auth_route(auth.login, request)
        if request.method == "POST" and path.endswith("/logout"):
            return await _auth_route(lambda body: auth.logout(), request)
        if request.method == "GET" and path.endswith("/me"):
            return auth.me(await auth.resolve_user(request))

        # ── 以下业务所需登录：cookie 里要有注册过的用户名。
        # 注意别把静态资产挡住：GET/HEAD 的页面/JS/CSS 走 ASSETS 代发（在下面），公开。
        user = await auth.resolve_user(request)

        # 健康检查：顺便确认部署成功、secret 已设
        if request.method == "GET" and path.endswith("/health"):
            has = sum(bool(env_key(ep["env"])) for ep in ENDPOINTS.values())
            return Response.json({
                "ok": True,
                "model": MODEL,
                "voice": VOICE,
                # 只回布尔，不回 key 本身
                "has_key": env_key("GEMINI_API_KEY") is not None,
                "chain_ready": has,
            })

        # ── 登录后的业务；历史镜像挂在门禁之后 ──
        if request.method in ("GET", "PUT") and "/hist/" in path:
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            return await _hist_route(self.env, user, request)

        # 心跳：页面开着每 3 分钟报到一次。cron 只代打给「心跳断了」的用户，
        # 别跟浏览器自己的抽签叠着发。
        if request.method == "POST" and path.endswith("/ping"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            state = await cloud_npc.load_state(self.env, user)
            state["lastSeen"] = cloud_npc.now_ms()
            await cloud_npc.save_state(self.env, user, state)
            return Response.json({"ok": True})

        # 自检：对本账号立即跑一轮离线代打流程（绕心跳判定，配额窗口照常）。
        # 排查 cron 火总不看走没走、账号画像抽没抽中都用得上；只有本人能动自己。
        if request.method == "POST" and path.endswith("/cron/kick"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            force = (str(request.url).split("?", 1)[-1].find("force=1") >= 0) or str(request.url).split("?")[-1] == "force=1"
            wrote, diag = await self._cron_sweep(self.env, now=cloud_npc.now_ms() / 1000.0,
                                                 one_user=user, force=force)
            return Response.json({"ok": True, "wrote": wrote, "diag": diag})

        # 个人资料：用户名 + 头像（dataURL 存 {user}/avatar.txt，前端直接贴 img.src）
        if request.method == "GET" and path.endswith("/profile"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            obj = await self.env.DATA.get(f"{user}/avatar.txt")
            avatar = (await obj.text()) if obj is not None else ""
            return Response.json({"user": user, "avatar": avatar})

        if request.method == "PUT" and path.endswith("/avatar"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            data = body.get("data") or ""
            # 只收前端压好的图片 dataURL，128px webp ≈ 几 KB；别让人传大图进来
            if not (data.startswith("data:image/") and len(data) < 120_000):
                return Response.json({"error": "头像只收 120KB 内的图片 dataURL"}, status=400)
            await self.env.DATA.put(f"{user}/avatar.txt", data)
            return Response.json({"ok": True})

        # 文字对话：persona 聊天走模型容灾链（非流式）。/history 语义同 /token。
        if request.method == "POST" and path.endswith("/chat"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            unit = body.get("unit")
            if unit not in PERSONAS:
                return Response.json(
                    {"error": f"/chat 只面向 persona：{sorted(PERSONAS)}"},
                    status=400)
            history = sanitize_history(body.get("history"))
            tz_offset = clamp_tz(body.get("tz"))
            # 可选：主动消息场景的临时指令（最后一条 user 消息，模型照办开口）
            directive = str(body.get("directive") or "").strip()[:400]
            print(f"chat request unit={unit} history={len(history)} directive={1 if directive else 0}")
            try:
                msgs = to_messages(unit, history, tz_offset)
                if directive:
                    msgs.append({"role": "user", "content": directive})
                out = await run_chain(msgs)
            except RuntimeError as e:
                print(f"chat failure unit={unit}: {e}")
                return Response.json({"error": str(e)}, status=502)
            return Response.json(out)

        # ── 通话点评：挂断后前端把整段转写发来，一次性返回逐句建议 + 总评 ──
        if request.method == "POST" and path.endswith("/call-review"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            unit = body.get("unit")
            if unit not in PERSONAS:
                return Response.json({"error": "unit 只收 persona"}, status=400)
            turns = clean_call_turns(body.get("turns"))
            if not any(t["who"] == "me" for t in turns):
                return Response.json({"error": "没有可点评的用户发言"}, status=400)
            print(f"call review unit={unit} turns={len(turns)}")
            try:
                out = await run_chain(call_review_messages(turns))
            except RuntimeError as e:
                print(f"call review failure unit={unit}: {e}")
                return Response.json({"error": str(e)}, status=502)
            raw = out.get("content", "")
            try:
                review = clean_review(_review_json(raw))
            except ValueError as e:
                # 解析失败按上游失败处理：前端拿到 502 就可以重试
                print(f"call review parse failure unit={unit}: {e} raw={raw[:300]!r}")
                return Response.json({"error": "点评结果解析失败"}, status=502)
            return Response.json(review)

        # ── Web Push：公钥 / 订阅登记 ──
        if request.method == "GET" and path.endswith("/push/pubkey"):
            return Response(vapid_pubkey(self.env),
                            headers={"Content-Type": "text/plain"})

        if request.method == "POST" and path.endswith("/push/subscribe"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
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
            subs = [dict(s) for s in await _load_subs(self.env, user) if s.get("endpoint") != endpoint][:19]
            subs.append({"endpoint": endpoint, "keys": {"p256dh": dh, "auth": au}})
            await _save_subs(self.env, user, subs)
            return Response.json({"ok": True, "count": len(subs)})

        # ── 通知偏好：iOS 消息设置三档 ──
        # off = 完全不提醒；ticker = 只提示有消息（不带正文）；preview = 横幅带内容。
        if request.method == "PUT" and path.endswith("/prefs"):
            if not user:
                return Response.json({"error": "请先登录"}, status=401)
            try:
                body = await request.json()
            except Exception:
                return Response.json({"error": "请求体不是合法 JSON"}, status=400)
            notif = body.get("notif")
            if notif not in ("off", "ticker", "preview"):
                return Response.json({"error": "notif 只收 off/ticker/preview"}, status=400)
            state = await cloud_npc.load_state(self.env, user)
            state["notif"] = notif
            await cloud_npc.save_state(self.env, user, state)
            return Response.json({"ok": True, "notif": notif})

        # run_worker_first 打开后，所有请求都先过 Python：
        # 静态文件（/、css、fires 等）必须在这里代发，否则前端会 404。
        if request.method in ("GET", "HEAD"):
            res = await self.env.ASSETS.fetch(request)
            # 落持久缓存策略（默认只有 1 小时，iOS 主屏 app 每次重开都整个
            # 重新拉）：前端代码/音频/图 1 天 + 7 天 stale-while-revalidate，
            # 入口 HTML no-cache 保留 etag 304 —— 版本照旧当天见效，其余
            # 资源杀 app 冷启几乎不再发请求。
            p = urlsplit(str(request.url)).path
            kind = p.rsplit(".", 1)[-1].lower() if "." in p.rsplit("/", 1)[-1] else ""
            long_c = kind in ("js", "css", "m4a", "webp", "jpg", "jpeg", "png", "svg", "ico")
            if long_c or kind == "html" or p.endswith("/"):
                cc = ("public, max-age=86400, stale-while-revalidate=604800"
                      if long_c else "no-cache")
                headers = {k: v for k, v in res.headers.items()
                           if k.lower() != "cache-control"}
                headers["cache-control"] = cc
                return Response(res.body, status=res.status,
                                headers=headers)
            return res

        if request.method != "POST":
            return Response.json({"error": "用 POST"}, status=405)

        # 签发 token 是最后兜底的 POST 落点，门禁搁在这儿
        if not user:
            return Response.json({"error": "请先登录"}, status=401)

        try:
            body = await request.json()
        except Exception:
            return Response.json({"error": "请求体不是合法 JSON"}, status=400)

        unit = body.get("unit")
        if unit not in UNITS and unit not in PERSONAS:
            return Response.json(
                {
                    "error": f"unit 必须是 {sorted(UNITS | PERSONAS)} 之一",
                },
                status=400,
            )

        # 聊天历史（可选）：上次聊过的内容钉进 prompt，模型有记忆
        history = sanitize_history(body.get("history"))
        tz_offset = clamp_tz(body.get("tz"))

        # 调 Gemini 签发 token；fetch / 非 200 / 解析三种不快活统一 502
        try:
            resp = await js_fetch(
                AUTH_TOKENS_URL,
                method="POST",
                headers={
                    "x-goog-api-key": env_key("GEMINI_API_KEY"),
                    "Content-Type": "application/json",
                },
                body=json.dumps(build_token_payload(unit, history, tz_offset)),
            )
            if resp.status != 200:
                detail = await resp.text()
                return Response.json(
                    {"error": "Gemini 拒绝签发", "status": resp.status,
                     "detail": detail[:400]},
                    status=502)
            data = await resp.json()
        except Exception as e:
            return Response.json(
                {"error": "签发失败", "type": type(e).__name__,
                 "detail": str(e)[:300]},
                status=502)

        # 只把 token 的名字返给前端，其余字段不带出去
        return Response.json({"token": data["name"], "model": MODEL})

    # ── cron 每 5 分钟：替「页面已关」的用户代打主动消息（片 3b）────
    # 流程：心跳判定 → contact.json（ASSETS，与浏览器同源）→ 云册抽签 →
    #   调链生成 → 写 {user}/hist/{unit}.json 镜像。推送通知是片 3c：
    #   pusher 解锁后接进来。浏览器上线时 openChat 的云端合流会把
    #   消息摆回本地一册。
    async def scheduled(self, controller, *rest):
        env = self.env
        await self._cron_sweep(env, now=cloud_npc.now_ms() / 1000.0)

    # 一轮 cron 的主体（scheduled 与自检路由共用）。逐离线用户抽签代打。
    async def _cron_sweep(self, env, now: float, one_user: str | None = None, force: bool = False) -> tuple[list, list]:
        """one_user 传值 = 自检模式：只跑该用户、绕过心跳判定；正常轮跑全部离线用户。
        force 穿透到底层抽签（仍守窗口与名额）。返回本轮真中签并写库的 user/unit。"""
        bind_worker_env(env)
        auth.bind_r2(env)
        try:
            obj = await env.DATA.get("users.json")
            raw = await obj.text() if obj is not None else "{}"
            users = json.loads(raw)
        except Exception as e:
            print(f"[cron] users.json read failed: {type(e).__name__}: {e}")
            users = {}
        if not isinstance(users, dict):
            users = {}

        offline, wrote, diag = [], [], []
        for user in users:
            state = await cloud_npc.load_state(env, user)
            seen = state.get("lastSeen")
            # 自检模式：指定用户强制进流程；正常模式下按心跳判定
            if one_user is not None:
                if user != one_user:
                    continue
            elif not (isinstance(seen, (int, float)) and 0 < seen < now * 1000 - cloud_npc.OFFLINE_MS):
                continue  # 心跳活着（在线）或从未登录 → 浏览器自己管
            offline.append(user)
            ledgers = state.get("ledger") if isinstance(state.get("ledger"), dict) else {}
            eng = state.get("eng") if isinstance(state.get("eng"), dict) else {}
            hits = 0
            for unit in PERSONAS:
                if not unit.startswith("persona-"):
                    continue
                # 画像真源是 contact.json（ASSETS 与浏览器同一份文件）
                contact = None
                try:
                    res = await env.ASSETS.fetch(
                        f"https://assets.local/assets/contacts/{unit.removeprefix('persona-')}/contact.json")
                    contact = await res.json() if res.ok else None
                except Exception:
                    pass
                if not isinstance(contact, dict):
                    diag.append({"unit": unit, "err": "contact load failed"})
                    continue
                led = ledgers.get(unit)
                led = led if isinstance(led, dict) else {}
                # 云册账本条目规整天界：跨天/空账一律当日 0 起步（date 缺失
                # 会让 pick 的次日重置永远糊着 null）
                today = cloud_npc.day_stamp(now)
                if led.get("date") != today:
                    led = {"date": today, "sent": 0}
                e = eng.get(unit)
                e = (e if isinstance(e, (int, float)) else cloud_npc.ENG_DEFAULT) * cloud_npc.ENG_DECAY
                # 命中先记账：生成失败也不重抽（不浪费名额，同浏览器的重试语义）
                hit = cloud_npc.pick_proactive(contact, led, e, now, force=force)
                s = contact.get("proactive") or {}
                left = cloud_npc.minutes_left_cst(s.get("windows"), now)
                diag.append({"unit": unit, "left": left, "sent": int(led.get("sent") or 0),
                             "eng": round(e, 4), "hit": hit})
                if not hit:
                    eng[unit] = e
                    continue
                ledgers[unit] = {"date": today, "sent": int(led.get("sent") or 0) + 1,
                                 "lastAt": cloud_npc.now_ms()}
                eng[unit] = e
                hits += 1
                await self._proactive(env, user, unit, contact)
                wrote.append(f"{user}/{unit}")

            await cloud_npc.save_state(env, user, {**state, "ledger": ledgers, "eng": eng})
        if offline:
            print(f"[cron] offline passed={'watch' if one_user is None else 'kick'}={offline} wrote={wrote}")
        return wrote, diag

    # 离线代打的生成与落库。链上任何一层失败就整个放弃本条：名额已扣，
    # 别让半成品消息写进镜像。
    async def _proactive(self, env, user: str, unit: str, contact: dict) -> None:
        try:
            obj = await env.DATA.get(f"{user}/hist/{unit}.json")
            hist = json.loads(await obj.text()) if obj is not None else []
            if not isinstance(hist, list):
                hist = []
            msgs = to_messages(unit, sanitize_history(hist))
            msgs.append({"role": "user", "content": PRO_REQ})
            out = await run_chain(msgs)
            text = out.get("content", "")
        except Exception:
            return  # 名额已扣；下一天/下一 tick 再说
        if not text.strip():
            return
        # 落库保全量（t 是云端合流的排序键，prompt 才用清洗版）
        text = text.strip()
        hist.append({"who": "ai", "text": text, "t": cloud_npc.now_ms()})
        await env.DATA.put(
            f"{user}/hist/{unit}.json",
            json.dumps(hist[-HIST_MAX_ITEMS:], ensure_ascii=False))
        # 镜像落库后接横幅（片 3c）：正文照样在，横幅按本机 notif 偏好发送
        await self._push(env, user, unit, contact, text)

    # 把一条离线消息从系统横幅送出去（iOS 桌面 web app = 横幅，无图标角标）。
    # notif 三档：off 不发；ticker 只提示有消息；preview 带正文。失效订阅
    # （Apple/浏览器 404/410）顺手清出名单，横幅链路断了不影响消息本体。
    async def _push(self, env, user: str, unit: str, contact: dict, text: str) -> None:
        try:
            state = await cloud_npc.load_state(env, user)
        except Exception:
            state = {}
        notif = state.get("notif", "preview")
        if notif not in ("ticker", "preview"):
            return
        subs = await _load_subs(env, user)
        if not subs:
            return
        payload = {"title": str(contact.get("name") or unit),
                   "body": text if notif == "preview" else "给你发来一条新消息",
                   "unit": unit}
        keep, gone = [], []
        for sub in subs:
            try:
                res = await env.PUSHER.fetch(
                    "https://pusher.local/send", method="POST",
                    headers={"Content-Type": "application/json"},
                    body=json.dumps({"subscription": sub, "payload": payload}, ensure_ascii=False))
                res = await res.json()
                code = int(res.get("statusCode") or 0)
                if code in (404, 410):
                    gone.append(sub.get("endpoint"))
                    continue
            except Exception as e:
                print(f"[push] banner send failed: {type(e).__name__} {str(e)[:120]}")
            keep.append(sub)
        if gone:
            await _save_subs(env, user, [s for s in keep if s.get("endpoint") not in set(gone)])
