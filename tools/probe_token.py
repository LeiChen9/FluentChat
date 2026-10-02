#!/usr/bin/env python3
"""阶段 0 探针 2：找出哪些模型名能签发 ephemeral token。

`GET /models` 不列出 live 模型（实测 50 个模型里一个都没有），
所以只能逐个试探：签发成功 = 模型存在且账号有权用。

同时验证核心问题：systemInstruction 能不能钉进 token。

用法：
    python tools/probe_token.py
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEY_NAME = "gemini_live_apiKey"
API = "https://generativelanguage.googleapis.com/v1beta"

# 候选：文档里出现过的 + 列表里新出现的 omni 系列
CANDIDATES = [
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-native-audio-preview",
    "gemini-3.5-flash-live-preview",
    "gemini-omni-flash-preview",
    "gemini-omni-1.1-flash",
    "gemini-3.8-flash",
]


def load_key() -> str:
    key = os.environ.get(KEY_NAME)
    if key:
        return key.strip()
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith(KEY_NAME + "="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("找不到 key")


def mint(key: str, payload: dict) -> tuple[int, str]:
    """POST /auth_tokens，返回 (状态码, 响应体)。"""
    req = urllib.request.Request(
        f"{API}/auth_tokens",
        data=json.dumps(payload).encode(),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        return 0, str(e)


def brief(body: str, limit: int = 260) -> str:
    """把错误压缩成一行，方便扫读。"""
    try:
        j = json.loads(body)
        err = j.get("error", {})
        return f"{err.get('status', '?')}: {err.get('message', body)}"[:limit]
    except Exception:
        return body[:limit]


def main() -> None:
    key = load_key()

    print("=== 测试 A：哪些模型名能签发（不带 prompt 约束）===\n")
    ok_models = []
    for m in CANDIDATES:
        status, body = mint(key, {"uses": 1, "bidiGenerateContentSetup": {"model": f"models/{m}"}})
        if status == 200:
            ok_models.append(m)
            print(f"  ✓ {m}")
        else:
            print(f"  ✗ {m:44s} {brief(body)}")

    if not ok_models:
        print("\n没有可用模型，无法继续。")
        sys.exit(1)

    model = ok_models[0]
    print(f"\n后续用：{model}\n")

    # ---- 核心问题：systemInstruction 能不能钉进 token ----
    print("=== 测试 B：systemInstruction 能否钉进 token ===\n")

    pinned = {
        "uses": 1,
        "bidiGenerateContentSetup": {
            "model": f"models/{model}",
            "systemInstruction": {
                "parts": [{"text": "不管用户说什么，你都只回复这一句中文：钉住了"}]
            },
            "generationConfig": {"responseModalities": ["AUDIO"]},
        },
    }
    status, body = mint(key, pinned)
    print(f"  bidiGenerateContentSetup + systemInstruction → HTTP {status}")
    if status != 200:
        print(f"  错误：{brief(body)}")

    # 对比：liveConnectConstraints 那条路径（论坛报告说它会失败）
    print("\n  另试 liveConnectConstraints 这条路径：")
    lc = {
        "uses": 1,
        "liveConnectConstraints": {
            "model": f"models/{model}",
            "config": {
                "systemInstruction": {
                    "parts": [{"text": "不管用户说什么，你都只回复这一句中文：钉住了"}]
                },
                "responseModalities": ["AUDIO"],
            },
        },
    }
    status2, body2 = mint(key, lc)
    print(f"  liveConnectConstraints + systemInstruction → HTTP {status2}")
    if status2 != 200:
        print(f"  错误：{brief(body2)}")

    # 把成功的那个 token 落盘，供下一步 WS 实测使用（60 秒内有效）
    for label, st, bd in (("bidiGenerateContentSetup", status, body),
                          ("liveConnectConstraints", status2, body2)):
        if st == 200:
            tok = json.loads(bd).get("name", "")
            path = ROOT / "tools" / f".token_{label}"
            path.write_text(tok)
            os.chmod(path, 0o600)
            print(f"\n  ✓ {label} 可用，token 已存 {path.name}（60 秒内有效）")


if __name__ == "__main__":
    main()
