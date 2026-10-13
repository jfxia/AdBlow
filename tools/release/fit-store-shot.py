"""把整屏截图规整为商店要求的精确尺寸（1280×800 或 640×400）。

## 为什么需要

Edge 加载项商店对截图尺寸有硬性校验，只接受 1280×800 或 640×400。
而整屏截图的尺寸取决于显示器（1440×900、1920×1080、2560×1440…），
直接上传会被拒。

## 两种处理方式

    fit   —— 等比缩放后**补边**到目标尺寸（整屏内容全保留，两侧或上下留底色）
    crop  —— 等比缩放后**居中裁剪**到目标尺寸（画面更"满"，边缘内容会被切掉）

默认 `fit`：不丢内容，最安全。可先用 fit 出一版看看效果。

用法：
    python tools/release/fit-store-shot.py <输入.png> <输出.png> [--mode crop] [--bg auto|#RRGGBB]

例：
    python tools/release/fit-store-shot.py ~/shot.png store/store-1280x800-popup-zhCN.png
"""

from __future__ import annotations

import os
import sys

from PIL import Image

SIZES = {(1280, 800): "1280x800", (640, 400): "640x400"}


def sample_bg(im: Image.Image) -> tuple[int, int, int]:
    """取四角出现最多的颜色作补边底色（通常是页面或主题背景）。"""
    w, h = im.size
    corners = [im.getpixel(p) for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    counts: dict[tuple[int, int, int], int] = {}
    for c in corners:
        counts[c[:3]] = counts.get(c[:3], 0) + 1
    return max(counts, key=lambda k: counts[k])


def fit(im: Image.Image, size: tuple[int, int], bg: tuple[int, int, int]) -> Image.Image:
    """等比缩放 + 居中标到目标画布。"""
    scale = min(size[0] / im.size[0], size[1] / im.size[1])
    scaled = im.resize((max(1, round(im.size[0] * scale)), max(1, round(im.size[1] * scale))), Image.LANCZOS)
    canvas = Image.new("RGB", size, bg)
    canvas.paste(scaled, ((size[0] - scaled.size[0]) // 2, (size[1] - scaled.size[1]) // 2))
    return canvas


def crop(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """等比缩放到"至少覆盖目标"，再居中裁剪。"""
    scale = max(size[0] / im.size[0], size[1] / im.size[1])
    scaled = im.resize((max(1, round(im.size[0] * scale)), max(1, round(im.size[1] * scale))), Image.LANCZOS)
    left = (scaled.size[0] - size[0]) // 2
    top = (scaled.size[1] - size[1]) // 2
    return scaled.crop((left, top, left + size[0], top + size[1]))


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        raise SystemExit(2)

    src, dst = args
    mode = "crop" if any(f == "--mode=crop" or f == "--crop" for f in flags) else "fit"
    bg_flag = next((f.split("=", 1)[1] for f in flags if f.startswith("--bg=")), "auto")

    target = (1280, 800) if "640x400" not in os.path.basename(dst) else (640, 400)

    im = Image.open(src).convert("RGB")
    bg = sample_bg(im) if bg_flag == "auto" else tuple(int(bg_flag.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4))

    out = crop(im, target) if mode == "crop" else fit(im, target, bg)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    out.save(dst, "PNG", optimize=True)

    size_name = SIZES[target]
    print(f"  {os.path.basename(src)}  {im.size[0]}x{im.size[1]}  --{mode}-->  {dst}  {size_name}")
    print(f"  补边底色 {bg}" + ("（crop 模式不使用）" if mode == "crop" else ""))
    if im.size == target:
        print("  （原图已是目标尺寸，内容未改动）")


if __name__ == "__main__":
    main()
