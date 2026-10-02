#!/usr/bin/env python3
"""诊断：哪个模型名能真正让 Gemini Live 开口。

已排除：代理（第三方 echo 正常往返）、WS 栈、token 签发、endpoint 类型。
剩下的变量就是模型名。

用法：python tools/probe_models.py
"""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
API = "https://generativelanguage.googleapis.com/v1beta"
PLAIN = ("wss://generativelanguage.googleapis.com/ws/"
         "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")
PROXY = "http://127.0.0.1:8118"
PINS = "不管用户说什么，你都只回复这一句中文：钉住了"

MODELS = [
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview",
    "gemini-3.5-flash-live-preview",
    "gemini-2.5-flash-native-audio-preview",
    "gemini-omni-flash-preview",
    "gemini-3.8-flash",
]


def key_of():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith("gemini_live_apiKey="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("no key")


async def one(key, model, wait=25):
    """用普通端点 + API key 直连，排除 token 这一层变量。"""
    url = f"{PLAIN}?key={key}"
    setup = {
        "setup": {
            "model": f"models/{model}",
            "systemInstruction": {"parts": [{"text": PINS}]},
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig":
                                 {"prebuiltVoiceConfig": {"voiceName": "Kore"}}},
            },
            "outputAudioTranscription": {},
        }
    }
    heard = []
    t = aiohttp.ClientTimeout(total=wait + 15)
    try:
        async with aiohttp.ClientSession(timeout=t) as s:
            async with s.ws_connect(url, proxy=PROXY, heartbeat=None,
                                   max_msg_size=0, receive_timeout=wait) as ws:
                await ws.send_str(json.dumps(setup))
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    d = json.loads(msg.data)
                    if "error" in d:
                        return f"服务端错误 {json.dumps(d['error'], ensure_ascii=False)[:170]}"
                    sc = d.get("serverContent", {})
                    txt = sc.get("outputTranscription", {}).get("text")
                    if txt:
                        heard.append(txt)
                    if "setupComplete" in d:
                        await ws.send_str(json.dumps({"clientContent": {
                            "turnComplete": True,
                            "parts": [{"text": "你好呀，今天天气怎么样？"}]}}))
                    if sc.get("turnComplete"):
                        break
        return "".join(heard) or "(通了但无转写)"
    except asyncio.TimeoutError:
        return f"[{wait}s 零消息]"
    except Exception as e:
        return f"{type(e).__name__}: {str(e)[:140]}"


async def main():
    k = key_of()
    for m in MODELS:
        print(f"{m:44s} → {await one(k, m)}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
