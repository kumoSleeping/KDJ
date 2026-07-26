"""白色整圆 CD + 底下三条红色竖杠波形。

圆补完整之后就没有"缺口引导视线"这回事了，上下两块得靠间距分家：
圆和杠之间的留白要明显大于杠与杠之间的，否则读起来是一坨。
沿用 wave3 的包围盒居中法——先在透明层画，量墨迹，再整块居中贴回去。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def _mark(n, *, rad, hole, bw, bgap, br, tall, split, bar, dcolor):
    layer = Image.new("RGBA", (int(n * 2.4), int(n * 2.4)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ccx = ccy = n
    r = n * rad
    d.ellipse([ccx - r, ccy - r, ccx + r, ccy + r], fill=dcolor)
    h = n * hole
    d.ellipse([ccx - h, ccy - h, ccx + h, ccy + h], fill=(0, 0, 0, 0))

    # 杠底对齐（波形从基线往上长），整组水平居中在圆心正下方
    heights = [tall * 0.52, tall, tall * 0.72]
    span = len(heights) * bw + (len(heights) - 1) * bgap
    top = ccy + r + n * split          # 圆的下沿再往下留一段
    base = top + n * tall
    x = ccx - n * span / 2
    for hh in heights:
        d.rounded_rectangle([x, base - n * hh, x + n * bw, base],
                            radius=int(n * br), fill=bar)
        x += n * (bw + bgap)
    return layer, layer.getbbox()

def make(size, *, rad=0.250, hole=0.072, bw=0.118, bgap=0.046, br=0.032,
         tall=0.235, split=0.085, scale=0.70, bar=THEME, dcolor=INK):
    img, d = new(size)
    n = size * S
    rounded_bg(d, size)
    layer, box = _mark(n, rad=rad, hole=hole, bw=bw, bgap=bgap, br=br,
                       tall=tall, split=split, bar=bar, dcolor=dcolor)
    mark = layer.crop(box)
    k = (n * scale) / max(mark.width, mark.height)
    mark = mark.resize((max(1, int(mark.width * k)), max(1, int(mark.height * k))), Image.LANCZOS)
    img.alpha_composite(mark, (int((n - mark.width) / 2), int((n - mark.height) / 2)))
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {
    "D1-基准":       lambda s: make(s),
    "D2-杠更胖":     lambda s: make(s, bw=0.140, bgap=0.038, br=0.036, tall=0.225),
    "D3-大孔·杠更高": lambda s: make(s, hole=0.098, tall=0.285, bw=0.112),
    "D4-圆更大·杠矮": lambda s: make(s, rad=0.285, hole=0.082, tall=0.185, bw=0.130, split=0.075),
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
        dd.line([(pad + 128, y), (pad + 128, y + 256)], fill=(80, 80, 88))
    sheet.save(os.path.join(here, "wave-disc.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")

# ---- 第二轮：围绕 D3 收 ----
# 小孔那几版在 64px 以下读起来像眼睛不像唱片，孔必须够大。
FINE = {
    "E1-D3":        lambda s: make(s, hole=0.098, tall=0.285, bw=0.112),
    "E2-孔再大":     lambda s: make(s, hole=0.112, tall=0.285, bw=0.112),
    "E3-孔大·杠更胖": lambda s: make(s, hole=0.112, tall=0.275, bw=0.132, bgap=0.040),
    "E4-孔大·圆更大": lambda s: make(s, hole=0.118, rad=0.275, tall=0.265, bw=0.128, bgap=0.042, split=0.078),
}

def sheet(variants, name):
    sizes = [256, 128, 64, 32, 16]
    pad, gap = 28, 24
    W = pad * 2 + sum(sizes) + gap * (len(sizes) - 1)
    rowh = max(sizes) + 34
    im = Image.new("RGB", (W, pad * 2 + rowh * len(variants)), (24, 24, 27))
    dd = ImageDraw.Draw(im)
    for row, (label, fn) in enumerate(variants.items()):
        y = pad + row * rowh
        dd.text((pad, y + max(sizes) + 12), label, fill=(210, 210, 216))
        x = pad
        for s in sizes:
            t = fn(s)
            im.paste(t, (x, y + (max(sizes) - s) // 2), t)
            x += s + gap
        dd.line([(pad + 128, y), (pad + 128, y + 256)], fill=(80, 80, 88))
    im.save(os.path.join(here, name))
