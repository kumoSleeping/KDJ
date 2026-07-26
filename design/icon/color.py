"""F4 定稿的配色候选。

「红色只给动作」是 UI **内部**的规矩；图标是品牌层面的东西，
用主色和应用呼应是合理的——Dock 里那一点红正是让人一眼认出它的东西。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))

def cloud(d, n, cx, cy, u, fill):
    for dx, dy, k in ((-0.60, 0.10, 0.62), (-0.05, -0.22, 0.86), (0.58, 0.06, 0.66)):
        r = u * k
        d.ellipse([cx + dx * u - r, cy + dy * u - r, cx + dx * u + r, cy + dy * u + r], fill=fill)
    d.rounded_rectangle([cx - u * 1.16, cy - u * 0.10, cx + u * 1.16, cy + u * 0.62],
                        radius=int(u * 0.34), fill=fill)

def build(size, colors, cloud_fill):
    """colors 是三层板从上到下的颜色。"""
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    for (w, dy), c in zip([(0.32, 0.0), (0.40, 0.105), (0.48, 0.210)], colors):
        y = n * 0.520 + n * dy
        d.rounded_rectangle([cx - n * w / 2, y, cx + n * w / 2, y + n * 0.070],
                            radius=int(n * 0.030), fill=c)
    cloud(d, n, cx, n * 0.360, n * 0.205, fill=BG)
    cloud(d, n, cx, n * 0.350, n * 0.180, fill=cloud_fill)
    return img.resize((size, size), Image.LANCZOS)

def c1(size):
    """C1 · 全灰白：最克制，和应用的暗色气质一致。"""
    return build(size, [mix(BG, INK, 0.55), mix(BG, INK, 0.80), INK], INK)

def c2(size):
    """C2 · 底层品牌红：最重最宽的那层给主色，Dock 里一眼认出。"""
    return build(size, [mix(BG, INK, 0.55), mix(BG, INK, 0.80), THEME], INK)

def c3(size):
    """C3 · 红云：把主色给云本身。云是"从哪来"，也是名字本身。"""
    return build(size, [mix(BG, INK, 0.50), mix(BG, INK, 0.75), INK], THEME)

VARIANTS = {"C1-全灰白": c1, "C2-底层红": c2, "C3-红云": c3}

if __name__ == "__main__":
    sizes = [256, 128, 64, 32, 16]
    pad, gap = 28, 24
    W = pad * 2 + sum(sizes) + gap * (len(sizes) - 1)
    rowh = max(sizes) + 34
    sheet = Image.new("RGB", (W, pad * 2 + rowh * len(VARIANTS)), (24, 24, 27))
    dd = ImageDraw.Draw(sheet)
    for row, (name, fn) in enumerate(VARIANTS.items()):
        y = pad + row * rowh
        dd.text((pad, y + max(sizes) + 12), name, fill=(210, 210, 216))
        x = pad
        for s in sizes:
            im = fn(s)
            sheet.paste(im, (x, y + (max(sizes) - s) // 2), im)
            x += s + gap
    sheet.save(os.path.join(here, "color-variants.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
