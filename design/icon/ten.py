"""十个方案，随便挑。

统一约束（这样十个放一起才有可比性，不是十种风格的大杂烩）：
  · 同一块 squircle 底 #111113，同一个主题红 #ef4444，中性色只用一档白
  · 每个方案都要在 32px 下还认得出，认不出的不放进来
  · 每个区域最多一块红——红是重点不是底色
"""
import math, os
from PIL import Image, ImageDraw
from render import S, BG, THEME, new, rounded_bg

INK = (240, 240, 245)
here = os.path.dirname(os.path.abspath(__file__))

def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))

def circle(d, cx, cy, r, fill):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

def ring(d, cx, cy, r, w, fill):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=fill, width=int(w))

def down_arrow(d, cx, top, h, shaft_w, head_w, fill, head_ratio=0.46):
    """粗壮的下载箭头。杆和头分开画，头是等腰三角形。"""
    head_h = h * head_ratio
    d.rectangle([cx - shaft_w / 2, top, cx + shaft_w / 2, top + h - head_h], fill=fill)
    d.polygon([(cx - head_w / 2, top + h - head_h), (cx + head_w / 2, top + h - head_h),
               (cx, top + h)], fill=fill)

# ---------------------------------------------------------------- 1
def n1(size):
    """黑胶：同心纹 + 红标签。纹路只画三圈——十圈到 32px 会糊成灰饼。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    R = n * 0.335
    circle(d, c, c, R, INK)
    for k in (0.86, 0.72, 0.58):
        ring(d, c, c, R * k, n * 0.011, mix(INK, BG, 0.55))
    circle(d, c, c, R * 0.40, THEME)
    circle(d, c, c, R * 0.085, BG)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 2
def n2(size):
    """盘里掏一个下载箭头。红盘白箭头，一眼是"下载音乐"。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    circle(d, c, c, n * 0.335, THEME)
    down_arrow(d, c, n * 0.285, n * 0.335, n * 0.088, n * 0.245, INK)
    d.rectangle([c - n * 0.135, n * 0.665, c + n * 0.135, n * 0.665 + n * 0.052], fill=INK)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 3
def n3(size):
    """一叠盘（deck = 一叠）。往右下错开，色阶拉开层次，最上面那张是红的。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    R = n * 0.245
    for (dx, dy), col in [((0.085, 0.085), mix(INK, BG, 0.62)),
                          ((0.0, 0.0), mix(INK, BG, 0.28)),
                          ((-0.085, -0.085), THEME)]:
        circle(d, n / 2 + n * dx, n / 2 + n * dy, R, col)
    circle(d, n / 2 - n * 0.085, n / 2 - n * 0.085, R * 0.17, BG)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 4
def n4(size):
    """进度环：红弧走了 3/4，缺口收在右上。中心方孔呼应唱片。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    R, w = n * 0.315, n * 0.105
    d.arc([c - R, c - R, c + R, c + R], -60, 260, fill=mix(INK, BG, 0.72), width=int(w))
    d.arc([c - R, c - R, c + R, c + R], -60, 170, fill=THEME, width=int(w))
    h = n * 0.072
    d.rectangle([c - h, c - h, c + h, c + h], fill=INK)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 5
def n5(size):
    """超椭圆盘：外形跟着 macOS 的 squircle 走，中心一个圆孔。方中带圆。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    s = n * 0.325
    d.rounded_rectangle([c - s, c - s, c + s, c + s], radius=int(n * 0.155), fill=THEME)
    circle(d, c, c, n * 0.098, BG)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 6
def n6(size):
    """K：一竖两斜，斜的那两笔用红。字母标在 16px 下最稳。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    x0, top, bot = n * 0.315, n * 0.275, n * 0.725
    w = n * 0.098
    d.rounded_rectangle([x0, top, x0 + w, bot], radius=int(w * 0.30), fill=INK)
    d.polygon([(n * 0.665, top), (n * 0.775, top), (x0 + w, n * 0.50),
               (x0 + w, n * 0.50 - w * 0.95)], fill=THEME)
    d.polygon([(n * 0.665, bot), (n * 0.785, bot), (x0 + w, n * 0.50),
               (x0 + w, n * 0.50 + w * 0.95)], fill=THEME)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 7
