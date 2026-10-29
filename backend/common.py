"""普适工具：环境绑定、secret 读取、模型容灾链、KV 订阅存取。不含业务。

worker.py 只做路由与组装，对这里的函数只做调用。
写法对照 argus/backend/common.py。

Web Push 拆分：本模块只管订阅的存取；VAPID 签名与加密在 JS 侧
pusher Worker 里（web-push 库），Python 不碰。
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

from workers import fetch as js_fetch

# Worker 侧 bindings 注入（照搬 argus 的 bind_worker_env）：fetch 进来时把
# self.env 存在这里，链上取 key 都走它。离线脚本里它为空，链视为不可用。
_WORKER_ENV = {"env": None}


def bind_worker_env(env) -> None:
    """每次 fetch 先调：绑定本 isolate 的 env。"""
    _WORKER_ENV["env"] = env


def env_key(name: str) -> str | None:
    """读 secret 名对应的值。worker.env 是 JS 代理对象，不能用 .get()
    （会抛 AttributeError），只能直接属性访问，try/except 兜住「没配」。
    env 没绑定（离线脚本）或没配该 secret 时返回 None。
    """
    wenv = _WORKER_ENV["env"]
    if wenv is None:
        return None
    try:
        val = getattr(wenv, name)
    except Exception:
        return None
    return str(val) if val else None


def input_tokens(messages: list[dict]) -> int:
    """估输入 token 数，给 groq 的闸门用。西文 4 字符/token、CJK 1 字/token。"""
    def est(s: str) -> int:
        ascii_len = len(s.encode("ascii", errors="ignore"))
        return (len(s) - ascii_len) + ascii_len // 4
    return sum(est(m.get("content") or "") for m in messages)


# ── 文字对话的模型容灾链（参考 argus/backend/common.py 的写法）──────────────
# 场景差异：社交媒体聊天不要求实时，链全挂就直接报错，恢复交给以后的重试层。
# 没有流式（SSE 砍掉）、没有 tools、语音 /token 一条路不掺和。

# 端点表：base_url / secret 名 / 额外请求头的唯一事实源。
# 加一家只改这里 + MODEL_CHAIN 一行。
ENDPOINTS = {
    "agnes": {"base_url": "https://apihub.agnes-ai.com/v1/", "env": "AGNES_API_KEY"},
    "kilo": {"base_url": "https://ai-gateway.kilo.ai/api/v1/", "env": "KILO_API_KEY"},
    "cohere": {"base_url": "https://api.cohere.ai/compatibility/v1/", "env": "COHERE_API_KEY"},
    "requesty": {"base_url": "https://router.requesty.ai/v1/", "env": "REQUESTY_API_KEY"},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1/", "env": "OPENROUTER_API_KEY"},
    "groq": {"base_url": "https://api.groq.com/openai/v1/", "env": "GROQ_API_KEY"},
    "opencode": {
        "base_url": "https://opencode.ai/zen/go/v1/",
        "env": "OPENCODE_API_KEY",
        # zen 中转要求稳定 session 与自报 UA
        "headers": {"User-Agent": "fluentchat/0.1",
                    "x-opencode-session": "fluentchat"},
    },
}

# Groq 免费层输入上限 8000 token/分钟，超了直接 413。按估算提前跳过。
# 西文约 4 字符/token、CJK 约 1 字/token，刻意高估——低估会把被拒的请求
# 放进去，高估只是提前跳过一个模型，不改变链的正确性。
GROQ_MAX_INPUT_TOKENS = 7000

# DeepSeek 只在非峰段入链：北京时间周一至周五 9-12、14-18 会被限流。
DEEPSEEK_PEAK = frozenset(range(9, 12)) | frozenset(range(14, 18))


def deepseek_open(now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone(timedelta(hours=8)))
    if now.weekday() >= 5:
        return True
    return now.hour not in DEEPSEEK_PEAK


# 模型链：照搬 argus 实测可用的条目，只留我们有 key 的端点。OpenCode zen 的
# deepseek / glm 固定打头；deepseek 只在非峰段入链（无节假日表，周末
# 与工作日非峰段放行）。gemini 不入——唯一那把 key 是语音专用的。
MODEL_CHAIN = [
    {"name": "deepseek-v4.1-flash", "endpoint": "opencode", "gate": "off_peak"},
    {"name": "glm-5.3-flash", "endpoint": "opencode"},
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


async def _chat_via(item: dict, messages: list[dict]) -> str:
    """单模型单试。20s 兜底：光等响应头，管不住上游收了请求不吐字节的挂法。"""
    ep = ENDPOINTS[item["endpoint"]]
    url = ep["base_url"] + "chat/completions"
    payload = json.dumps({"model": item["name"], "messages": messages})
    headers = {"Authorization": f"Bearer {env_key(ep['env'])}",
               "Content-Type": "application/json"}
    headers.update(ep.get("headers") or {})
    resp = await asyncio.wait_for(
        js_fetch(url, method="POST", headers=headers, body=payload),
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
        if not env_key(ENDPOINTS[item["endpoint"]]["env"]):
            continue
        if item.get("gate") == "off_peak" and not deepseek_open():
            failures.append(f"{item['name']}: 峰段跳过")
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
            print(f"[chain] {item['name']} failed: {type(e).__name__}: {str(e)[:120]}")
    raise RuntimeError(f"所有模型均不可用: {last_err}｜经过: {'; '.join(failures)}")


# ── Web Push 订阅存取 ──────────────────────────────────────────────────────
# The Python Worker stores subscriptions; the bound JS Worker owns VAPID and encryption.
# 订阅登记在各人名下（{user}/subs.json），横幅发给谁、谁的失效该清谁才对得上号。


async def _load_subs(env, user: str) -> list:
    """读该用户的订阅列表；文件在 {user}/subs.json，坏数据当空表（宁可少推也不崩）。"""
    try:
        obj = await env.DATA.get(f"{user}/subs.json")
        subs = json.loads(await obj.text()) if obj is not None else []
        return subs if isinstance(subs, list) else []
    except Exception:
        return []


async def _save_subs(env, user: str, subs: list) -> None:
    await env.DATA.put(f"{user}/subs.json", json.dumps(subs))


def vapid_pubkey(env) -> str:
    return getattr(env, "VAPID_PUBLIC_KEY", "") or ""
