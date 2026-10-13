"""把原始截图合成为商店要求的 1280×800 素材。

## 为什么不直接上传浏览器抓的原图

    - popup 只有 320px 宽：直接放进 1280×800 会有大片空白
    - 浏览器抓的 options 图高度跟内容走（433/473），不是 800

## 做法

    - options：按**抓图自身的背景色**补到 1280×800（同色填充 → 视觉上无缝）
    - popup  ：2 倍原图居中，垫一层圆角白卡片与柔和阴影，底用品牌渐变
      （取图标同一组 #7C5CFF → #3B2FD1，界面与图标是同一套视觉语言）

用法：python tools/release/compose-store-shots.py
"""

from __future__ import annotations

import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
STORE = os.path.join(ROOT, "store")

W, H = 1280, 800
BRAND_TOP = (124, 92, 255)
BRAND_BOTTOM = (59, 47, 209)


def gradient(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / (w - 1) + y / (h - 1)) / 2
            px[x, y] = (
                round(BRAND_TOP[0] + (BRAND_BOTTOM[0] - BRAND_TOP[0]) * t),
                round(BRAND_TOP[1] + (BRAND_BOTTOM[1] - BRAND_TOP[1]) * t),
                round(BRAND_TOP[2] + (BRAND_BOTTOM[2] - BRAND_TOP[2]) * t),
            )
    return img


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def compose_options(path: str, force: bool = False) -> str:
    """把 options 原始截图规整为 1280×800。

    原始图可能是"整页"尺寸（宽高都超 1280×800），所以要**先裁到 1280×800**
    再按底色补足，而不是只裁不缩放 —— 直接 paste 会让画布右边/下边露出空白。
    """
    im = Image.open(path).convert("RGB")
    # Guard: refuse to build a deliverable from an undersized capture, so a bad raw
    # can never silently become the store screenshot.
    if im.size[0] < W or im.size[1] < H:
        raise SystemExit(
            f"[!!] {os.path.basename(path)} is {im.size[0]}x{im.size[1]}, smaller than the "
            f"required {W}x{H} — re-capture before composing."
        )
    bg = im.getpixel((2, im.size[1] - 2))  # 左下角取样：页面底色
    canvas = Image.new("RGB", (W, H), bg)
    # 从左上角取 1280×800 视口范围（页面内容自上而下，取顶部即可）
    view = im.crop((0, 0, min(W, im.size[0]), min(H, im.size[1])))
    canvas.paste(view, (0, 0))
    out = path.replace("raw-options", "store-1280x800-options")
    if os.path.exists(out) and not force:
        # 交付物是**手工挑选**的资产（见 store/README.md）：默认绝不覆盖。
        return (
            f"{os.path.basename(out)}  已存在，跳过（要覆盖请加 --force）"
            f"  ← 现有 {Image.open(out).size[0]}x{Image.open(out).size[1]}"
        )
    canvas.save(out, "PNG", optimize=True)
    return (
        f"{os.path.basename(out)}  原始 {im.size[0]}x{im.size[1]} → 取 "
        f"{view.size[0]}x{view.size[1]} → {W}x{H}（底色补白 {bg}）"
    )


def autocrop_content(im: Image.Image, margin: int = 0) -> Image.Image:
    """裁到"与角落底色不同"的像素边界。

    浏览器抓的是整个视口（我们设了 340×300 以留余量），而 popup 内容只有
    320×H —— 不裁的话内容会偏在卡片左上角，四周一大圈空白。
    """
    bg = im.getpixel((0, 0))
    w, h = im.size
    px = im.load()
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 12:
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x < 0:
        return im
    return im.crop(
        (
            max(0, min_x - margin),
            max(0, min_y - margin),
            min(w, max_x + 1 + margin),
            min(h, max_y + 1 + margin),
        )
    )


def compose_popup(path: str, force: bool = False) -> str:
    """品牌渐变底 + 圆角白卡片 + 阴影，居中放 popup 的 2 倍图。"""
    raw = Image.open(path).convert("RGBA")
    popup = autocrop_content(raw)
    card_w, card_h = popup.size
    pad = 24
    card = Image.new("RGBA", (card_w + pad * 2, card_h + pad * 2), (255, 255, 255, 0))
    # 白卡片（本身是 popup 的底色，这里只是给它一圈内边距与圆角）
    ImageDraw.Draw(card).rounded_rectangle(
        [0, 0, card.size[0] - 1, card.size[1] - 1], radius=28, fill=(255, 255, 255, 255)
    )
    card.alpha_composite(popup, (pad, pad))

    canvas = gradient(W, H).convert("RGBA")

    # 阴影：把卡片轮廓模糊后压暗
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sx = (W - card.size[0]) // 2
    sy = (H - card.size[1]) // 2
    ImageDraw.Draw(shadow).rounded_rectangle(
        [sx + 6, sy + 18, sx + card.size[0] - 6, sy + card.size[1] + 10],
        radius=30,
        fill=(20, 12, 60, 150),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(22))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(card, (sx, sy))

    out = path.replace("raw-popup-2x", "store-1280x800-popup")
    if os.path.exists(out) and not force:
        # 交付物可能被手工替换过（见 store/README.md）→ 默认绝不覆盖
        return f"{os.path.basename(out)}  已存在，跳过（要覆盖请加 --force）"
    canvas.convert("RGB").save(out, "PNG", optimize=True)
    return (
        f"{os.path.basename(out)}  原图 {raw.size[0]}x{raw.size[1]} → 裁到 {card_w}x{card_h}(2x)"
        f" → 合成 {W}x{H}（卡片 {card.size[0]}x{card.size[1]} 居中）"
    )


def main() -> None:
    force = "--force" in sys.argv
    print("合成商店截图" + ("（--force：允许覆盖已有交付物）" if force else "") + "\n")
    for path in sorted(glob.glob(os.path.join(STORE, "raw-options-*.png"))):
        print("  " + compose_options(path, force))
    for path in sorted(glob.glob(os.path.join(STORE, "raw-popup-2x-*.png"))):
        print("  " + compose_popup(path, force))

    print("\n最终素材：")
    for path in sorted(glob.glob(os.path.join(STORE, "store-1280x800-*.png"))):
        im = Image.open(path)
        size_ok = im.size == (W, H)
        note = "" if size_ok else "（手工素材，未必是 1280x800 —— 见 store/README.md，不要自动覆盖）"
        print(f"  {os.path.basename(path):44s} {im.size[0]}x{im.size[1]}  {note}")


if __name__ == "__main__":
    main()
