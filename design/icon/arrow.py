"""在 7 号（箭头 + 托盘）基础上的十个变体。

七号定下的骨架不动：一个向下的箭头压着一条底线，红只给箭头。
这十个动的是三件事——箭头的胖瘦和头的形状、底线变成什么、
以及有没有第三个元素（盘 / 波形）参与进来。
每个都在 16px 下确认过还剩一个能认的箭头。
"""
import math, os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (240, 240, 245)
here = os.path.dirname(os.path.abspath(__file__))

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))

def arrow(d, n, *, cx=0.5, top=0.235, h=0.375, shaft=0.105, head=0.290,
          head_ratio=0.46, fill=THEME, shaft_fill=None, r=0.0):
    """向下箭头。shaft_fill 不为空时杆和头分色。"""
    cx = n * cx
    top = n * top
    h = n * h
    hh = h * head_ratio
    sw = n * shaft
    d.rounded_rectangle([cx - sw / 2, top, cx + sw / 2, top + h - hh],
                        radius=int(n * r), fill=shaft_fill or fill)
    d.polygon([(cx - n * head / 2, top + h - hh), (cx + n * head / 2, top + h - hh),
               (cx, top + h)], fill=fill)

def tray_line(d, n, *, y=0.690, w=0.490, t=0.070, fill=INK, r=0.030):
    d.rounded_rectangle([n * (0.5 - w / 2), n * y, n * (0.5 + w / 2), n * (y + t)],
                        radius=int(n * r), fill=fill)

def tray_u(d, n, *, y=0.560, w=0.500, t=0.066, depth=0.150, fill=INK, r=0.034):
    """U 形托盘：两条竖边 + 一条底。比一条线更明确是"落进某个东西里"。"""
    x0, x1 = n * (0.5 - w / 2), n * (0.5 + w / 2)
    yb = n * (y + depth)
    d.rounded_rectangle([x0, yb, x1, yb + n * t], radius=int(n * r), fill=fill)
    for x in (x0, x1 - n * t):
        d.rounded_rectangle([x, n * y, x + n * t, yb + n * t], radius=int(n * r), fill=fill)

# ---------------------------------------------------------------- 十个
def a1(size):
    """加粗：杆更宽、头更钝，整体往下压。最接近你选的那版，只是更实。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    arrow(d, n, top=0.220, h=0.395, shaft=0.135, head=0.320, head_ratio=0.42, r=0.018)
    tray_line(d, n, y=0.700, w=0.510, t=0.078)
    return img.resize((size, size), Image.LANCZOS)

def a2(size):
    """U 形托盘：从"落到线上"变成"落进盒里"，更像"入库"。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    arrow(d, n, top=0.185, h=0.360, shaft=0.108, head=0.270, r=0.016)
    tray_u(d, n)
    return img.resize((size, size), Image.LANCZOS)

def a3(size):
    """杆改成三段波形：下载的是音乐，不是文件。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    seg = n * 0.062
    gap = n * 0.030
    y = n * 0.215
    for k in (0.62, 0.82, 1.0):
        w = n * 0.115 * k
        d.rounded_rectangle([c - w / 2, y, c + w / 2, y + seg], radius=int(n * 0.014), fill=THEME)
        y += seg + gap
    d.polygon([(c - n * 0.145, y), (c + n * 0.145, y), (c, y + n * 0.150)], fill=THEME)
    tray_line(d, n, y=0.720, w=0.470, t=0.070)
    return img.resize((size, size), Image.LANCZOS)

def a4(size):
    """细杆大头：头占七成，远看就是一个三角，16px 最稳。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    arrow(d, n, top=0.215, h=0.410, shaft=0.072, head=0.330, head_ratio=0.62, r=0.014)
    tray_line(d, n, y=0.715, w=0.470, t=0.066)
    return img.resize((size, size), Image.LANCZOS)

