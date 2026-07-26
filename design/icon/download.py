"""方向修正：突出**下载**和**管理**，不再画和声轮。

名字本身就给了两个词：Kumo（云）= 从云端拿下来 = 下载；
Deck = 一叠 = 本地成叠管理。图标就画这两件事。
"""
import math
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (240, 240, 244)
# 三色和波形一致（低频红 / 中频绿 / 高频蓝），图标和应用里能看到的东西同一套语义
BAND = [(239, 68, 68), (110, 210, 130), (120, 170, 245)]

def cloud(d, n, cx, cy, u, fill=INK):
    """压扁的云。三个等大圆太萌，拉宽压低才像符号。"""
    for dx, dy, k in ((-0.60, 0.10, 0.62), (-0.05, -0.22, 0.86), (0.58, 0.06, 0.66)):
        r = u * k
        d.ellipse([cx + dx * u - r, cy + dy * u - r, cx + dx * u + r, cy + dy * u + r], fill=fill)
    d.rounded_rectangle([cx - u * 1.16, cy - u * 0.10, cx + u * 1.16, cy + u * 0.62],
                        radius=int(u * 0.34), fill=fill)

def e_rain(size):
    """E · 云 + 落下的竖条：既是下载流，也是波形。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx = n / 2
    cloud(d, n, cx, n * 0.375, n * 0.175)
    bw = n * 0.062
    for i, (off, h, color) in enumerate([(-1.55, 0.10, BAND[0]), (-0.52, 0.175, BAND[1]),
                                          (0.52, 0.145, BAND[2]), (1.55, 0.085, BAND[0])]):
        x = cx + off * bw * 1.7
        top = n * 0.575
        d.rounded_rectangle([x - bw / 2, top, x + bw / 2, top + n * h],
                            radius=int(bw / 2), fill=color)
    return img.resize((size, size), Image.LANCZOS)

def f_deck(size):
    """F · 云 + 一叠：Deck 就是"一叠"。下载下来的东西堆成本地库。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx = n / 2
    cloud(d, n, cx, n * 0.345, n * 0.165)
    # 三层板，从上往下逐层变宽 —— 透视感，也暗示"越堆越多"
    for i, (w, y, color) in enumerate([(0.30, 0.585, BAND[2]), (0.36, 0.685, BAND[1]),
                                        (0.42, 0.785, BAND[0])]):
        d.rounded_rectangle([cx - n * w / 2, n * y, cx + n * w / 2, n * (y + 0.072)],
                            radius=int(n * 0.030), fill=color)
    return img.resize((size, size), Image.LANCZOS)

def g_arrow(size):
    """G · 云里挖出下箭头：最直白的"下载"，靠云的轮廓保住身份。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx, cy = n / 2, n * 0.44
    cloud(d, n, cx, cy, n * 0.205)
    # 箭头用底色挖出来，负形比叠色干净
    sw = n * 0.075
    d.rounded_rectangle([cx - sw / 2, cy - n * 0.055, cx + sw / 2, cy + n * 0.20],
                        radius=int(sw / 2), fill=BG)
    d.polygon([(cx - n * 0.135, cy + n * 0.135), (cx + n * 0.135, cy + n * 0.135),
               (cx, cy + n * 0.315)], fill=BG)
    # 再把箭头本体画回来，比云低一号亮度，避免和云糊成一片
    d.rounded_rectangle([cx - sw * 0.34, cy - n * 0.030, cx + sw * 0.34, cy + n * 0.155],
                        radius=int(sw * 0.34), fill=THEME)
    d.polygon([(cx - n * 0.098, cy + n * 0.105), (cx + n * 0.098, cy + n * 0.105),
               (cx, cy + n * 0.258)], fill=THEME)
    return img.resize((size, size), Image.LANCZOS)

def h_fused(size):
    """H · 一叠里最上面那块是云：把两个含义压进一个形，最"标志"。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx = n / 2
    cloud(d, n, cx, n * 0.395, n * 0.190)
    for w, y, color in [(0.40, 0.615, BAND[1]), (0.46, 0.725, BAND[0])]:
        d.rounded_rectangle([cx - n * w / 2, n * y, cx + n * w / 2, n * (y + 0.082)],
                            radius=int(n * 0.034), fill=color)
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {"E-云+落下": e_rain, "F-云+一叠": f_deck,
            "G-云挖箭头": g_arrow, "H-云即顶层": h_fused}

if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    sizes = [256, 64, 32, 16]
    pad, gap = 28, 26
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
    sheet.save(os.path.join(here, "download-concepts.png"))
    for name, fn in VARIANTS.items():
        fn(512).save(os.path.join(here, f"{name.split('-')[0]}-512.png"))
    print("ok")
