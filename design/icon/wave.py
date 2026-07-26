"""左上 3/4 张 CD + 右下三条竖杠波形。

Q 版靠"胖"：笔画粗、留白少、缺口大到一眼能认出是被咬掉的一角；
方正靠"圆角克制"：竖杠是圆角矩形不是胶囊，CD 的缺口切成直角不做倒角，
所以整体是"厚实的几何"而不是"糖果"。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
WARM = (249, 115, 22)
here = os.path.dirname(os.path.abspath(__file__))

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))

def disc(d, cx, cy, r, color, hole, start, end, ring=None):
    """画一块饼。ring 不为空时挖成唱片环（外圈色 + 内圈更深）。"""
    box = [cx - r, cy - r, cx + r, cy + r]
    d.pieslice(box, start, end, fill=color)
    if ring:
        rr = r * ring
        d.pieslice([cx - rr, cy - rr, cx + rr, cy + rr], start, end, fill=mix(color, BG, 0.55))
    # 中心孔：直接掏到背景色，CD 的辨识度几乎全靠这个孔
    d.ellipse([cx - hole, cy - hole, cx + hole, cy + hole], fill=BG)

def bars(d, n, cx, base, heights, color, w=0.105, gap=0.038, r=0.028):
    """竖杠波形。底对齐——波形图就是从基线往上长的。"""
    total = len(heights) * w + (len(heights) - 1) * gap
    x = cx - n * total / 2
    for h, c in zip(heights, color):
        d.rounded_rectangle([x, base - n * h, x + n * w, base], radius=int(n * r), fill=c)
        x += n * (w + gap)

def make(size, *, quarter=False, ring=False, disc_color=THEME, bar_colors=None, hole=0.055):
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    cx, cy, r = n * 0.375, n * 0.375, n * 0.235
    # 3/4：咬掉右下那一格，正好把视线引到右下的波形上
    start, end = (270, 360) if quarter else (90, 360)
    disc(d, cx, cy, r, disc_color, n * hole, start, end, ring=0.62 if ring else None)
    cols = bar_colors or [INK, INK, INK]
    bars(d, n, n * 0.615, n * 0.775, [0.155, 0.30, 0.215], cols)
    return img.resize((size, size), Image.LANCZOS)

RED3 = [mix(THEME, BG, 0.30), THEME, mix(THEME, WARM, 0.30)]

VARIANTS = {
    "W1-红盘白杠":     lambda s: make(s),
    "W2-红盘红杠":     lambda s: make(s, bar_colors=RED3),
    "W3-白盘红杠":     lambda s: make(s, disc_color=INK, bar_colors=[THEME, THEME, THEME]),
    "W4-唱片环":       lambda s: make(s, ring=True, bar_colors=RED3),
    "W5-1/4盘":        lambda s: make(s, quarter=True, bar_colors=RED3),
    "W6-红盘白杠·大孔": lambda s: make(s, hole=0.082),
}

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
    sheet.save(os.path.join(here, "wave-variants.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
