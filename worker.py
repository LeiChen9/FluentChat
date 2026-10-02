"""FluentChat 后端：给前端签发 Gemini Live 的一次性 token。

职责边界（很重要，别越界）：
- 只做一件事：拼 prompt → 调 Gemini 签发 ephemeral token → 返回给前端
- 音频不经过这里。浏览器拿 token 后 WSS 直连 Gemini，走自己的网络。
  原因：免费版 Worker CPU 上限扛不住音频流，中转还会产生费用。

这样前端就碰不到 API key，也碰不到 prompt —— prompt 钉在 token 里，
服务端强制生效，用户改不了。
"""

import json
from pathlib import Path

from js import fetch
from workers import Response, WorkerEntrypoint

# Gemini 接口地址
AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens"

# 已实测可用的 Live 模型。注意它不出现在 /v1beta/models 列表里，
# 所以别用那个列表选模型，列不出来不代表不能用。
MODEL = "gemini-3.8-live"

# 音色。已实测接受：Kore / Puck / Charon / Aoede / Zephyr / Laomedeia
VOICE = "Kore"

PROMPT_DIR = Path(__file__).parent / "prompts"

# 允许的 Unit 白名单。前端只能传这些 id，避免任意文件读取。
UNITS = {f"unit-{i:02d}" for i in range(1, 7)}


def read_prompt(name: str) -> str:
    """读一个 prompt 文件。"""
    return (PROMPT_DIR / name).read_text(encoding="utf-8").strip()


def build_system_instruction(unit: str) -> str:
    """把基础教学规则和本次 Unit 的话题拼成一份完整 prompt。

    顺序有讲究：先给通用对话规则，再给本次话题。
    后写的更贴近当前任务，模型更容易听话题部分的。
    """
    return f"{read_prompt('base.md')}\n\n{read_prompt(f'{unit}.md')}"


def get_api_key(worker) -> str | None:
    """读 secret 里的 API key，没配就返回 None。

    注意：worker.env 是 JS 代理对象，不能用 .get()（会抛 AttributeError），
    只能直接属性访问，用 try/except 兜住"没配"这种情况。
    """
    try:
        return worker.env.GEMINI_API_KEY
    except Exception:
        return None


def build_token_payload(unit: str) -> dict:
    """构造签发请求体。

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
                "parts": [{"text": build_system_instruction(unit)}]
            },
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {"voiceName": VOICE}
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
        # 健康检查：顺便确认部署成功、secret 已设
        if request.method == "GET" and request.url.endswith("/health"):
            return Response.json({
                "ok": True,
                "model": MODEL,
                "voice": VOICE,
                # 只回布尔，不回 key 本身
                "has_key": get_api_key(self) is not None,
            })

        if request.method != "POST":
            return Response.json({"error": "用 POST"}, status=405)

        try:
            body = await request.json()
        except Exception:
            return Response.json({"error": "请求体不是合法 JSON"}, status=400)

        unit = body.get("unit")
        if unit not in UNITS:
            return Response.json(
                {"error": f"unit 必须是 {sorted(UNITS)} 之一"}, status=400
            )

        api_key = get_api_key(self)
        if not api_key:
            return Response.json(
                {"error": "服务端没配 GEMINI_API_KEY"}, status=500
            )

        # 调 Gemini 签发 token
        resp = await fetch(
            AUTH_TOKENS_URL,
            method="POST",
            headers={
                "x-goog-api-key": api_key,
                "Content-Type": "application/json",
            },
            body=json.dumps(build_token_payload(unit)),
        )

        if resp.status != 200:
            detail = await resp.text()
            return Response.json(
                {"error": "Gemini 拒绝签发", "status": resp.status,
                 "detail": detail[:400]},
                status=502,
            )

        data = await resp.json()

        # 只把 token 的名字返给前端，其余字段不带出去
        return Response.json({"token": data["name"], "model": MODEL})