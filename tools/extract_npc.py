#!/usr/bin/env python
"""
抠出线条画主体 -> 透明 PNG。

做法：不靠颜色（奶白猫身和粉蓝渐变背景明度几乎一样，靠颜色分不开），
而是靠轮廓线做闭合边界，从图外把背景「灌」进来，被挡住的就是主体。

用法：<python> tools/extract_npc.py <in> <out.png>
"""

import sys
import numpy as np
import cv2
from PIL import Image

INK_THR = 222      # 低于此亮度算「墨」（笔画）
CLOSE_K = 13       # 闭运算核，补 JPEG 造成的轮廓断口
FEATHER = 1.2


def luminance(rgb):
    return (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.uint8)


def ink_barrier(lum, thr=INK_THR, close_k=CLOSE_K):
    ink = (lum < thr).astype(np.uint8)
    if close_k > 1:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k))
        ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k)
    return ink


def subject_from_barrier(ink):
    """从四条边往里灌背景，灌不到的就是主体。"""
    free = (ink == 0).astype(np.uint8)
    n, lab = cv2.connectedComponents(free, 4)
    edge = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    return ~np.isin(lab, list(edge))


def keep_main(subject, min_frac=0.01):
    n, lab, st, _ = cv2.connectedComponentsWithStats(subject.astype(np.uint8), 8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        keep[i] = st[i, cv2.CC_STAT_AREA] > subject.size * min_frac
    return keep[lab]


def soft_alpha(mask):
    """距离场 -> alpha，边缘 1px 羽化，去 JPEG 振铃。"""
    m = mask.astype(np.uint8)
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    alpha = np.clip(dist / FEATHER, 0, 1)
    return cv2.GaussianBlur(alpha, (0, 0), 0.7)


def ascii_art(field, cols=72, chars=" .:-=+*#%@"):
    h, w = field.shape
    rows = max(1, int(cols * h / w * 0.42))
    out = []
    for r in range(rows):
        line = ""
        for c in range(cols):
            y0, y1 = int(r * h / rows), max(int((r + 1) * h / rows), int(r * h / rows) + 1)
            x0, x1 = int(c * w / cols), max(int((c + 1) * w / cols), int(c * w / cols) + 1)
            v = field[y0:y1, x0:x1].mean()
            line += chars[min(int(v / 256 * len(chars)), len(chars) - 1)]
        out.append(f"{r:2d}|{line}")
    return "\n".join(out)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    rgb = np.array(Image.open(src).convert("RGB"))
    lum = luminance(rgb)

    mask = keep_main(subject_from_barrier(ink_barrier(lum)))

    print(f"前景占比 {mask.mean()*100:.1f}%")
    print("\n--- 亮度图 ---")
    print(ascii_art(lum))
    print("\n--- 掩膜（# 为主体） ---")
    print(ascii_art(mask * 255, chars=" " + "." * 8 + "#"))

    alpha = soft_alpha(mask)
    a8 = (alpha * 255).astype(np.uint8)
    ys, xs = np.nonzero(a8 > 10)
    pad = 2
    x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    x1, y1 = min(rgb.shape[1], xs.max() + 1 + pad), min(rgb.shape[0], ys.max() + 1 + pad)
    rgba = np.dstack([rgb, a8])[y0:y1, x0:x1]
    im = Image.fromarray(rgba, "RGBA")

    # 只量化 RGB，alpha 原样保留 —— FASTOCTREE 直接量化 RGBA 会把 alpha 压扁
    q = im.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT)
    out = Image.fromarray(np.dstack([np.array(q.convert("RGB")), rgba[..., 3]]), "RGBA")
    # WebP 带 alpha 只要 41KB，PNG 要 197KB。iOS 14+ 原生支持。
    out.save(dst, format="WEBP", quality=95, method=6)

    # 诊断：我看不到图，只能靠数字
    fg = a8 > 128
    L = lum.astype(np.float64)
    fg_lum = L[fg]
    soft = ((a8 > 10) & (a8 < 245)).sum() / max((a8 > 10).sum(), 1) * 100
    print(f"\ncrop {x1-x0}x{y1-y0}  (原图 {rgb.shape[1]}x{rgb.shape[0]})")
    print(f"alpha 范围 {out.getchannel('A').getextrema()}  内部最大 {a8[fg].max()}")
    print(f"主体亮度 均值 {fg_lum.mean():.0f} 中位 {np.median(fg_lum):.0f} "
          f"范围 {fg_lum.min():.0f}-{fg_lum.max():.0f}")
    print(f"背景亮度 均值 {L[~fg].mean():.0f}")
    print(f"软边占比 {soft:.1f}%   硬边比例 {100-soft:.1f}%")
    print(f"-> {dst}")


if __name__ == "__main__":
    main()