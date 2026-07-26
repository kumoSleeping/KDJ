"""方形圣诞树：顶上一个方块，下面三层逐层变宽，整体轮廓是三角。

全部由方形构成，一个圆角都不带弧线元素——比云更"几何"，
在 16px 下轮廓也更硬，不会糊成一团棉花。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))

def solid_tree(size, colors, top_color, gap=0.030, r=0.028):
    """T1 风格：顶一个方块 + 三条整条的横板。"""
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
    """T2 风格：每一层由离散的小方块拼成，像素感 + 波形感。"""
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    top = n * 0.200
    side = n * 0.165
    d.rounded_rectangle([cx - side / 2, top, cx + side / 2, top + side],
                        radius=int(n * r), fill=top_color)
    y = top + side + n * gap
    unit = n * 0.088          # 每个小方块的边长
    pitch = unit + n * 0.022  # 方块间距
    for count, c in zip([2, 3, 4], colors):
        span = count * pitch - (pitch - unit)
        x = cx - span / 2
        for _ in range(count):
            d.rounded_rectangle([x, y, x + unit, y + unit], radius=int(n * r), fill=c)
            x += pitch
        y += unit + n * gap
    return img.resize((size, size), Image.LANCZOS)

GREY = [mix(BG, INK, 0.55), mix(BG, INK, 0.78), INK]
GREY_UP = [INK, mix(BG, INK, 0.78), mix(BG, INK, 0.55)]

VARIANTS = {
    "T1-整条·越下越亮": lambda s: solid_tree(s, GREY, INK),
    "T2-整条·底层红":   lambda s: solid_tree(s, [GREY[0], GREY[1], THEME], INK),
    "T3-方块·越下越亮": lambda s: block_tree(s, GREY, INK),
    "T4-方块·顶红":     lambda s: block_tree(s, GREY, THEME),
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
    sheet.save(os.path.join(here, "tree-variants.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
