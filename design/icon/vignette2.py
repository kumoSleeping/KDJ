"""周边淡化 v2：单层亮度衰减，边缘真正沉进底色。"""
import os, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from render import S, BG, new, rounded_bg

here = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.expanduser("~/.claude/image-cache/ad8efae5-a714-4184-8102-de0dadb42dae/3.png")

im = Image.open(SRC).convert("RGB")
W, H = im.size
small = im.resize((W // 8, H // 8))
px = small.load()
pts = [(x, y) for y in range(small.height) for x in range(small.width)
       if px[x, y][0] > 200 and px[x, y][0] > px[x, y][1] * 1.6]
cx = sum(p[0] for p in pts) * 8 // max(1, len(pts))
cy = sum(p[1] for p in pts) * 8 // max(1, len(pts))

def make(size, *, zoom=1.18, up=0.10, fade_start=0.34, power=2.2):
    side = int(H * 0.55 * zoom)
    x0 = max(0, min(W - side, cx - side // 2))
    y0 = max(0, min(H - side, cy - side // 2 - int(side * up)))
    n = size * S
    crop = im.crop((x0, y0, x0 + side, y0 + side)).resize((n, n), Image.LANCZOS)

    arr = np.asarray(crop).astype(np.float32)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    half = n / 2
    d = np.sqrt((xx - half) ** 2 + (yy - half) ** 2) / math.hypot(half, half)
    gain = np.ones_like(d)
    t = np.clip((d - fade_start) / (1 - fade_start), 0, 1)
    gain = np.where(d > fade_start, (1 - t) ** power, gain)
    # 衰减目标不是纯黑而是底色，最后一段直接混进 BG
    bg = np.array(BG, dtype=np.float32)
    out = arr * gain[..., None] + bg * (1 - gain[..., None])
    faded = Image.fromarray(out.astype(np.uint8))

    img, dctx = new(size)
    rounded_bg(dctx, size)
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.225), fill=255)
    img.paste(faded, (0, 0), mask)
    return img.resize((size, size), Image.LANCZOS)

VAR = {
    "W-A 标准":  dict(),
    "W-B 更近":  dict(zoom=1.02, fade_start=0.40, up=0.12),
    "W-C 只留熊": dict(zoom=1.10, fade_start=0.26, power=2.8, up=0.11),
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
        t = make(s, **kw)
        sheet.paste(t, (x, y + (256 - s) // 2), t)
        x += s + gap
    dd.text((pad_, y + 256 + 12), name, fill=(215, 215, 222))
sheet.save(os.path.join(here, "vignette2.png"))
make(1024, zoom=1.02, fade_start=0.40, up=0.12).save(os.path.join(here, "VIGNETTE-1024.png"))
print("ok")
