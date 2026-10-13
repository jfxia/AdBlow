"""生成 AdBlow 的图标（16/32/48/128 + 商店列表图 300）。

## 设计取向：**刻意避开所有同类产品的视觉符号**

同类扩展的图标是高度固化的：AdBlock（红色八角形 + 白手掌）、
AdGuard / uBlock Origin（盾牌）、AdBlock Plus（红灰八角）。用户对这几个形状
已经形成条件反射。所以 AdBlow 一个都不用：

    - 不用盾牌、不用八角形、不用停车标志
    - 不用它们的红/绿主色
    - 不用字母（小尺寸下字母会糊成一团）

采用：**紫罗兰圆角方块**（渐变 #7C5CFF → #3B2FD1）+ 白色**吹散气流**
（三条圆头气流，长度递减），最下一笔把一个小圆角方块**吹出画面右上角** ——
"blow away the ad" 的字面表达。16px 下仍能读出"紫色方块 + 三道白气"，
与上述任何一款都不会混淆。

## 为什么用 4 倍超采样

PIL 没有抗锯齿的圆角/描边绘制，直接画 16px 会毛边。统一在 4 倍画布上绘制
再 `LANCZOS` 缩小，边缘干净。所有尺寸都由同一份矢量式描述生成，风格一致。

用法：python tools/build/gen-icons.py
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw

SS = 4  # 超采样倍数

# 紫罗兰 → 靛蓝 渐变（与 popup/options 的 --accent 保持一致）
TOP = (124, 92, 255)
BOTTOM = (59, 47, 209)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "public", "icons")
STORE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "store")

SIZES = [16, 32, 48, 128]


def gradient_square(size: int) -> Image.Image:
    """圆角方块 + 对角渐变。"""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    grad = Image.new("RGBA", (s, s))
    px = grad.load()
    for y in range(s):
        for x in range(s):
            t = (x / max(1, s - 1) + y / max(1, s - 1)) / 2
            px[x, y] = (
                round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
                round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
                round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
                255,
            )
    # 圆角遮罩（半径 22%，接近 squircle 的手感）
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def gust_stroke(
    draw: ImageDraw.ImageDraw,
    x0: float,
    y0: float,
    length: float,
    thickness: float,
    curl: float,
    tilt: float,
    hook: float,
    color,
) -> None:
    """一条"气流"：圆头弧线，可整体倾斜、末端带钩（像起风时的涡）。

    用一串圆点画，保证圆头与平滑 —— PIL 没有抗锯齿的粗线描边。
    """
    r = max(1.0, thickness / 2)
    steps = max(12, int(length))
    for i in range(steps + 1):
        t = i / steps
        px = x0 + length * t
        py = y0 + tilt * (px - x0) - curl * math.sin(t * math.pi * 0.9)
        draw.ellipse([px - r, py - r, px + r, py + r], fill=color)

    # 末端钩子：一段向下的小弧，读作"涡流"。16px 下它把"三道横杠"的
    # 汉堡菜单感破坏掉（这是第二版返工的直接原因）。
    if hook <= 0:
        return
    ex = x0 + length
    ey = y0 + tilt * length
    hsteps = max(10, int(hook * 2))
    for i in range(hsteps + 1):
        a = math.pi * (i / hsteps) * 0.85
        px = ex + hook * 0.55 * math.sin(a)
        py = ey + hook * (1 - math.cos(a))
        draw.ellipse([px - r, py - r, px + r, py + r], fill=color)


def draw_icon(size: int) -> Image.Image:
    img = gradient_square(size)
    s = size * SS
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)

    # ── 三道气流 ──
    #
    # 设计约束来自两次 ASCII 预览返工：
    #   v1 有"被吹走的方块" → 16px 下与气流缠成一团乱块，删除
    #   v2 三条水平横杠 → 会被读成"汉堡菜单/列表"图标，改为整体倾斜 + 顶端带钩
    # 起笔对齐在左侧同一竖线（读作"一阵风"），长度差别拉开（0.62 / 0.46 / 0.28），
    # 顶端一道带钩（破坏菜单感），整体轻微上倾。
    bar = s * 0.086
    tilt = -0.055
    left = s * 0.155
    gust_stroke(d, left, s * 0.375, s * 0.45, bar, 0.10, tilt, s * 0.105, white)  # 上：带钩
    gust_stroke(d, left, s * 0.560, s * 0.62, bar, 0.02, tilt, 0.0, white)        # 中：最长
    gust_stroke(d, left, s * 0.745, s * 0.27, bar, 0.00, tilt, 0.0, white)        # 下：最短

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(STORE_DIR, exist_ok=True)

    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        draw_icon(size).save(path, "PNG", optimize=True)
        print(f"  public/icons/icon-{size}.png  {os.path.getsize(path)} B")

    store = os.path.join(STORE_DIR, "icon-300.png")
    draw_icon(300).save(store, "PNG", optimize=True)
    print(f"  store/icon-300.png  {os.path.getsize(store)} B")


if __name__ == "__main__":
    main()
