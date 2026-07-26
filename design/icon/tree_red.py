"""方形圣诞树 · 红色系。

图标是品牌标记，不是界面状态，所以"红色只给动作"那条 UI 规则在这里不适用，
可以整块红。真正的约束是 16px：红在深底上的亮度差本来就不如白，
所以红不能往深里调（深红到 16px 会和 #111113 的底糊在一起），
只能往亮/暖里调——用 #ef4444 当底色，靠掺白/掺橙拉开层次。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
WARM = (249, 115, 22)   # orange-500，往暖里掺用的，比掺白更"活"
here = os.path.dirname(os.path.abspath(__file__))

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))

def solid_tree(size, colors, top_color, gap=0.030, r=0.028):
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    top = n * 0.215
    side = n * 0.175
    d.rounded_rectangle([cx - side / 2, top, cx + side / 2, top + side],
                        radius=int(n * r), fill=top_color)
    y = top + side + n * gap
    h = n * 0.088
    for w, c in zip([0.30, 0.395, 0.49], colors):
        d.rounded_rectangle([cx - n * w / 2, y, cx + n * w / 2, y + h],
                            radius=int(n * r), fill=c)
        y += h + n * gap
    return img.resize((size, size), Image.LANCZOS)

def block_tree(size, colors, top_color, gap=0.026, r=0.026):
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    top = n * 0.200
    side = n * 0.165
    d.rounded_rectangle([cx - side / 2, top, cx + side / 2, top + side],
                        radius=int(n * r), fill=top_color)
    y = top + side + n * gap
    unit = n * 0.088
    pitch = unit + n * 0.022
    for count, c in zip([2, 3, 4], colors):
        span = count * pitch - (pitch - unit)
        x = cx - span / 2
        for _ in range(count):
            d.rounded_rectangle([x, y, x + unit, y + unit], radius=int(n * r), fill=c)
            x += pitch
        y += unit + n * gap
    return img.resize((size, size), Image.LANCZOS)

FLAT = [THEME, THEME, THEME]
# 越往下越亮：树是"下宽下重"的，底层最大块给最亮的色，16px 时留下的就是它
UP   = [mix(THEME, BG, 0.30), THEME, mix(THEME, WARM, 0.35)]
# 越往下越深：反过来，顶块最亮，视线先落在顶上的"方块"
DOWN = [mix(THEME, WARM, 0.35), THEME, mix(THEME, BG, 0.22)]

VARIANTS = {
    "R1-整条·纯红":      lambda s: solid_tree(s, FLAT, THEME),
    "R2-整条·红渐亮":    lambda s: solid_tree(s, UP, mix(THEME, BG, 0.42)),
    "R3-整条·白顶红身":  lambda s: solid_tree(s, FLAT, INK),
    "R4-方块·纯红":      lambda s: block_tree(s, FLAT, THEME),
    "R5-方块·红渐亮":    lambda s: block_tree(s, UP, mix(THEME, BG, 0.42)),
    "R6-方块·白顶红身":  lambda s: block_tree(s, FLAT, INK),
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
    sheet.save(os.path.join(here, "tree-red.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
