"""F 方案定稿候选：云 + 一叠（Kumo + Deck）。

去掉红色——红色是这个应用里"动作"的专用色，图标里没有动作。
三层改用同一色相的明度阶，堆叠感靠**明暗**而不是靠**撞色**，更像一个标志而不是插画。
"""
import os
from PIL import Image, ImageDraw
from render import S, BG, new, rounded_bg

INK = (242, 242, 246)
here = os.path.dirname(os.path.abspath(__file__))

def cloud(d, n, cx, cy, u, fill=INK):
    for dx, dy, k in ((-0.60, 0.10, 0.62), (-0.05, -0.22, 0.86), (0.58, 0.06, 0.66)):
        r = u * k
        d.ellipse([cx + dx * u - r, cy + dy * u - r, cx + dx * u + r, cy + dy * u + r], fill=fill)
    d.rounded_rectangle([cx - u * 1.16, cy - u * 0.10, cx + u * 1.16, cy + u * 0.62],
                        radius=int(u * 0.34), fill=fill)

def stack(d, n, cx, top, layers):
    for w, alpha, dy in layers:
        c = tuple(int(INK[i] * alpha + BG[i] * (1 - alpha)) for i in range(3))
        y = top + n * dy
        d.rounded_rectangle([cx - n * w / 2, y, cx + n * w / 2, y + n * 0.070],
                            radius=int(n * 0.030), fill=c)

def f1(size):
    """F1 · 明度阶：越下面越暗，像叠在下面被压住。"""
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    cloud(d, n, cx, n * 0.335, n * 0.170)
    stack(d, n, cx, n * 0.555, [(0.30, 1.00, 0.0), (0.37, 0.62, 0.098), (0.44, 0.34, 0.196)])
    return img.resize((size, size), Image.LANCZOS)

def f2(size):
    """F2 · 反过来：越下面越亮，重心压得住，小尺寸下轮廓更实。"""
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    cloud(d, n, cx, n * 0.335, n * 0.170)
    stack(d, n, cx, n * 0.555, [(0.30, 0.38, 0.0), (0.37, 0.66, 0.098), (0.44, 1.00, 0.196)])
    return img.resize((size, size), Image.LANCZOS)

def f3(size):
    """F3 · 两层 + 收紧：16px 下三层必糊，两层更抗压。"""
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    cloud(d, n, cx, n * 0.365, n * 0.185)
    stack(d, n, cx, n * 0.600, [(0.34, 0.55, 0.0), (0.42, 1.00, 0.110)])
    return img.resize((size, size), Image.LANCZOS)

def f4(size):
    """F4 · 云咬进第一层：遮挡关系比"上下分离"更整体，也更省高度。"""
    img, d = new(size); n = size * S; cx = n / 2
    rounded_bg(d, size)
    stack(d, n, cx, n * 0.520, [(0.32, 0.55, 0.0), (0.40, 0.80, 0.105), (0.48, 1.00, 0.210)])
    # 先用底色垫一层，做出云压在叠子上的遮挡
    cloud(d, n, cx, n * 0.360, n * 0.205, fill=BG)
    cloud(d, n, cx, n * 0.350, n * 0.180)
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {"F1-越下越暗": f1, "F2-越下越亮": f2, "F3-两层收紧": f3, "F4-云咬叠": f4}

if __name__ == "__main__":
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
    sheet.save(os.path.join(here, "final-variants.png"))
    for name, fn in VARIANTS.items():
        fn(512).save(os.path.join(here, f"{name.split('-')[0]}-512.png"))
    print("ok")
