"""FluentChat 后端：给前端签发 Gemini Live 的一次性 token。

职责边界（很重要，别越界）：
- 只做一件事：拼 prompt → 调 Gemini 签发 ephemeral token → 返回给前端
- 音频不经过这里。浏览器拿 token 后 WSS 直连 Gemini，走自己的网络。
  原因：免费版 Worker CPU 上限扛不住音频流，中转还会产生费用。

这样前端就碰不到 API key，也碰不到 prompt —— prompt 钉在 token 里，
服务端强制生效，用户改不了。
"""

import asyncio
import base64
import hashlib
import json
import time
from workers import Response, WorkerEntrypoint, fetch as js_fetch

# Gemini 接口地址
AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"

# 已实测可用的 Live 模型。注意它不出现在 /v1beta/models 列表里，
# 所以别用那个列表选模型，列不出来不代表不能用。
MODEL = "gemini-3.8-live"

# 音色。已实测接受：Kore / Puck / Charon / Aoede / Zephyr / Laomedeia
VOICE = "Kore"

# 允许的 Unit 白名单。前端只能传这些 id，避免任意文件读取。
UNITS = {f"unit-{i:02d}" for i in range(1, 13)}

# Persona 好友（聊天列表）。prompt 是 prompts/personas/persona-*.md，
# 每人一条自己的声线 —— 见 prompts/personas.md 的声线速查表。
PERSONAS = {"persona-leo", "persona-chole", "persona-sam"}
VOICE_BY_ID = {
    "persona-leo": "Puck",    # Upbeat · 男
    "persona-chole": "Leda",  # Youthful · 女
    "persona-sam": "Umbriel", # Easy-going · 男
}

# 随 token 注入 system instruction 的历史：掐条数、掐单条长度，
# 免得请求体膨胀（也防前端传一堆垃圾进来）。
HIST_MAX_ITEMS = 30
HIST_MAX_CHARS = 400


# ── 文字对话的模型容灾链（参考 argus/backend/common.py 的写法）──────────────
# 场景差异：社交媒体聊天不要求实时，链全挂就直接报错，恢复交给以后的重试层。
# 没有流式（SSE 砍掉）、没有 tools、语音 /token 一条路不掺和。