def n7(size):
    """下载：箭头 + 托盘。最直白的一个，红只给箭头。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    down_arrow(d, c, n * 0.235, n * 0.375, n * 0.105, n * 0.290, THEME)
    d.rounded_rectangle([n * 0.255, n * 0.690, n * 0.745, n * 0.690 + n * 0.070],
                        radius=int(n * 0.030), fill=INK)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 8
def n8(size):
    """唱针落盘。针是红的直线 + 一个支点，斜 30° 从右上插进来。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    circle(d, c, c, n * 0.315, INK)
    circle(d, c, c, n * 0.072, BG)
    px, py = n * 0.775, n * 0.245
    ang = math.radians(215)
    ex, ey = px + math.cos(ang) * n * 0.415, py - math.sin(ang) * n * 0.415
    d.line([(px, py), (ex, ey)], fill=THEME, width=int(n * 0.062))
    circle(d, px, py, n * 0.062, THEME)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 9
def n9(size):
    """同心双环 + 中心方。外白细、内红粗，靠粗细而不是靠颜色分主次。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    ring(d, c, c, n * 0.335, n * 0.035, mix(INK, BG, 0.30))
    ring(d, c, c, n * 0.225, n * 0.105, THEME)
    h = n * 0.062
    d.rectangle([c - h, c - h, c + h, c + h], fill=INK)
    return img.resize((size, size), Image.LANCZOS)

# ---------------------------------------------------------------- 10
def n10(size):
    """切片盘：一刀 45° 切开再错开。上半白下半红，缝隙留住"被切过"的感觉。"""
    img, d = new(size); n = size * S; c = n / 2
    rounded_bg(d, size)
    R = n * 0.330
    off = n * 0.042
    layer = Image.new("RGBA", (int(n), int(n)), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.pieslice([c - R, c - R, c + R, c + R], 225, 45, fill=INK + (255,))
    img.alpha_composite(layer, (int(off), int(-off)))
    layer2 = Image.new("RGBA", (int(n), int(n)), (0, 0, 0, 0))
    ld2 = ImageDraw.Draw(layer2)
    ld2.pieslice([c - R, c - R, c + R, c + R], 45, 225, fill=THEME + (255,))
    img.alpha_composite(layer2, (int(-off), int(off)))
    return img.resize((size, size), Image.LANCZOS)

TEN = {
    "1 黑胶":       n1,
    "2 盘中箭头":   n2,
    "3 一叠盘":     n3,
    "4 进度环":     n4,
    "5 超椭圆盘":   n5,
    "6 K 字":       n6,
    "7 箭头托盘":   n7,
    "8 唱针":       n8,
    "9 同心双环":   n9,
    "10 切片盘":    n10,
}

if __name__ == "__main__":
    big, small = 200, [64, 32, 16]
    colw = big + 24 + sum(small) + 16 * len(small)
    pad = 26
    cols, rows = 2, 5
    W = pad * 2 + colw * cols + 40
    rowh = big + 40
    sheet = Image.new("RGB", (W, pad * 2 + rowh * rows), (24, 24, 27))
    dd = ImageDraw.Draw(sheet)
    for i, (name, fn) in enumerate(TEN.items()):
        col, row = i % cols, i // cols
        ox = pad + col * (colw + 40)
        oy = pad + row * rowh
        b = fn(big)
        sheet.paste(b, (ox, oy), b)
        dd.text((ox, oy + big + 12), name, fill=(215, 215, 222))
        x = ox + big + 24
        for s in small:
            t = fn(s)
            sheet.paste(t, (x, oy + (big - s) // 2), t)
            x += s + 16
    sheet.save(os.path.join(here, "ten.png"))
    for name, fn in TEN.items():
        fn(1024).save(os.path.join(here, f"N{name.split()[0]}-1024.png"))
    print("ok")
