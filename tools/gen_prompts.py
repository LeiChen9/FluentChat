"""把 prompts/*.md 的内容生成 backend/prompt_data.py。

为什么生成源码而不读原始 .md：Cloudflare Python Worker 里 .md 以 JS text
模块形式打包，Python 的 open() 读不到，prompt 必须编进 Python。

为什么单独一个文件：模块导入在线上是可靠的（argus/backend 的多模块
Python Worker 已实测），早期把 PROMPTS 内联进 worker.py 是过度谨慎，
混成一个大文件反而难维护。worker.py 只 import，不碰本文件。
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "backend" / "prompt_data.py"

HEADER = '"""自动生成：tools/gen_prompts.py，勿手改。\n来源：prompts/*.md + site/assets/contacts/*/persona.md。\n改 prompt 请改那边的 .md，再重跑本脚本。\n"""\n\nPROMPTS = {\n'

lines = [HEADER]
sources = sorted((ROOT / "prompts").rglob("*.md")) + \
    sorted((ROOT / "site/assets/contacts").glob("*/persona.md"))
for f in sources:
    key = f.stem if "contacts" not in f.parts else f"persona-{f.parts[-2]}"
    lines.append(f'    "{key}": {f.read_text(encoding="utf-8").strip()!r},\n')
lines.append("}\n")

OUT.write_text("".join(lines), encoding="utf-8")
print(f"已生成 {OUT.relative_to(ROOT)}（{len(sources)} 个 prompt）")
