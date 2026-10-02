#!/usr/bin/env python3
"""阶段 0 探针：确认 API key 可用，并列出账号里真正可用的 live 模型。

用法：
    python tools/probe_live.py

只读操作，不会产生任何费用，也不会打印 key。
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# .env 里 key 的名字（保持和用户原有命名一致，不擅自改动）
KEY_NAME = "gemini_live_apiKey"

API = "https://generativelanguage.googleapis.com/v1beta"


def load_key() -> str:
    """从 .env 读 key。优先用环境变量，其次读文件；不打印内容。"""
    key = os.environ.get(KEY_NAME)
    if key:
        return key.strip()

    env = ROOT / ".env"
    if not env.exists():
        sys.exit(f"找不到 {env}")
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith(KEY_NAME + "="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit(f".env 里没有 {KEY_NAME}")


def main() -> None:
    key = load_key()
    print(f"key 已读取，长度 {len(key)} 字符\n")

    # ---- 测试 1 + 2：key 是否还有效，以及能列出哪些模型 ----
    url = f"{API}/models?key={key}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"✗ HTTP {e.code}\n{body[:800]}")
        print("\n如果是 400/403 且提到 API key not valid 或 unrestricted，"
              "说明 key 未加限制（2026-06-19 起停止接受）。")
        sys.exit(1)
    except Exception as e:  # 网络问题
        sys.exit(f"✗ 请求失败：{e}")

    models = [m["name"].split("/")[-1] for m in data.get("models", [])]
    print(f"✓ key 有效，共 {len(models)} 个模型\n")

    live = sorted(m for m in models if "live" in m or "native-audio" in m)
    if not live:
        print("✗ 没有 live / native-audio 模型\n")
    else:
        print("可用的 live 模型：")
        for m in live:
            print(f"  · {m}")

    print("\n全部模型名（便于判断命名规律）：")
    for m in sorted(models):
        print(f"  {m}")


if __name__ == "__main__":
    main()