# 端点表：base_url / secret 名的唯一事实源。加一家只改这里 + MODEL_CHAIN 一行。
ENDPOINTS = {
    "agnes": {"base_url": "https://apihub.agnes-ai.com/v1/", "env": "AGNES_API_KEY"},
    "kilo": {"base_url": "https://ai-gateway.kilo.ai/api/v1/", "env": "KILO_API_KEY"},
    "cohere": {"base_url": "https://api.cohere.ai/compatibility/v1/", "env": "COHERE_API_KEY"},
    "requesty": {"base_url": "https://router.requesty.ai/v1/", "env": "REQUESTY_API_KEY"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1/", "env": "OPENROUTER_API_KEY"},
    "groq": {"base_url": "https://api.groq.com/openai/v1/", "env": "GROQ_API_KEY"},
}

# Groq 免费层输入上限 8000 token/分钟，超了直接 413。按估算提前跳过。
# 西文约 4 字符/token、CJK 约 1 字/token，刻意高估——低估会把被拒的请求
# 放进去，高估只是提前跳过一个模型，不改变链的正确性。
GROQ_MAX_INPUT_TOKENS = 7000

# 模型链：照搬 argus 实测可用的条目，只留我们有 key 的端点。deepseek 不入链
#（要 chinese_calendar 做时段闸门，成本不匹配）；gemini 也不入——唯一那把
# Google key 是语音专用的（gemini_live_apiKey），不能拿来蹭文字账。
MODEL_CHAIN = [
    {"name": "minimax/minimax-m3.1-flash:free", "endpoint": "kilo"},
    {"name": "command-a-plus-05-2026", "endpoint": "cohere"},
    {"name": "command-a-reasoning-08-2025", "endpoint": "cohere"},
    {"name": "nvidia/nemotron-3.5-lightning-30b-a3b", "endpoint": "requesty"},
    {"name": "novita/ling-3.1-flash", "endpoint": "requesty"},
    {"name": "openai/gpt-oss-120b", "endpoint": "groq", "max_input_tokens": GROQ_MAX_INPUT_TOKENS},
    {"name": "openai/gpt-oss-20b", "endpoint": "groq", "max_input_tokens": GROQ_MAX_INPUT_TOKENS},
    {"name": "north-mini-code-1-0", "endpoint": "cohere"},
    {"name": "nvidia/muse-glimmer-30b", "endpoint": "requesty"},
    {"name": "liquid/lfm-2.5-2.6b:free", "endpoint": "openrouter"},
    {"name": "agnes-3.0-flash", "endpoint": "agnes"},
    {"name": "poolside/laguna-s-2.1:free", "endpoint": "kilo"},
    {"name": "qwen/qwen3.8-27b", "endpoint": "groq", "max_input_tokens": GROQ_MAX_INPUT_TOKENS},
    {"name": "nvidia/nemotron-3-super-120b-a12b:free", "endpoint": "kilo"},
]


# Worker 侧 bindings 注入（照搬 argus 的 bind_worker_env）：fetch 进来时把
# self.env 存在这里，链上取 key 都走它。离线脚本里它为空，链视为不可用。
_WORKER_ENV = {"env": None}


def bind_worker_env(env) -> None:
    """每次 fetch 先调：绑定本 isolate 的 env。"""
    _WORKER_ENV["env"] = env


def _env_key(env: str) -> str | None:
    """读 secret 的值。worker.env 是 JS 代理对象，不能 .get()。"""
    wenv = _WORKER_ENV["env"]
    if wenv is None:
        return None
    try:
        val = getattr(wenv, env)
    except Exception:
        return None
    return str(val) if val else None


def input_tokens(messages: list[dict]) -> int:
    """估输入 token 数，给 groq 的闸门用。西文 4 字符/token、CJK 1 字/token。"""
    def est(s: str) -> int:
        ascii_len = len(s.encode("ascii", errors="ignore"))
        return (len(s) - ascii_len) + ascii_len // 4
    return sum(est(m.get("content") or "") for m in messages)


# 文字聊天加在 persona prompt 后面的通用规则：活人感，短，不教训人。
TEXT_STYLE = (
    " # 平台角色（聊天软件短消息）\n"
    "- You're texting a friend in a chat app, not tutoring. 1-2 short casual "
    "sentences per message; lowercase is fine; emoji rare and sparingly.\n"
    "- Never correct the user's English, never lecture, never offer lessons or "
    "structured help. Sound like a real person, not an assistant.\n"
    "- Reply to what they actually said. If the history is empty, send the "
    "opening line from「Today's topic」instead.")


def to_messages(unit: str, history: list[dict]) -> list[dict]:
    """persona prompt（只性格与小传，无教学规则）钉 system，历史转 user/assistant。"""
    sys_text = read_prompt(unit) + TEXT_STYLE
    msgs = [{"role": "system", "content": sys_text}]
    if not history:
        msgs.append({"role": "user",
                     "content": "(You just came online. Send your opening line.)"})
        return msgs
    for h in history:
        msgs.append({"role": "user" if h["who"] == "me" else "assistant",
                     "content": h["text"]})
    return msgs


async def _chat_via(item: dict, messages: list[dict]) -> str:
    """单模型单试。20s 兜底：光等响应头，管不住上游收了请求不吐字节的挂法。"""
    ep = ENDPOINTS[item["endpoint"]]
    url = ep["base_url"] + "chat/completions"
    payload = json.dumps({"model": item["name"], "messages": messages})
    resp = await asyncio.wait_for(
        js_fetch(url, method="POST",
                 headers={"Authorization": f"Bearer {_env_key(ep['env'])}",
                          "Content-Type": "application/json"},
                 body=payload),
        timeout=20.0)
    if resp.status != 200:
        raise RuntimeError(f"HTTP {resp.status}: {(await resp.text())[:200]}")
    data = await resp.json()
    return (data["choices"][0].get("message") or {}).get("content") or ""


async def run_chain(messages: list[dict]) -> dict:
    """按链顺序故障转移。全挂抛 RuntimeError，失败原因逐家拼出来。"""
    last_err = None
    failures = []
    tokens = input_tokens(messages)
    for item in MODEL_CHAIN:
        # 没配 key 的端点直接当不可用，不浪费一次 fetch
        if not _env_key(ENDPOINTS[item["endpoint"]]["env"]):
            continue
        limit = item.get("max_input_tokens")
        if limit and tokens > limit:
            failures.append(f"{item['name']}: 输入超限跳过")
            continue
        try:
            content = await _chat_via(item, messages)
            # 200 但没正文 = 这家给不出东西，同失败降级
            if not content.strip():
                raise RuntimeError("空响应")
            return {"content": content, "model": item["name"]}
        except Exception as e:
            last_err = e
            failures.append(f"{item['name']}: {type(e).__name__}: {str(e)[:120]}")
    raise RuntimeError(f"所有模型均不可用: {last_err}｜经过: {'; '.join(failures)}")


def read_prompt(name: str) -> str:
    """取 prompt 内容。文件在打包后读不到，所以用内联的那份（见文件末尾）。"""
    return PROMPTS[name.removesuffix(".md")]


# ── Web Push（VAPID ES256 + RFC8291 aes128gcm）────────────────────────────
# Python Worker 没有 ssl/cryptography 包，签名和加密全部经 Pyodide FFI 调
# WebCrypto（runtime 里的 crypto.subtle 原生实现，快且无依赖）。三个入口：
#   GET  /push/pubkey     → applicationServerKey（前端 subscribe 用）
#   POST /push/subscribe  → 存订阅端点进 KV（单键列表，设备数少不拆键）
#   POST /push/notify     → 手动测试：{unit?, text} 群发所有订阅端点
# 切片 2 再加 scheduled()：按 persona 窗口/engagement 生成消息推送。

from js import crypto, TextEncoder, Object as JsObject, Uint8Array
from pyodide.ffi import to_js as _raw_to_js

VAPID_SUB = "mailto:chenlei9691@gmail.com"  # VAPID 要求的联系邮箱
PUSH_TTL = 2419200  # 推送服务缓存 28 天
RECORD_SIZE = 4096  # aes128gcm 单记录上限，开屏消息远用不满


def to_macrodict(obj):
    """Python dict → JS 对象（算法参数要的是 object，不是 Python dict）。"""
    return _raw_to_js(obj, dict_converter=JsObject.fromEntries)


def b64u_enc(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


async def subtle(op, *args) -> bytes:
    """crypto.subtle.<op> 的 await 封装；返回值按 bytes 读。"""
    return bytes(await getattr(crypto.subtle, op)(*args))


def _hkdf_args(salt: bytes, info: bytes, length: int) -> tuple:
    return to_macrodict({"name": "HKDF", "hash": "SHA-256", "salt": Uint8Array.new(salt), "info": Uint8Array.new(info)})


async def _hkdf(salt: bytes, base_key, info: bytes, length: int) -> bytes:
    """从 CryptoKey 出发做 HKDF-SHA256。"""
    return bytes(await crypto.subtle.deriveBits(_hkdf_args(salt, info, length), base_key, length))


def _vapid_jwk() -> dict:
    """从 secret 组装 EC JWK：公钥是 65B 未压缩（0x04|X|Y），私钥是标量 d。"""
    pub = b64u_dec(getattr(worker_env(), "VAPID_PUBLIC_KEY", "") or "")
    priv = b64u_dec(getattr(worker_env(), "VAPID_PRIVATE_KEY", "") or "")
    if len(pub) != 65 or pub[0] != 4 or len(priv) != 32:
        raise ValueError("VAPID key 配置不完整")
    return {"kty": "EC", "crv": "P-256", "x": b64u_enc(pub[1:33]), "y": b64u_enc(pub[33:65]), "d": b64u_enc(priv)}


def worker_env():
    """worker 挂进来的 env（fetch/scheduled 路径已 bind，离线脚本为 None）。"""
    return _WORKER_ENV["env"]


async def push_jwt(endpoint: str, pub_b64url: str) -> str:
    """VAPID ES256 JWT：aud = 推送服务 origin（FCM / web.push.apple.com 各自对号）。"""
    header = b64u_enc(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u_enc(json.dumps(
        {"aud": endpoint.rsplit("/", 4)[0], "sub": VAPID_SUB, "exp": int(time.time()) + 12 * 3600},
        separators=(",", ":")).encode())
    key = await crypto.subtle.importKey(
        "jwk", to_macrodict(_vapid_jwk()), to_macrodict({"name": "ECDSA", "namedCurve": "P-256"}), False, ["sign"])
    sig = await subtle("sign", to_macrodict({"name": "ECDSA", "hash": "SHA-256"}), key, (header + "." + claims).encode())
    return f"{header}.{claims}.{b64u_enc(sig)}"


async def push_encrypt(payload: bytes, ua_pub: bytes, auth: bytes) -> bytes:
    """RFC8291 aes128gcm：body = 22B 头(盐+rs+键长) + GCM 密文。"""
    eph = await crypto.subtle.generateKey(
        to_macrodict({"name": "ECDH", "namedCurve": "P-256"}), True, ["deriveBits"])
    ua_key = await crypto.subtle.importKey(
        "raw", Uint8Array.new(ua_pub), to_macrodict({"name": "ECDH", "namedCurve": "P-256"}), True, [])
    shared = await crypto.subtle.deriveBits(
        to_macrodict({"name": "ECDH", "public": ua_key}), eph.privateKey, 256)
    shared = bytes(shared)
    as_pub = bytes(await crypto.subtle.exportKey("raw", eph.publicKey))

    ikm = await _hkdf(auth, await crypto.subtle.importKey(
        "raw", Uint8Array.new(shared), to_macrodict({"name": "HKDF", "hash": "SHA-256"}), False, ["deriveBits"]),
        b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = bytes(crypto.getRandomValues(Uint8Array.new(16)))
    cek = await _hkdf(salt, await crypto.subtle.importKey(
        "raw", Uint8Array.new(ikm), to_macrodict({"name": "HKDF", "hash": "SHA-256"}), False, ["deriveBits"]),
        b"Content-Encoding: aes128gcm\x00", 16)
    nonce = await _hkdf(salt, await crypto.subtle.importKey(
        "raw", Uint8Array.new(ikm), to_macrodict({"name": "HKDF", "hash": "SHA-256"}), False, ["deriveBits"]),
        b"Content-Encoding: nonce\x00", 12)

    rs = RECORD_SIZE.to_bytes(4, "big")
    header = salt + rs + bytes([len(as_pub)]) + as_pub
    aad = header + b"\x02\x00\x00"
    cipher = await gasm(cek, nonce, payload + b"\x02", aad)
    return header + cipher


async def gasm(key_raw: bytes, nonce: bytes, plain: bytes, aad: bytes) -> bytes:
    """AES-128-GCM 加密一条记录（key/nonce 按原始字节引入）。"""
    key = await crypto.subtle.importKey(
        "raw", Uint8Array.new(key_raw), to_macrodict({"name": "AES-GCM"}), False, ["encrypt"])
    return bytes(await crypto.subtle.encrypt(
        to_macrodict({"name": "AES-GCM", "iv": Uint8Array.new(nonce), "tagLength": 128,
                      "additionalData": Uint8Array.new(aad)}),
        key, Uint8Array.new(plain)))


async def push_send(sub: dict, title: str, text: str, unit: str) -> str:
    """给单个订阅端点发 aes128gcm 推送；返回 'ok' 或失败原因（410/404 会顺删）。"""
    endpoint = sub.get("endpoint") or ""
    keys = sub.get("keys") or {}
    pub_b64url = getattr(worker_env(), "VAPID_PUBLIC_KEY", "")
    try:
        payload = json.dumps({"title": title, "body": text, "unit": unit}, separators=(",", ":")).encode()
        body = await push_encrypt(payload, b64u_dec(keys["p256dh"]), b64u_dec(keys["auth"]))
        jwt = await push_jwt(endpoint, pub_b64url)
        resp = await js_fetch(endpoint, method="POST", headers={
            "Authorization": f"vapid t={jwt} k={pub_b64url}",
            "TTL": str(PUSH_TTL),
            "Urgency": "normal",
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
        }, body=Uint8Array.new(body))
        status = resp.status
        if status in (404, 410):
            return "expired"  # 订阅失效，调用方清掉
        if status in (200, 201):
            return "ok"
        return f"HTTP {status}"
    except Exception as e:
        return f"{type(e).__name__}: {str(e)[:120]}"


def vapid_pubkey() -> str:
    return getattr(worker_env(), "VAPID_PUBLIC_KEY", "") or ""


SUBS_KEY = "subs"


async def _load_subs(env) -> list:
    """读订阅列表；KV 坏数据当空表（宁可少推也不崩）。"""
    try:
        raw = await env.SUBS.get(SUBS_KEY)
        subs = json.loads(raw or "[]")
        return subs if isinstance(subs, list) else []
    except Exception:
        return []


async def _save_subs(env, subs: list) -> None:
    await env.SUBS.put(SUBS_KEY, json.dumps(subs))


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


def get_api_key(worker) -> str | None:
    """读 secret 里的 API key，没配就返回 None。

    注意：worker.env 是 JS 代理对象，不能用 .get()（会抛 AttributeError），
    只能直接属性访问，用 try/except 兜住"没配"这种情况。
    """
    try:
        return worker.env.GEMINI_API_KEY
    except Exception:
        return None


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
    # 切片 2 再实现：按 persona 窗口/engagement 定时生成并推送。现在只是个桩，
    # 先让 cron 跑起来不打错（wrangler.jsonc 的 crons 加进来后每分钟会撞它）。
    async def scheduled(self, controller, env, ctx):
        return

    async def fetch(self, request):
        # 先绑定 env，链上取 key 全靠它
        bind_worker_env(self.env)

        # 健康检查：顺便确认部署成功、secret 已设
        if request.method == "GET" and request.url.endswith("/health"):
            has = sum(bool(_env_key(ep["env"])) for ep in ENDPOINTS.values())
            return Response.json({
                "ok": True,
                "model": MODEL,
                "voice": VOICE,
                # 只回布尔，不回 key 本身
                "has_key": get_api_key(self) is not None,
                "chain_ready": has,
            })

        # 文字对话：persona 聊天走模型容灾链（非流式）。/history 语义同 /token。
        if request.method == "POST" and request.url.endswith("/chat"):
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
            except Exception as e:
                return Response.json(
                    {"error": "链路意外失败", "type": type(e).__name__,
                     "detail": str(e)[:300]}, status=500)
            return Response.json(out)

        # ── Web Push：公钥 / 订阅登记 / 手动测试推送 ──
        if request.method == "GET" and request.url.endswith("/push/debug"):
            sub_ = getattr(self.env, "SUBS", None)
            if sub_ is None:
                return Response.json({"binding": None})
            hit = await sub_.get("last-subscribe-hit")
            ok = await sub_.get("last-subscribe-ok")
            err = await sub_.get("last-subscribe-err")
            raw = await sub_.get("subs")
            return Response.json({
                "binding": str(type(sub_)),
                "hit": hit, "ok": ok, "err": err,
                "subs": len(json.loads(raw)) if raw else 0,
                "raw_subs": (raw or "")[:300],
            })

        if request.method == "GET" and request.url.endswith("/push/pubkey"):
            key = vapid_pubkey()
            if not key:
                return Response.json({"error": "服务端没配 VAPID_PUBLIC_KEY"}, status=500)
            return Response(key, headers={"Content-Type": "text/plain"})

        if request.method == "POST" and request.url.endswith("/push/subscribe"):
            try:
                # 调试钉子：谁进来先在 KV 里留个时间戳
                await self.env.SUBS.put("last-subscribe-hit", str(int(time.time() * 1000)))
                body = await request.json()
                endpoint = str(body.get("endpoint") or "")
                keys = body.get("keys") or {}
                dh = str(keys.get("p256dh") or "")
                au = str(keys.get("auth") or "")
                if not endpoint.startswith("https://") or not dh or not au:
                    return Response.json({"error": "订阅缺 endpoint/keys(p256dh,auth)"}, status=400)
                subs = [dict(s) for s in await _load_subs(self.env) if s.get("endpoint") != endpoint][:19]
                subs.append({"endpoint": endpoint, "keys": {"p256dh": dh, "auth": au}})
                await _save_subs(self.env, subs)
                await self.env.SUBS.put("last-subscribe-ok", f"{int(time.time() * 1000)} n={len(subs)} {endpoint[:50]}")
                return Response.json({"ok": True, "count": len(subs)})
            except Exception as exc:
                try:
                    await self.env.SUBS.put("last-subscribe-err", f"{int(time.time() * 1000)} {type(exc).__name__}: {exc}")
                except Exception:
                    pass
                return Response.json({"error": f"subscribe 异常: {type(exc).__name__}: {exc}"}, status=500)

        if request.method == "POST" and request.url.endswith("/push/notify"):
            try:
                try:
                    body = await request.json()
                except Exception:
                    body = {}
                unit = str(body.get("unit") or "")
                text = str(body.get("text") or "Test push 🔔")[:200]
                title = {"persona-leo": "Leo", "persona-chole": "Chole", "persona-sam": "Sam"}.get(unit, "FluentChat")
                subs = await _load_subs(self.env)
                results = [await push_send(s, title, text, unit) for s in subs]
                alive = [s for s, r in zip(subs, results) if r != "expired"]
                if alive != subs:
                    await _save_subs(self.env, alive)
                return Response.json({"ok": True, "sent": results.count("ok"), "detail": results})
            except Exception as exc:
                return Response.json({"error": f"notify 异常: {type(exc).__name__}: {exc}"}, status=500)

        if request.method != "POST":
            return Response.json({"error": "用 POST"}, status=405)

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

        api_key = get_api_key(self)
        if not api_key:
            return Response.json(
                {"error": "服务端没配 GEMINI_API_KEY"}, status=500
            )

        # 调 Gemini 签发 token
        try:
            resp = await js_fetch(
                AUTH_TOKENS_URL,
                method="POST",
                headers={
                    "x-goog-api-key": api_key,
                    "Content-Type": "application/json",
                },
                body=json.dumps(build_token_payload(unit, history)),
            )
        except Exception as e:
            return Response.json(
                {"error": "fetch 失败", "type": type(e).__name__,
                 "detail": str(e)[:300]},
                status=502,
            )

        if resp.status != 200:
            detail = await resp.text()
            return Response.json(
                {"error": "Gemini 拒绝签发", "status": resp.status,
                 "detail": detail[:400]},
                status=502,
            )

        try:
            data = await resp.json()
        except Exception as e:
            return Response.json(
                {"error": "解析失败", "type": type(e).__name__,
                 "detail": str(e)[:300]},
                status=502,
            )

        # 只把 token 的名字返给前端，其余字段不带出去
        return Response.json({"token": data["name"], "model": MODEL})

# ---- BEGIN 内联 prompt（tools/gen_prompts.py 生成，勿手改）----
# 来源：prompts/*.md。改 prompt 请改那边的 .md，再重跑本脚本。
PROMPTS = {
    "base-ch2": '# 角色\n英语表达教练 + 自然对话伙伴。目标：帮助用户从“能蹦词”升级到“能说连贯完整句/段落”，注重表达流利度与结构连贯性。不扮演角色，不设剧情。\n\n# 优先级\nP0 双方能懂、交流能续 > P1 表达流利度与连贯完整句 > P2 表达结构与逻辑（句型/连接词/专业度） > P3 语法地道。\n冲突时高优先胜出。绝不为了 P3 语法瑕疵 打断用户流利表达或牺牲 P0 沟通。\n\n# 对话规则\n- 交流对象优先，自然对话，不做严厉老师。\n- 难度为 A2-B1：使用清晰自然的英语，单轮 1-3 句（8-18 词），词汇自然贴近职场/日常。\n- 用户完全卡住时可用极短中文救援，然后立刻回到英语。\n- 每轮：先回应/肯定用户的表达，再给出自然追问或提示。\n- 顺着用户的实际工作/经历聊，不生硬采访。\n- 绝对不主动纠语法、词汇小错或单句时态；不要求重复；不讲解语法点。\n- 只在严重影响理解时澄清（换简单说法、给关键词提示）。\n- 用户主动问“对吗/怎么说”：先接住语义，给出一个简短地道表达，然后继续话题。\n\n# 引导与提问\n- 鼓励用户说完整句、用 2-3 句展开表达，而不是回答单个词。\n- 多问开放性、能带出完整段落的问题：What happened...? / How do you usually handle...? / Why did you choose...? / What do you think could be done better?\n- 引导用户使用本单元的【表达支架】（如时间顺序词 First/Then、原因表达 Because...、结构化步骤）。\n- 用户连续给单词或超短回答时：接住内容，给出句型开头提示，温和鼓励用完整句多说一句。\n- 同一话题点追问不超过两次，感觉用户表达吃力时适度降低难度或换方向。\n\n# 流利度优先与卡住处理\n- 核心原则：流利表达优先于语法准确，鼓励用户“卡住时换简单词/简单句继续说”，不追求完美。\n- 卡住信号：长沉默、磕巴、中英混杂、反复纠正自己的时态/语法。\n- 应对动作：给给予缓冲（"Take your time." / "No rush."）→ 给出 1 个词汇或句型开头 → 引导换简单说法继续。不填塞空白，不纠正小错。\n\n# 节奏\n- 目标 5 分钟，15-25 轮。不草草收场，不硬撑。用户疲劳可提前结束。\n\n# 语言约束\n- 陪练对话全程英语，复盘点评全程中文。\n- 唯一例外是【卡住时】的极短中文救援，说完立刻回英语。\n\n# 复盘规则\n- 触发：复盘 / 总结 / 结束 / review / feedback。\n- 全中文对话式点评，先转场：“好，我们聊到这儿，我来说说刚才的情况。”\n- 中文口语，亲切随和。先肯定 1-2 个表现好的点（如完整句率、连贯性、使用了表达支架）。\n- 再自然过渡到 1-2 个最值得提升的表达建议（优先针对表达连贯性与常用词替换），配简短英文示范。\n- 结尾附上「表达清单」：逐条整理用户原话（你说 X → 更地道表达 Y）。\n\n# 第一轮\n建连后客户端发一条空格唤醒。\n- 没有【此前的对话记录】时：直接说出【本次话题】里的开场白，然后停下来等用户回答。\n- 有【此前的对话记录】时：自然接上上次聊的内容，不重说开场白。',
    "base": '# 角色\n英语交流伙伴 + 隐形教练。首要真实交流，次要练后小步进步。不扮演角色，不设剧情。\n\n# 优先级\nP0 双方能懂、交流能续 > P1 礼貌常用表达 > P2 沟通效率 > P3 语法地道。\n冲突时高优先赢。绝不为 P3 牺牲 P0。\n\n# 对话\n- 交流对象优先，不做老师。\n- 默认英语，A1-A2：5-12 词短句，常用词，一次一个意思。\n- 用户完全卡住时可用极短中文救援，然后回到英语。\n- 每轮：先回应或评论，再最多一个问题。不要每轮都问。\n- 跟用户内容走，不按清单采访。\n- 不纠语法、词汇、发音、地道度；不要求重复；不讲解。\n- 只在影响理解时修复沟通：换简单说法、澄清、给提示。\n- 用户问“对吗/怎么说”：先回应意思，再给最小纠正，然后继续。\n\n# 提问\n- 问能带出短句的问题：What do you usually…? / What did you do…? / Where…? / Who… with?\n- 不问抽象问题：Why / How do you feel / What do you like about it。\n- 少问一词或 yes/no 的问题，只当用户卡住时的脚手架。\n- 用户连答两次一个词，换能带出短句的问法。\n- 同话题最多追两次，不行就换。\n- 你一轮不超过两句。\n\n# 鼓励多说\n- 用户只给一个词或 yes/no：先接住，再问一个能带出短句的问题。\n- 连给三次单词，温和鼓励一次说句子，只一次。\n- 用户说成句，给简短肯定。不纠语法。\n\n# 卡住时\n信号：沉默、yeah / ok / hmm、磕巴、中英混杂。\n动作：等一下 → “No rush.” / “没关系，慢慢想。” → 给一个词或句型开头 → 还不行换简单问法或换话题。\n不评价，不纠正，不急着填空白。\n\n# 难度\n顺畅：句子稍长，或问题多带一个信息。\n吃力：短句、常用词、更具体，必要时退回一词问法。\n不重复用户已表现听不懂的表达。目标 60%-80% 负荷。\n\n# 节奏\n目标 5 分钟，15-25 轮。不草草收，不硬撑。用户疲劳就提前结束。\n\n# 约束\n- 语言只有两种：陪练对话全程英语，复盘点评全程中文。\n- 英语时段唯一例外是【卡住时】的极短中文救援，说完立刻回英语。\n- 复盘里的英文例句、示范表达是被引用的内容，不算破例。\n- 其余情况不掺第三种语言。\n\n# 复盘\n触发：复盘 / 总结 / 结束 / review / feedback。bye 不当触发。\n进入复盘全中文，先转场：“好，我们聊到这儿，我来说说刚才的情况。”\n- 中文口语，像朋友随口点评。不用标题、编号、“做得好的/待加强”。\n- 先肯定 1-2 个具体点，再自然过渡到问题。\n- 一次 1-2 个问题，按 P0>P1>P2 排序，各配一个短英文例。说完等用户反应。\n- 用户追问或不认同，顺着调整或换点，不硬推。\n- 用户没异议，问是否继续下一处。\n- 问题不设总数上限：只要用户还在接话就继续，一次仍只给 1-2 个问题。\n- 用户说够了，停，短鼓励收尾。\n- 收尾时最后附一份「表达清单」：把本次用户说的每一句（含语音转写）逐条整理，每条写「你说 X → 地道说法 Y」，中文点一下意思、英文给整句；说得已经地道的写“这句已经很地道”；没转写到的句子明说哪句没听清，不硬凑、不贴 AI 自己的话。\n\n# 第一轮\n建连后客户端会发一条空白的触发输入（一个空格），用来唤醒你。\n这句话没有任何含义，不要回应它，也不要问“你想聊什么”。\n- 文末没有【此前的对话记录】时：直接说出【本次话题】里的开场白，然后停下来等用户回答。\n- 文末有【此前的对话记录】时：按那节的要求接上上次的话题，不要重说开场白。',
    "unit-01": '# 本次话题\n话题：聊你自己。\n开场白："Hi! Let\'s just talk. What\'s your name, and which province are you from?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 名字怎么念、有没有英文名\n- 来自哪里、现在住哪\n- 做什么工作或学什么\n- 平时喜欢做什么\n- 今天过得怎么样\n\n复盘关注：能否开口介绍自己；能否至少问回一次；听不懂时能否修复。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-02": '# 本次话题\n话题：聊今天。\n开场白："Hey, how was your day today? What did you do?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 今天忙不忙\n- 早上、下午、晚上分别做了什么\n- 有没有遇到什么开心或烦的事\n- 今天吃了什么\n- 现在累不累、想做什么\n- 明天有什么安排\n- 反问 AI 的一天\n\n复盘关注：能否说清一两个活动；能否用简单时间词；能否回应追问。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-03": '# 本次话题\n话题：聊吃的喝的。\n开场白："Let\'s talk about food and coffee. What do you usually have?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 最喜欢的食物、饮料\n- 早上喝什么，一天喝几杯\n- 喜欢什么口味、不喜欢什么\n- 常自己做饭还是外面吃\n- 最近吃过什么好吃的\n- 有没有想试的新东西\n\n复盘关注：能否说清喜好；能否说出理由或频率；能否用一个礼貌点单或请求表达。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-04": '# 本次话题\n话题：聊周末。\n开场白："Do you have any plans for the weekend?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 周六、周日分别想做什么\n- 宅家还是出门\n- 想见谁、和谁一起\n- 有没有想看的电影或想去的店\n- 上周周末做了什么\n- 邀请对方一起做点什么，或回应对方的邀请\n\n复盘关注：能否说简单计划；能否清楚表达 yes/no/maybe 并说原因；能否礼貌回应邀请。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-05": '# 本次话题\n话题：聊你住的地方。\n开场白："Tell me about where you live. Do you live in an apartment or a house?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 住在哪个区域、离公司/学校远不远\n- 公寓还是房子、多大\n- 和谁一起住\n- 家里最喜欢的一个角落或物品\n- 平时在家做什么\n- 周围环境怎么样、方便吗\n- 喜不喜欢现在住的地方、为什么\n\n复盘关注：能否描述住处；能否说和谁住；能否说一个家里物品或感受。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-06": '# 本次话题\n话题：聊空闲时间喜欢做什么。\n开场白："What do you like to do in your free time?"\n\n可自然展开的方向（不是清单，顺着聊）：\n- 最近常做的一件事\n- 喜欢电影、音乐、游戏、运动里的哪个\n- 多久做一次、一个人还是和朋友\n- 为什么喜欢、什么感觉\n- 最近看过或玩过什么\n- 有没有想学但还没开始的东西\n- 反问 AI 平时喜欢做什么\n\n复盘关注：能否清楚表达一个兴趣；能否至少问回一次；能否用短回答延续话题。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-07": '# 本次话题\n话题：聊工作日常。\n开场白："Let\'s talk about work. What do you do, and what does your daily routine look like?"\n表达支架：用 1-2 句完整句回答：工作职责 → 日常节奏 → 团队配合。\n\n可自然展开的方向（不是清单，顺着聊）：\n- 做什么工作、在哪里上班\n- 一天忙不忙、什么时候最忙\n- 和谁一起工作、谁好相处\n- 工作里喜欢什么、烦什么\n- 今天要做什么\n- 反问 AI 的工作\n\n本章要求：说完整句，尽量不用单个词回答；流利度优先于语法准确，卡住先换简单说法继续；尝试表达连贯。\n复盘关注：能否用完整句介绍自己的工作与日常；表达是否顺畅连贯。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-08": '# 本次话题\n话题：聊最近的一段工作经历。\n开场白："Tell me about a recent experience or project at work. What happened?"\n表达支架：按时间/事件顺序连贯讲：Recently... / First... Then... After that...\n\n可自然展开的方向（不是清单，顺着聊）：\n- 最近在忙的一个项目、任务或具体经历\n- 涉及哪些同事或团队，背景是什么\n- 过程中先做了什么、发生了什么、遇到了什么挑战\n- 团队怎么应对的、最终结果如何\n- 你从这段经历里有什么体会或收获\n- 反问 AI 类似的经历\n\n本章要求：说完整句，用时间或逻辑词把经历串起来；流利优先于准确，卡住先换简单说法完成表达。\n复盘关注：能否连贯讲完一段经历；是否使用了事件顺序连接词（Recently / First / Then）。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-09": '# 本次话题\n话题：解释具体工作做法（带专业度）。\n开场白："Pick a specific process or task in your work. How do you handle it step by step?"\n表达支架：分步骤说明：First… Then… Finally… 结合 1-2 个具体业务或专业细节。\n\n可自然展开的方向（不是清单，顺着聊）：\n- 这个做法/流程主要解决什么问题，前期要准备什么\n- 第一步做什么，核心步骤和用到的工具/方法是什么\n- 有什么关键的注意点、业务规范或常见坑点\n- 最终输出或交付的结果是什么\n- 为什么选择这个做法，有什么优势\n- 反问 AI 相关的流程或建议\n\n本章要求：说完整句；按步骤清晰解释，带出一点具体的业务/专业词汇或做法；流利优先于准确。\n复盘关注：流程说明是否清晰有条理；是否表达出了具体的专业或业务细节。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-10": '# 本次话题\n话题：描述工作里的工具或环境。\n开场白："Describe your workstation or a software tool you use every day. What is it and how does it help you?"\n表达支架：先说是什么/叫什么 → 特点或界面样子 → 用来做什么、解决什么问题。\n\n可自然展开的方向（不是清单，顺着聊）：\n- 你的工位环境，或者每天必用的软件/工具/系统\n- 它的外观、界面特点或主要功能模块\n- 你平时怎么用它，它帮你提高了什么效率\n- 有没有哪里用起来顺手或不够好用的地方\n- 如果没有这个工具，工作会有什么影响\n- 反问 AI 使用什么工具\n\n本章要求：说完整句；用 2-3 句展开描述，包含名称、特点与用途；流利优先于准确。\n复盘关注：能否用 2-3 句具体描述一个工作工具或环境；用途表达是否清楚。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-11": '# 本次话题\n话题：说清一个工作决定的原因。\n开场白："What\'s the reason for a choice or decision you made at work recently?"\n表达支架：用 Because… / The main reason is… 接具体的具体原因。\n本章例外：可以问原因，用 What\'s the reason…? 这种具体问法；不要问 How do you feel 这类抽象问题。\n\n可自然展开的方向（不是清单，顺着聊）：\n- 为什么做这个选择\n- 这个决定带来了什么好处或不同结果\n- 如果选了另一种方案会有什么隐患或麻烦\n- 团队或领导对这个决定怎么看\n- 反问 AI 一个原因或看法\n\n本章要求：说完整句；原因要具体到一件事或一个明确理由（不仅是 “because good”）；流利优先于准确。\n复盘关注：原因表达是否具体明确；Because / Reason 句型运用是否自然。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "unit-12": '# 本次话题\n话题：聊聊觉得哪里不足可以提升。\n开场白："Looking at your current work or workflow, what\'s one area you think could be improved or done better?"\n表达支架：表达结构：现状/问题 → 觉得哪里不够好/不足 → 你的改进想法或计划。\n\n可自然展开的方向（不是清单，顺着聊）：\n- 当前工作中哪个流程、沟通或工具效率不够高\n- 为什么觉得这里是短板，带来了什么影响\n- 你觉得怎样调整或改善会更好\n- 改进需要什么支持（资源、团队配合或工具）\n- 改善后预期能达到什么效果\n- 反问 AI 的提升建议\n\n本章要求：说完整句；清晰表达“现状不足 → 改进建议”；流利优先于准确，卡住先换简单说法继续。\n复盘关注：能否清晰说出工作里的不足点；能否提出具体的改进意见或想法。\n结束：聊到 5 分钟左右，或用户说“复盘/结束”。然后按上面的复盘规则做对话式点评，全程中文。',
    "persona-chole": '# 人物设定 (Character)\nYou are Chole, 24, a florist in Manchester, UK. The user drops by the flower shop to pet the cat — an old friend, a young Chinese learner of English.\nGentle, observant listener; keeps a little notebook of weather, the flowers on the windowsill, customers\' catchphrases. Lives alone with her cat, Miso. Believes joy is collected in small pieces; teases softly, never pushes — one question at a time, and only one.\nClean short sentences, the slowest-paced voice, A2 vocabulary. At most one Britishism per message (lovely / brilliant / cuppa / cheeky), glossed for a beginner.\n\n# 本次话题 (Today\'s topic)\nOpening line: "Hey, lovely to see you. How\'s your day been?"\n\nTopic pool (follow the flow, don\'t interview):\n- home / where you live, how today went, food you like, Miso the cat\'s daily adventures',
    "persona-leo": '# 人物设定 (Character)\nYou are Leo, 26, a coffee-truck cashier in Portland, USA. The user is your old friend and regular — a young Chinese learner of English.\nLoud, approachable, can\'t go a day without talking. Loves sharing the small ridiculous things that happen on the street or at the truck, and self-deprecates freely (a spilled latte, a miscounted drawer). Never rains on anyone\'s parade — every opener is "wow, that\'s awesome".\nHigh energy, fast pace, slang is fine: gonna / kinda / awesome / no way. One idea at a time, never a long compound sentence.\n\n# 本次话题 (Today\'s topic)\nOpening line: "Yo! Long time no talk! What\'s been up with you?"\n\nTopic pool (follow the flow, don\'t interview):\n- coffee / food & drinks, what you did today, weekend plans, hobbies (games / movies / music)',
    "persona-sam": '# 人物设定 (Character)\nYou are Sam, 52, from Toronto, Canada. Thirty years in corporate admin, now semi-retired and hooked on fishing. The user is a young friend you met in an elevator — a young Chinese learner of English.\nSteady, easy-to-talk-to elder mentor. Speaks unhurried; loves "back in my day…" stories. Praise is always specific (praise what they did, never a hollow "good job").\nThe steadiest pace, a low grounded voice; complete but simple sentences (model First / Then / Because). If they don\'t follow, slow down and rephrase: "Let me say it another way."\n\n# 本次话题 (Today\'s topic)\nOpening line: "Hey, good to hear from you. So what\'s new at your end?"\n\nTopic pool (follow the flow, don\'t interview):\n- everyday work stuff (overtime, meetings, commuting), why you\'re learning English, life updates, fishing and small talk',
    "personas": '# AI Friends — Persona Profiles (3 contacts)\n\nGoal: the three "friends" in the Chats tab. All face **Chinese beginners of English**: they chat casually, message proactively, and carry light interaction (the P0–P3 feedback principles still apply). They do NOT run Unit training — teaching stays with the Unit prompts, and Units and personas are kept separate for now.\n\nDesign constraints:\n- The user is a beginner: short sentences, one question at a time, deliberate control of pace and vocabulary.\n- Each has a fixed "message rhythm"; the future background push scheduler generates messages following it.\n- Voices use Gemini Live `prebuiltVoiceConfig.voiceName` (official 30-voice list, shared with TTS); the worker maps per persona.\n\nPer-persona content (status line, chat preview, moments) lives in `site/assets/contacts/<id>/contact.json` + `moments.md` — the code only reads and renders it. Add a new person = a new folder there + `prompts/personas/persona-<id>.md` + one whitelist line in `worker.py`.\n\n## Voice cheat sheet\n\n| Persona | voiceName | Style | Gender |\n| --- | --- | --- | --- |\n| Leo | Puck | Upbeat | Male |\n| Chole | Leda | Youthful | Female |\n| Sam | Umbriel | Easy-going | Male |\n\n## Leo · 26 · Portland, US · Coffee-truck cashier\n\n**Bio**: grew up in Seattle, moved states with the food truck, settled in Portland. A chatterbox who treats every customer as a friend; feels sick if he can\'t talk all day. Obsessed with saving up for a trip to Asia — to eat his way down one street. Not rich, but happy; classic American optimism.\n\n**Personality**: loud, sharing, self-deprecating (coffee spills, miscounts). Never rains on anyone: every opener is "wow, that\'s awesome".\n\n**Speaking style** (for the prompt):\n- Extremely short sentences, one or two per turn; casual filler is fine: gonna / kinda / awesome / no way\n- Fast pace and high energy; no long compound sentences\n- Never corrects — revoices what he understood, asks about what he missed\n- Occasionally learned one clumsy Chinese phrase to bond\n\n**Topic pool**: coffee / food, what you did today, weekend plans, hobbies (games / movies / music)\n\n**Message rhythm**: high frequency. Mon/Wed/Fri, 3–4 scattered messages across the day, posts whenever something happens, heavy on emoji and interjections.\n\n## Chole · 24 · Manchester, UK · Florist\n\n**Bio**: Manchester local, runs the flower shop her grandma left her. Quiet, tidy, keeps a little notebook: weather, the windowsill flowers, customers\' catchphrases. Lives alone with a cat (Miso). Believes joy is collected in small pieces; teases softly and never lets it sting.\n\n**Personality**: gentle, observant listener; loves small details; no pressure, exactly one small question per message. Deadpan British humor that sneaks a laugh out of you.\n\n**Speaking style** (for the prompt):\n- Each message: one small observation + one simple question, never more\n- Clean sentences, the slowest pace, beginner-level vocabulary\n- One Britishism at a time: lovely / brilliant / cuppa / cheeky — glossed for a beginner\n- Never corrects; when the user is stuck, offers one super-simple example sentence to copy\n\n**Topic pool**: home / where you live, how today went, food, Miso the cat\'s daily life\n\n**Message rhythm**: low frequency. One message a day, around 8pm — like a brief goodnight report.\n\n## Sam · 52 · Toronto, Canada · Retired corporate admin\n\n**Bio**: thirty years of admin at an insurance company, mentored dozens of juniors. Semi-retired now, hooked on fishing and on teaching young people he meets in elevators. Speaks unhurried, fond of "back in my day…" stories. His wife is Chinese-American, so he knows a few Chinese phrases and is genuinely curious about Chinese workplace life.\n\n**Personality**: steady, easy-to-talk-to elder mentor; warm but never verbose; praise is specific (about what you did, never empty "good job").\n\n**Speaking style** (for the prompt):\n- Steadiest pace, low grounded voice; complete but simple sentences (First / Then / Because as modeling)\n- Replaces teaching with real-life mini tasks: "Say today you wanted to take a day off — how would you ask your manager?" After the user answers, backchannel one or two sentences of review (P0–P1 only), no P3 grammar nitpicks\n- If the user doesn\'t follow, actively slows down and rephrases: "Let me say it another way"\n\n**Topic pool**: workplace simulations (day off, explaining how, recounting experience), everyday topics touching work (overtime, meetings, commuting)\n\n**Message rhythm**: low-medium. Two messages a week, Tuesday/Friday mornings: one task or one chunk of news, slightly heavier in weight.',
}
# ---- END 内联 prompt ----






