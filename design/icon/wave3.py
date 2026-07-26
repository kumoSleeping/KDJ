"""居中修正版。

前几版是"算好坐标直接画"，盘和杠各自的重心谁也没对齐画布中心，
放大看还行，缩到 32px 整个标记就偏左上。这版改成：先在透明层上画，
再量出实际墨迹的包围盒，按包围盒把整块居中贴回去——不管里面怎么排，
出来的图一定是正的。

两种"居中"的读法各出一版：
  A = 整个标记（盘 + 杠）居中，盘还在标记的左上角；
  B = 圆本身坐在画布正中，杠嵌进它右下的缺口里。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def _mark(n, *, rad, hole, bw, bgap, br, tall, bar, dcolor, drop):
    """在透明层上画标记，返回 (层, 墨迹包围盒)。坐标随便取，反正后面要居中。"""
    layer = Image.new("RGBA", (int(n * 2), int(n * 2)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ccx = ccy = n
    r = n * rad
    d.pieslice([ccx - r, ccy - r, ccx + r, ccy + r], 90, 360, fill=dcolor)
    h = n * hole
    d.ellipse([ccx - h, ccy - h, ccx + h, ccy + h], fill=(0, 0, 0, 0))

    # 杠底线：drop 是相对盘心往下多少，缺口的下沿正好是 ccy + r
    base = ccy + n * drop
    x = ccx
    for hh in [tall * 0.50, tall, tall * 0.70]:
        d.rounded_rectangle([x, base - n * hh, x + n * bw, base],
                            radius=int(n * br), fill=bar)
        x += n * (bw + bgap)
    return layer, layer.getbbox()

def make(size, *, mode="A", rad=0.250, hole=0.068, bw=0.125, bgap=0.032,
         br=0.034, tall=0.300, drop=0.430, bar=INK, dcolor=THEME, scale=0.66):
    img, d = new(size)
    n = size * S
    rounded_bg(d, size)

    layer, box = _mark(n, rad=rad, hole=hole, bw=bw, bgap=bgap, br=br,
                       tall=tall, bar=bar, dcolor=dcolor, drop=drop)
    mark = layer.crop(box)

    # 统一按"标记占画布的比例"缩放，换布局时视觉重量不会跳
    target = n * scale
    k = target / max(mark.width, mark.height)
    mark = mark.resize((max(1, int(mark.width * k)), max(1, int(mark.height * k))), Image.LANCZOS)

    if mode == "A":
        # 整块居中
        pos = (int((n - mark.width) / 2), int((n - mark.height) / 2))
    else:
        # 圆居中：盘心在层里是 (n, n)，裁剪后变成 (n-box[0], n-box[1])，
        # 再乘缩放系数就是盘心在 mark 里的位置；把它对齐画布中心
        cx_in = (n - box[0]) * k
        cy_in = (n - box[1]) * k
        pos = (int(n / 2 - cx_in), int(n / 2 - cy_in))

    img.alpha_composite(mark, pos)
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {
    "A1-整块居中":       lambda s: make(s, mode="A"),
    "A2-整块居中·略大":  lambda s: make(s, mode="A", scale=0.72),
    "B1-圆居中":         lambda s: make(s, mode="B", scale=0.62),
    "B2-圆居中·杠贴缺口": lambda s: make(s, mode="B", scale=0.62, drop=0.330, tall=0.250),
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
        # 中线参考：看盘/标记到底正没正
        dd.line([(pad + 256 // 2, y), (pad + 256 // 2, y + 256)], fill=(80, 80, 88))
    sheet.save(os.path.join(here, "wave-center.png"))
    for name, fn in VARIANTS.items():
        fn(1024).save(os.path.join(here, f"{name.split('-')[0]}-1024.png"))
    print("ok")
