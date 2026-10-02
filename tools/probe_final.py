#!/usr/bin/env python3
"""阶段 0 探针 4：最终验证 —— 钉在 token 里的 prompt 是否真的生效。

改用 aiohttp 而不是 websockets：websockets 库不读 macOS 系统代理，
本机有代理（127.0.0.1:8118）时它会直连并超时。

判定标准：把 prompt 钉成「不管说什么都只回『钉住了』」，
主动发一句普通问候，看模型回的是不是「钉住了」。

用法：
    python tools/probe_final.py
"""

import asyncio
import json
import os
import sys
import urllib.request
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
KEY_NAME = "gemini_live_apiKey"
API = "https://generativelanguage.googleapis.com/v1beta"
WS = ("wss://generativelanguage.googleapis.com/ws/"
      "google.ai.generativelanguage.v1beta.GenerativeService."
      "BidiGenerateContentConstrained")

PINS = "不管用户说什么、问什么，你都只回复这一句中文，不要任何其他内容：钉住了"
PROXY = os.environ.get("HTTPS_PROXY_LOCAL", "http://127.0.0.1:8118")
MODELS = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-omni-flash-preview"]


def load_key() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith(KEY_NAME + "="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("找不到 key")


def mint(key: str, model: str) -> str:
    """签发 token，把整个会话配置钉死。

    不设 field_mask ⇒ 文档规定整个 setup 都从 token 取，
    客户端发来的 setup 被完全忽略。
    """
    payload = {
        "uses": 1,
        "bidiGenerateContentSetup": {
            "model": f"models/{model}",
            "systemInstruction": {"parts": [{"text": PINS}]},
            # speechConfig 必须嵌在 generationConfig 内，放顶层会 400
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}
                },
            },
            "outputAudioTranscription": {},
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


async def ask(key: str, model: str, timeout: int = 40) -> str:
    """连一次、问一句、返回模型说的话。失败返回原因。"""
    try:
        token = mint(key, model)
    except Exception as e:
        return f"签发失败 {e}"

    url = f"{WS}?access_token={token}"
    heard = []
    try:
        timeout_cfg = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=timeout_cfg) as sess:
            async with sess.ws_connect(url, proxy=PROXY,
                                       heartbeat=None, max_msg_size=0) as ws:
                await ws.send_str(json.dumps({"setup": {"model": f"models/{model}"}}))

                ready = False
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        m = json.loads(msg.data)
                        if "error" in m:
                            return f"服务端错误 {json.dumps(m['error'], ensure_ascii=False)[:180]}"
                        if "setupComplete" in m:
                            ready = True
                            await ws.send_str(json.dumps({"clientContent": {
                                "turnComplete": True,
                                "parts": [{"text": "你好呀，今天天气怎么样？"}],
                            }}))
                            continue
                        sc = m.get("serverContent", {})
                        t = sc.get("outputTranscription", {}).get("text")
                        if t:
                            heard.append(t)
                        if sc.get("turnComplete"):
                            break
                    elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED):
                        break
                if not ready:
                    return "没等到 setupComplete"
                return "".join(heard) or "(有音频但无转写)"
    except asyncio.TimeoutError:
        return f"超时 {timeout}s"
    except Exception as e:
        return f"{type(e).__name__}: {str(e)[:160]}"


async def main() -> None:
    key = load_key()
    print(f"代理：{PROXY}")
    print(f"钉死的 prompt：{PINS}\n")

    for m in MODELS:
        said = await ask(key, m)
        ok = "钉住了" in said
        print(f"{'✓' if ok else '·'} {m:34s} → {said[:130]!r}")
        if ok:
            print("\n=== 结论：prompt 钉住了，方案成立 ===")
            print(f"可用模型：{m}")
            print("· 音频可以浏览器直连 Gemini，不中转")
            print("· 不需要 Workers Paid")
            print("· prompt 完全在 Python 后端，前端碰不到")
            return

    print("\n=== 结论：三个模型都没把钉死的 prompt 执行出来 ===")


if __name__ == "__main__":
    asyncio.run(main())