def a5(size):
    """无杆，只有一个 V。最省笔画的一版。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    w = int(n * 0.088)
    top, bot = n * 0.275, n * 0.585
    d.line([(c - n * 0.185, top), (c, bot)], fill=THEME, width=w)
    d.line([(c + n * 0.185, top), (c, bot)], fill=THEME, width=w)
    d.ellipse([c - w/2, bot - w/2, c + w/2, bot + w/2], fill=THEME)   # 补尖角
    tray_line(d, n, y=0.690, w=0.470, t=0.070)
    return img.resize((size, size), Image.LANCZOS)

def a6(size):
    """箭头头换成唱片：落下来的是一张盘。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    d.rounded_rectangle([c - n * 0.048, n * 0.185, c + n * 0.048, n * 0.395],
                        radius=int(n * 0.016), fill=THEME)
    R = n * 0.185
    d.ellipse([c - R, n * 0.375, c + R, n * 0.375 + 2 * R], fill=THEME)
    d.ellipse([c - n * 0.048, n * 0.375 + R - n * 0.048,
               c + n * 0.048, n * 0.375 + R + n * 0.048], fill=BG)
    tray_line(d, n, y=0.775, w=0.470, t=0.062)
    return img.resize((size, size), Image.LANCZOS)

def a7(size):
    """箭头穿过唱片：盘是白的，箭头是红的，穿透处不留缝。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    R = n * 0.245
    d.ellipse([c - R, n * 0.245, c + R, n * 0.245 + 2 * R], fill=INK)
    arrow(d, n, top=0.185, h=0.480, shaft=0.098, head=0.250, head_ratio=0.38, r=0.014)
    return img.resize((size, size), Image.LANCZOS)

def a8(size):
    """反色：白箭头红底线。红从"动作"挪到"落点"。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    arrow(d, n, top=0.220, h=0.395, shaft=0.125, head=0.310, head_ratio=0.44,
          fill=INK, r=0.018)
    tray_line(d, n, y=0.700, w=0.510, t=0.078, fill=THEME)
    return img.resize((size, size), Image.LANCZOS)

def a9(size):
    """底线弯成一个浅碗，箭头落进碗里。比直线柔和一点。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    arrow(d, n, top=0.205, h=0.375, shaft=0.118, head=0.300, r=0.016)
    R = n * 0.260
    d.arc([c - R, n * 0.505, c + R, n * 0.505 + 2 * R], 15, 165,
          fill=INK, width=int(n * 0.070))
    return img.resize((size, size), Image.LANCZOS)

def a10(size):
    """双色箭头：杆白、头红。一个形里同时有中性和强调。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    arrow(d, n, top=0.215, h=0.400, shaft=0.128, head=0.315, head_ratio=0.44,
          fill=THEME, shaft_fill=mix(INK, BG, 0.10), r=0.018)
    tray_line(d, n, y=0.705, w=0.500, t=0.074, fill=mix(INK, BG, 0.45))
    return img.resize((size, size), Image.LANCZOS)

TEN = {
    "1 加粗":       a1,
    "2 U形托盘":    a2,
    "3 波形杆":     a3,
    "4 细杆大头":   a4,
    "5 只有V":      a5,
    "6 落盘":       a6,
    "7 穿盘":       a7,
    "8 反色":       a8,
    "9 碗底":       a9,
    "10 双色箭头":  a10,
}

if __name__ == "__main__":
    big, small = 200, [64, 32, 16]
    colw = big + 24 + sum(small) + 16 * len(small)
    pad, cols, rows = 26, 2, 5
    W = pad * 2 + colw * cols + 40
    rowh = big + 40
    sheet = Image.new("RGB", (W, pad * 2 + rowh * rows), (24, 24, 27))
    dd = ImageDraw.Draw(sheet)
    for i, (name, fn) in enumerate(TEN.items()):
        col, row = i % cols, i // cols
        ox, oy = pad + col * (colw + 40), pad + row * rowh
        b = fn(big)
        sheet.paste(b, (ox, oy), b)
        dd.text((ox, oy + big + 12), name, fill=(215, 215, 222))
        x = ox + big + 24
        for s in small:
            t = fn(s)
            sheet.paste(t, (x, oy + (big - s) // 2), t)
            x += s + 16
    sheet.save(os.path.join(here, "arrow-ten.png"))
    for name, fn in TEN.items():
        fn(1024).save(os.path.join(here, f"A{name.split()[0]}-1024.png"))
    print("ok")
