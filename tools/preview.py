#!/usr/bin/env python
"""把抠出来的 PNG 合成到候选底色上，用 ASCII 看它看不看得清。"""

import sys
import numpy as np
from PIL import Image

sys.path.insert(0, "tools")
from extract_npc import ascii_art  # noqa: E402

src = sys.argv[1]
im = Image.open(src).convert("RGBA")
rgb = np.array(im)[..., :3].astype(np.float64)
a = (np.array(im)[..., 3].astype(np.float64) / 255.0)[..., None]

# ASCII 用 gamma 偏重的映射，暗部才看得清
# 底色跟 site/css/app.css 的 --bg 一致（全站只做浅色，深色已移除）
for name, bg in (("浅色 #FAF6EE", (250, 246, 238)),):
    comp = rgb * a + np.array(bg, float) * (1 - a)
    print(f"--- {name} ---")
    print(ascii_art(comp.mean(axis=2), chars=" .:-=+*#%@"))
    print()

# 可见性硬指标：主体和底色的亮度差
fg = a[..., 0] > 0.5
print(f"主体占 {fg.mean()*100:.1f}%")
print("主体内亮度分布 " + "  ".join(
    f"p{p}={np.percentile(rgb.mean(axis=2)[fg], p):.0f}" for p in (1, 5, 25, 50, 75, 95)))