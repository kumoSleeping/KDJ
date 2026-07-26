"""原图直出 + 周边淡化。

不抠图：方形裁到小熊为中心，四周用径向渐隐压到图标底色里。
线材、打碟机都还在，但被压暗成"环境"，主体只剩发光的熊。
"""
import os, math
from PIL import Image, ImageDraw, ImageFilter
from render import S, BG, new, rounded_bg

here = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.expanduser("~/.claude/image-cache/ad8efae5-a714-4184-8102-de0dadb42dae/3.png")

im = Image.open(SRC).convert("RGB")
W, H = im.size

# 小熊中心：用"又亮又红"的质心定位，和抠图版同一招，但只拿一个点
small = im.resize((W // 8, H // 8))
px = small.load()
pts = [(x, y) for y in range(small.height) for x in range(small.width)
       if px[x, y][0] > 200 and px[x, y][0] > px[x, y][1] * 1.6]
cx = sum(p[0] for p in pts) * 8 // max(1, len(pts))
cy = sum(p[1] for p in pts) * 8 // max(1, len(pts))

def vignette_icon(size, *, zoom=1.35, fade_start=0.42, dim=0.35):
    """zoom = 裁切框相对小熊高度的倍数；fade_start = 从中心多远开始淡出。"""
    side = int(H * 0.55 * zoom)               # 小熊约占画面高度一半
    x0 = max(0, min(W - side, cx - side // 2))
    y0 = max(0, min(H - side, cy - side // 2))
    crop = im.crop((x0, y0, x0 + side, y0 + side))

    n = size * S
    crop = crop.resize((n, n), Image.LANCZOS)

    # 周边压暗 + 渐隐到底色：两层一起做。半径按对角线算，四角必然归零。
    fade = Image.new("L", (n, n), 0)
    fp = fade.load()
    half = n / 2
    maxd = math.hypot(half, half)
    for y in range(n):
        for x in range(n):
            d = math.hypot(x - half, y - half) / maxd
            if d <= fade_start:
                fp[x, y] = 255
            else:
                t = (d - fade_start) / (1 - fade_start)
                fp[x, y] = max(0, int(255 * (1 - t) ** 1.6))
    fade = fade.filter(ImageFilter.GaussianBlur(n // 40))

    img, dctx = new(size)
    rounded_bg(dctx, size)
    # 先铺一层压暗的照片当"环境"，再用渐隐掩码叠一层原亮度的
    dark = crop.point(lambda v: int(v * dim))
    base = img.copy()
    layer = Image.new("RGBA", (n, n))
    layer.paste(dark.convert("RGBA"), (0, 0))
    layer.putalpha(fade.point(lambda v: min(255, v + 70)))   # 环境层淡淡透出
    bright = crop.convert("RGBA")
    bright.putalpha(fade)

    # 全部裁进圆角里
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.225), fill=255)
    base.alpha_composite(Image.composite(layer, Image.new("RGBA", (n, n)), mask))
    base.alpha_composite(Image.composite(bright, Image.new("RGBA", (n, n)), mask))
    return base.resize((size, size), Image.LANCZOS)

VAR = {
    "V-A 标准":       dict(),
    "V-B 更近":       dict(zoom=1.12, fade_start=0.5),
    "V-C 更狠的淡化": dict(fade_start=0.30, dim=0.15),
}

sizes = [256, 128, 64, 32, 16]
pad_, gap = 28, 24
Ws = pad_ * 2 + sum(sizes) + gap * (len(sizes) - 1)
rowh = 256 + 34
sheet = Image.new("RGB", (Ws, pad_ * 2 + rowh * len(VAR)), (24, 24, 27))
dd = ImageDraw.Draw(sheet)
for row, (name, kw) in enumerate(VAR.items()):
    y = pad_ + row * rowh
    x = pad_
    for s in sizes:
        t = vignette_icon(s, **kw)
        sheet.paste(t, (x, y + (256 - s) // 2), t)
        x += s + gap
    dd.text((pad_, y + 256 + 12), name, fill=(215, 215, 222))
sheet.save(os.path.join(here, "vignette.png"))
vignette_icon(1024).save(os.path.join(here, "VIGNETTE-1024.png"))
print("ok")
