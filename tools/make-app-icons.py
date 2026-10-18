"""生成 Android 启动图标 —— 顶栏那个 ✳ 的几何还原版。

顶栏用的是字符 U+2733（八芒星），但字符当图标不行：各系统字体形状不同，
也没法做自适应图标。所以这里按几何画：八根等宽辐条、间隔 45°、一根指正上方。

笔画宽度 5.8% 是实测挑出来的：系统字体里真字形只有 4%（顶栏 17px 好看，
48dp 图标几乎看不见），再粗就糊成「十字饼」。

输出（覆盖 android/app/src/main/res 下同名文件）：
  mipmap-*/ic_launcher.png           48–192px，纸色底 + 墨色八芒星
  mipmap-*/ic_launcher_round.png     同上，裁成圆形
  mipmap-*/ic_launcher_foreground.png 自适应图标前景层，透明底，图形缩到 60%
  mipmap-*/ic_launcher_monochrome.png 主题图标（Android 13+ 单色图标），纯黑剪影

用法：python tools/make-app-icons.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
RES = REPO / "apps" / "shell" / "android" / "app" / "src" / "main" / "res"

INK = (17, 17, 17, 255)
PAPER = (247, 247, 243, 255)  # 应用里的暖白底 --bg
SS = 4  # 超采样倍数，缩回目标尺寸时抗锯齿

BAR = 0.058   # 辐条宽度 / 画布
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def mark(size: int, reach: float, color=INK) -> Image.Image:
    """画八芒星，返回透明底 RGBA。reach = 辐条长度 / 画布（半径）。"""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = s / 2
    half = BAR * s / 2
    r = reach * s
    for k in range(4):  # 四根条，每根两端各成一芒
        a = math.radians(k * 45)
        dx, dy = math.cos(a), math.sin(a)
        px, py = -dy, dx
        d.polygon([(c + dx * r + px * half, c + dy * r + py * half),
                   (c + dx * r - px * half, c + dy * r - py * half),
                   (c - dx * r - px * half, c - dy * r - py * half),
                   (c - dx * r + px * half, c - dy * r + py * half)], fill=color)
    return img.resize((size, size), Image.LANCZOS)


def square_icon(size: int, reach: float) -> Image.Image:
    out = Image.new("RGBA", (size, size), PAPER)
    out.alpha_composite(mark(size, reach))
    return out


def round_icon(size: int, reach: float) -> Image.Image:
    """圆形版：先画在方形上，再用圆形蒙版裁掉四角。"""
    out = square_icon(size * SS, reach)
    mask = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * SS - 1, size * SS - 1], fill=255)
    out.putalpha(mask)
    return out.resize((size, size), Image.LANCZOS)


def lobes(alpha: Image.Image, r_ratio: float) -> int:
    s = alpha.width
    c = s / 2
    hits = []
    for deg in range(0, 360, 2):
        t = math.radians(deg)
        x = min(max(int(round(c + math.cos(t) * r_ratio * s)), 0), s - 1)
        y = min(max(int(round(c + math.sin(t) * r_ratio * s)), 0), s - 1)
        hits.append(alpha.getpixel((x, y)) > 128)
    return sum(1 for i in range(len(hits)) if hits[i] and not hits[i - 1])


def main() -> None:
    written = []
    for density, scale in DENSITIES.items():
        d = RES / f"mipmap-{density}"
        if not d.is_dir():
            raise SystemExit(f"缺少目录：{d}")

        # 旧版方形图标：图形占 74%，留一点边
        square_icon(int(48 * scale), 0.370).save(d / "ic_launcher.png")
        # 圆形图标：圆比方形收得快，图形缩到 66% 才不显挤
        round_icon(int(48 * scale), 0.330).save(d / "ic_launcher_round.png")
        # 自适应前景层：108dp 画布只露中间 72dp，图形控制在内切 60%
        fg = int(108 * scale)
        mark(fg, 0.300).save(d / "ic_launcher_foreground.png")
        mark(fg, 0.300, color=(0, 0, 0, 255)).save(d / "ic_launcher_monochrome.png")
        written.append((density, int(48 * scale), fg))

    print("密度        图标    前景层")
    for density, icon, fg in written:
        print(f"  {density:9s} {icon:4d}px {fg:5d}px")

    # 核对：形状是八芒星，且没画出安全区
    probe = square_icon(512, 0.370).convert("L").point(lambda v: 255 if v < 128 else 0)
    alpha = probe.convert("L")
    box = alpha.getbbox()
    print(f"\n核对 512px：芒数(0.20)={lobes(alpha, 0.20)} 芒数(0.30)={lobes(alpha, 0.30)} "
          f"图形占宽={(box[2]-box[0])/512*100:.1f}%")
    fg_probe = mark(432, 0.300).getchannel("A")
    fb = fg_probe.getbbox()
    print(f"核对前景层 432px：图形占宽={(fb[2]-fb[0])/432*100:.1f}%（安全区上限 66%）")


if __name__ == "__main__":
    main()
