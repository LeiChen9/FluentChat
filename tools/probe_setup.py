#!/usr/bin/env python3
"""诊断：Constrained token 下，客户端 setup 该怎么发。

现象：握手成功，但发 setup 之后服务端完全不回（连 setupComplete 都没有）。
逐个试不同的 setup 写法，看哪种能让服务端开口。

用法：python tools/probe_setup.py
"""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
API = "https://generativelanguage.googleapis.com/v1beta"
WS = ("wss://generativelanguage.googleapis.com/ws/"
      "google.ai.generativelanguage.v1beta.GenerativeService."
      "BidiGenerateContentConstrained")
PLAIN_WS = ("wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService."
            "BidiGenerateContent")
PROXY = "http://127.0.0.1:8118"
M = "gemini-3.8-live"
PINS = "不管用户说什么，你都只回复这一句中文：钉住了"


def key_of():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith("gemini_live_apiKey="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("no key")


def mint(key, **extra):
    setup = {
        "model": f"models/{M}",
        "systemInstruction": {"parts": [{"text": PINS}]},
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}},
        },
        "outputAudioTranscription": {},
    }
    setup.update(extra)
    req = urllib.request.Request(
        f"{API}/auth_tokens",
        data=json.dumps({"uses": 1, "bidiGenerateContentSetup": setup}).encode(),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["name"]


async def listen(url, first, label, wait=18):
    print(f"\n--- {label} ---", flush=True)
    t = aiohttp.ClientTimeout(total=wait + 12)
    try:
        async with aiohttp.ClientSession(timeout=t) as s:
            async with s.ws_connect(url, proxy=PROXY, heartbeat=None,
                                   max_msg_size=0, receive_timeout=wait) as ws:
                print("  握手成功", flush=True)
                if first is not None:
                    await ws.send_str(json.dumps(first))
                    print(f"  已发: {json.dumps(first, ensure_ascii=False)[:90]}", flush=True)
                got = 0
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        got += 1
                        d = json.loads(msg.data)
                        sc = d.get("serverContent", {})
                        tag = ",".join(k for k in d if k != "serverContent")
                        out = sc.get("outputTranscription", {}).get("text")
                        extra = f" OUT={out!r}" if out else ""
                        if "error" in d:
                            extra = f" ERROR={json.dumps(d['error'], ensure_ascii=False)[:220]}"
                        print(f"  收到 {got}: {tag}{extra}", flush=True)
                        if "setupComplete" in d and label != "无 setup":
                            await ws.send_str(json.dumps({"clientContent": {
                                "turnComplete": True,
                                "parts": [{"text": "你好呀，今天天气怎么样？"}]}}))
                            print("     → 已发文字轮次", flush=True)
                    if got >= 6:
                        break
                if not got:
                    print(f"  [{wait}s 内零消息]", flush=True)
    except asyncio.TimeoutError:
        print(f"  超时（无消息）", flush=True)
    except Exception as e:
        print(f"  ✗ {type(e).__name__}: {str(e)[:200]}", flush=True)


async def main():
    k = key_of()

    # 变体 1：Constrained + 最小 setup
    t1 = mint(k)
    await listen(f"{WS}?access_token={t1}", {"setup": {"model": f"models/{M}"}},
                 "1 Constrained + 最小 setup")

    # 变体 2：Constrained + 完全相同的完整 setup
    t2 = mint(k)
    await listen(f"{WS}?access_token={t2}", {"setup": {
        "model": f"models/{M}",
        "systemInstruction": {"parts": [{"text": PINS}]},
        "generationConfig": {"responseModalities": ["AUDIO"],
                             "speechConfig": {"voiceConfig":
                                              {"prebuiltVoiceConfig": {"voiceName": "Kore"}}}},
        "outputAudioTranscription": {}}},
        "2 Constrained + 完整 setup")

    # 变体 3：Constrained + 空 setup
    t3 = mint(k)
    await listen(f"{WS}?access_token={t3}", {"setup": {}}, "3 Constrained + 空 setup")

    # 变体 4：Constrained + 不发 setup
    t4 = mint(k)
    await listen(f"{WS}?access_token={t4}", None, "4 Constrained + 无 setup")

    # 变体 5（对照）：普通端点 + 直接 API key，验证这条 WSS 本身能不能出消息
    await listen(f"{PLAIN_WS}?key={k}", {"setup": {
        "model": f"models/{M}",
        "generationConfig": {"responseModalities": ["AUDIO"]},
        "outputAudioTranscription": {}}},
        "5 对照：普通端点 + API key")


if __name__ == "__main__":
    asyncio.run(main())
