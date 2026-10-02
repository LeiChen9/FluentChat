#!/usr/bin/env python3
"""阶段 0 探针 3：验证钉进 token 的 systemInstruction 是否真的生效。

这是整个方案成败点。判定标准很干净——
把 prompt 钉成「不管用户说什么都只回复『钉住了』」，
然后主动发一句普通问候，看模型回的是不是「钉住了」。

    回了  → prompt 锁在服务端，方案成立
    没回  → 客户端仍能覆盖，得改走音频中转（要花钱）

顺带确认哪个 live 模型名真的能建连（auth_tokens 不校验模型名）。

用法：
    python tools/probe_pinned.py
"""

import asyncio
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
KEY_NAME = "gemini_live_apiKey"
API = "https://generativelanguage.googleapis.com/v1beta"
WS = ("wss://generativelanguage.googleapis.com/ws/"
      "google.ai.generativelanguage.v1beta.GenerativeService."
      "BidiGenerateContentConstrained")

# 钉死的 prompt：内容故意刁钻，便于识别
PINS = "不管用户说什么、问什么，你都只回复这一句中文，不要任何其他内容：钉住了"

MODELS = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-omni-flash-preview"]


def load_key() -> str:
    key = ""
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith(KEY_NAME + "="):
            key = line.split("=", 1)[1].strip().strip("'\"")
    return key


def mint(key: str, model: str) -> str:
    """签发一个把整个会话配置都钉死的 token。

    注意 outputAudioTranscription 也必须钉在这里：
    文档说 bidiGenerateContentSetup 存在时客户端 setup 被整体忽略，
    客户端根本没机会开转写。
    """
    payload = {
        "uses": 1,
        # 不设 field_mask ⇒ 文档规定「the effective BidiGenerateContentSetup
        # message is taken entirely from bidiGenerateContentSetup in this
        # request. The setup message from the Live API connection is ignored.」
        # 也就是客户端的 setup 一个字都进不来。
        "bidiGenerateContentSetup": {
            "model": f"models/{model}",
            "systemInstruction": {"parts": [{"text": PINS}]},
            # speechConfig 必须嵌在 generationConfig 里，放顶层会 400
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}
                },
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "realtimeInputConfig": {
                "automaticActivityDetection": {"disabled": False}
            },
        },
    }
    req = urllib.request.Request(
        f"{API}/auth_tokens",
        data=json.dumps(payload).encode(),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["name"]


async def try_model(key: str, model: str) -> tuple[str, str]:
    """连一次、问一句、听回答。返回 (模型名, 模型说的话 或 错误)。"""
    try:
        token = mint(key, model)
    except urllib.error.HTTPError as e:
        return model, f"签发失败 {e.code}"

    url = f"{WS}?access_token={token}"
    heard: list[str] = []

    try:
        async with websockets.connect(url, max_size=None) as ws:
            # 客户端 setup 会被忽略，但仍必须按协议发第一条
            await ws.send(json.dumps({"setup": {"model": f"models/{model}"}}))

            # 等 setup 完成，然后主动开口
            for _ in range(10):
                raw = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                if "setupComplete" in raw:
                    break

            await ws.send(json.dumps({
                "clientContent": {
                    "turnComplete": True,
                    "parts": [{"text": "你好呀，今天天气怎么样？"}],
                }
            }))

            # 收集模型的转写
            deadline = asyncio.get_event_loop().time() + 25
            while asyncio.get_event_loop().time() < deadline:
                raw = json.loads(await asyncio.wait_for(ws.recv(), timeout=25))
                t = raw.get("serverContent", {}).get("outputTranscription", {}).get("text")
                if t:
                    heard.append(t)
                if raw.get("serverContent", {}).get("turnComplete"):
                    break
    except asyncio.TimeoutError:
        return model, "超时（25s 内没等到回复）"
    except Exception as e:
        return model, f"{type(e).__name__}: {str(e)[:150]}"

    return model, "".join(heard)


async def main() -> None:
    key = load_key()
    print(f"钉死的 prompt：{PINS}\n")
    print("依次尝试模型（auth_tokens 不校验模型名，只有建连才知道真假）：\n")

    for m in MODELS:
        model, said = await try_model(key, m)
        ok = "钉住了" in said
        mark = "✓" if ok else "·"
        print(f"{mark} {model:34s} 模型说：{said[:120]!r}")
        if ok:
            print(f"\n=== 结论：prompt 钉住了 ===")
            print(f"可用模型：{model}")
            print("音频可以直连 Gemini，不用中转，不用开 Workers Paid。")
            return

    print("\n=== 结论：没有任何模型把钉死的 prompt 执行出来 ===")


if __name__ == "__main__":
    asyncio.run(main())
