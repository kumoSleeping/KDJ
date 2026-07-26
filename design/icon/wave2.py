"""W1 精修：让三条杠真正"长在缺口里"。

上一版杠只是摆在盘子右下方，缺口和杠是两件事；这版让缺口的两条直边
当成杠的参考线——最高那条杠的顶端顶到盘心的水平线上，最左那条杠的左边
贴着缺口的竖边，缺口就从"少了一块"变成"为杠让出来的位置"。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def make(size, *, hole=0.068, bw=0.105, bgap=0.038, br=0.030,
         cx=0.395, cy=0.365, rad=0.250, base=0.795, tall=0.315,
         bar=INK, dcolor=THEME):
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    ccx, ccy, r = n * cx, n * cy, n * rad
    d.pieslice([ccx - r, ccy - r, ccx + r, ccy + r], 90, 360, fill=dcolor)
    h = n * hole
    d.ellipse([ccx - h, ccy - h, ccx + h, ccy + h], fill=BG)

    # 三条杠：中间最高，顶端正好落在盘心那条水平线上
    heights = [tall * 0.50, tall, tall * 0.70]
    x = ccx                      # 从缺口的竖边起步
    for hh in heights:
        d.rounded_rectangle([x, n * base - n * hh, x + n * bw, n * base],
                            radius=int(n * br), fill=bar)
        x += n * (bw + bgap)
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {
    "V1-基准":       lambda s: make(s),
    "V2-更胖":       lambda s: make(s, bw=0.125, bgap=0.032, br=0.034, tall=0.300),
    "V3-盘更大":     lambda s: make(s, rad=0.275, cx=0.372, cy=0.350, hole=0.074),
    "V4-杠更矮更宽": lambda s: make(s, bw=0.130, bgap=0.030, tall=0.245, base=0.760),
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
    sheet.save(os.path.join(here, "wave-refine.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
