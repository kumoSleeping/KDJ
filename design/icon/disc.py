"""最简：一张唱片，中心是正方形。

只有两个形，所以唯一要调的就是方孔占圆的比例。太小读成一个点，
太大圆就变成一圈细环、16px 直接断掉。方孔不倒角——圆和方的对比就是
这个图标全部的内容，倒了角对比就软了。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def make(size, *, rad=0.300, sq=0.30, color=INK, rot=0):
    """sq = 方孔边长 / 圆直径。"""
    img, d = new(size)
    n = size * S
    rounded_bg(d, size)
    c = n / 2
    r = n * rad
    d.ellipse([c - r, c - r, c + r, c + r], fill=color)
    half = r * sq
    if rot:
        # 转 45° 就成了菱形孔，另一种读法
        layer = Image.new("RGBA", (int(n), int(n)), (0, 0, 0, 0))
        ImageDraw.Draw(layer).rectangle([c - half, c - half, c + half, c + half], fill=BG + (255,))
        layer = layer.rotate(rot, resample=Image.BICUBIC, center=(c, c))
        img.alpha_composite(layer)
    else:
        d.rectangle([c - half, c - half, c + half, c + half], fill=BG)
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {
    "S1-白盘·方孔0.30": lambda s: make(s),
    "S2-白盘·方孔0.40": lambda s: make(s, sq=0.40),
    "S3-红盘·方孔0.30": lambda s: make(s, color=THEME),
    "S4-红盘·方孔0.40": lambda s: make(s, color=THEME, sq=0.40),
    "S5-白盘·菱形孔":    lambda s: make(s, sq=0.36, rot=45),
    "S6-白盘·小方孔":    lambda s: make(s, sq=0.22),
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
    sheet.save(os.path.join(here, "disc-square.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
