#!/usr/bin/env python3
"""诊断：服务端为什么直接断开。

普通端点 + API key 发送 setup 后被立刻断开。逐项加字段 + 抓 close code。
"""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
PLAIN = ("wss://generativelanguage.googleapis.com/ws/"
         "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent")
PROXY = "http://127.0.0.1:8118"
M = "gemini-3.8-live"


def key_of():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith("gemini_live_apiKey="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("no key")


VARIANTS = [
    ("1 只有 model", {"model": f"models/{M}"}),
    ("2 + AUDIO 模态", {"model": f"models/{M}",
                        "generationConfig": {"responseModalities": ["AUDIO"]}}),
    ("3 + systemInstruction(parts 形式)", {
        "model": f"models/{M}",
        "generationConfig": {"responseModalities": ["AUDIO"]},
        "systemInstruction": {"parts": [{"text": "只回复：钉住了"}]}}),
    ("4 + systemInstruction(纯字符串)", {
        "model": f"models/{M}",
        "generationConfig": {"responseModalities": ["AUDIO"]},
        "systemInstruction": "只回复：钉住了"}),
    ("5 snake_case 全小写", {
        "model": f"models/{M}",
        "generation_config": {"response_modalities": ["AUDIO"]},
        "system_instruction": {"parts": [{"text": "只回复：钉住了"}]}}),
    ("6 TEXT 模态", {"model": f"models/{M}",
                     "generationConfig": {"responseModalities": ["TEXT"]},
                     "systemInstruction": {"parts": [{"text": "只回复：钉住了"}]}}),
]


async def one(key, label, setup, wait=20):
    t = aiohttp.ClientTimeout(total=wait + 10)
    try:
        async with aiohttp.ClientSession(timeout=t) as s:
            async with s.ws_connect(f"{PLAIN}?key={key}", proxy=PROXY, heartbeat=None,
                                   max_msg_size=0, receive_timeout=wait) as ws:
                await ws.send_str(json.dumps({"setup": setup}))
                got = []
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        d = json.loads(msg.data)
                        if "error" in d:
                            got.append(f"ERROR {json.dumps(d['error'], ensure_ascii=False)[:180]}")
                            break
                        sc = d.get("serverContent", {})
                        t_ = sc.get("outputTranscription", {}).get("text")
                        if t_:
                            got.append(f"说:{t_!r}")
                        got.append("+".join(k for k in d if k != "serverContent") or "-")
                        if sc.get("turnComplete"):
                            break
                if not got:
                    return f"零消息 close_code={ws.close_code}"
                return " ".join(got[:5]) + f" close_code={ws.close_code}"
    except aiohttp.WSServerHandshakeError as e:
        return f"握手被拒 HTTP {e.status} {str(e.message)[:150]}"
    except asyncio.TimeoutError:
        return f"[{wait}s 零消息] close_code={ws.close_code if 'ws' in dir() else '?'}"
    except Exception as e:
        return f"{type(e).__name__}: {str(e)[:130]}"


async def main():
    k = key_of()
    for label, setup in VARIANTS:
        print(f"{label:36s} → {await one(k, label, setup)}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
