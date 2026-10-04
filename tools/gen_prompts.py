"""把 prompts/*.md 的内容注入 worker.py 的 INLINE 区。

为什么不单独放一个 prompts_data.py：实测 Python Worker 崩在 Worker 层，
拿不到异常详情，没法确认模块导入是否可靠。写进 worker.py 自身就没有
导入这一步 —— 它必然被打包。

Cloudflare Python Worker 也读不到打包进来的 .md（那是以 JS text 模块
形式存在的，Python 的 open() 读不到）。所以只能编进源码。
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker.py"

BEGIN = "# ---- BEGIN 内联 prompt（tools/gen_prompts.py 生成，勿手改）----"
END = "# ---- END 内联 prompt ----"

lines = ['# ---- BEGIN 内联 prompt（tools/gen_prompts.py 生成，勿手改）----\n',
         "# 来源：prompts/*.md。改 prompt 请改那边的 .md，再重跑本脚本。\n",
         "PROMPTS = {\n"]
for f in sorted((ROOT / "prompts").rglob("*.md")):
    lines.append(f'    "{f.stem}": {f.read_text(encoding="utf-8").strip()!r},\n')
lines.append("}\n")
lines.append(END + "\n")

block = "".join(lines)
src = WORKER.read_text(encoding="utf-8")

if BEGIN in src:
    head, rest = src.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    WORKER.write_text(head + block + tail, encoding="utf-8")
else:
    WORKER.write_text(src + "\n\n" + block, encoding="utf-8")

print(f"已注入 {len(list((ROOT / 'prompts').rglob('*.md')))} 个 prompt 到 worker.py")