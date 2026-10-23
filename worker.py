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
from workers import Response, WorkerEntrypoint, fetch as js_fetch
from backend import auth
from backend.common import (ENDPOINTS, _load_subs, _save_subs,
                            bind_worker_env, env_key, run_chain, vapid_pubkey)
from backend.prompt_data import PROMPTS
from backend.config import (AUTH_TOKENS_URL, HIST_MAX_CHARS, HIST_MAX_ITEMS,
                            MODEL, PERSONAS, UNITS, VOICE, VOICE_BY_ID)


def to_messages(unit: str, history: list[dict]) -> list[dict]:
    """persona prompt（只性格与小传，无教学规则）钉 system，历史转 user/assistant。"""
    sys_text = read_prompt(unit) + "\n" + read_prompt("text_style")
    msgs = [{"role": "system", "content": sys_text}]
    if not history:
        msgs.append({"role": "user",
                     "content": "(You just came online. Send your opening line.)"})
        return msgs
    for h in history:
        msgs.append({"role": "user" if h["who"] == "me" else "assistant",
                     "content": h["text"]})
    return msgs


def read_prompt(name: str) -> str:
    """取 prompt 内容。种类与来源见 backend/prompt_data.py（tools/gen_prompts.py 生成）。"""
    return PROMPTS[name.removesuffix(".md")]


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
    """清洗前端带回来的聊天历史：只认 [{"who": me|ai, "text": str}, ...]。

    历史会钉进 system instruction，所以条数和单条长度都要掐。
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
        out.append({"who": who, "text": text[:HIST_MAX_CHARS]})
        if len(out) >= HIST_MAX_ITEMS:
            break
    return out


def build_system_instruction(
    unit: str, history: list[dict] | None = None
) -> str:
    """把基础教学规则和本次 Unit 的话题拼成一份完整 prompt。

    顺序有讲究：先给通用对话规则，再给本次话题。
    后写的更贴近当前任务，模型更容易听话题部分的。
    有历史时历史钉在最后 —— 同理，它要盖过 base.md「第一轮直接说开场白」。
    """
    base_name = "base-ch2.md" if unit in ("unit-07", "unit-08", "unit-09", "unit-10", "unit-11", "unit-12") else "base.md"
    text = f"{read_prompt(base_name)}\n\n{read_prompt(f'{unit}.md')}"
    if not history:
        return text
    speaker = {"me": "用户", "ai": "你"}
    lines = "\n".join(
        f"{speaker[h['who']]}：{h['text']}" for h in history
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
    unit: str, history: list[dict] | None = None
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
                    {"text": build_system_instruction(unit, history)}
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
            # 可选：主动消息场景的临时指令（最后一条 user 消息，模型照办开口）
            directive = str(body.get("directive") or "").strip()[:400]
            try:
                msgs = to_messages(unit, history)
                if directive:
                    msgs.append({"role": "user", "content": directive})
                out = await run_chain(msgs)
            except RuntimeError as e:
                return Response.json({"error": str(e)}, status=502)
            return Response.json(out)

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
            subs = [dict(s) for s in await _load_subs(self.env) if s.get("endpoint") != endpoint][:19]
            subs.append({"endpoint": endpoint, "keys": {"p256dh": dh, "auth": au}})
            await _save_subs(self.env, subs)
            return Response.json({"ok": True, "count": len(subs)})

        # run_worker_first 打开后，所有请求都先过 Python：
        # 静态文件（/、css、fires 等）必须在这里代发，否则前端会 404。
        if request.method in ("GET", "HEAD"):
            return await self.env.ASSETS.fetch(request)

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

        # 调 Gemini 签发 token；fetch / 非 200 / 解析三种不快活统一 502
        try:
            resp = await js_fetch(
                AUTH_TOKENS_URL,
                method="POST",
                headers={
                    "x-goog-api-key": env_key("GEMINI_API_KEY"),
                    "Content-Type": "application/json",
                },
                body=json.dumps(build_token_payload(unit, history)),
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
