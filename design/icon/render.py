"""图标方案渲染。4 倍超采样再缩，PIL 的 arc 没有抗锯齿。"""
import colorsys, math
from PIL import Image, ImageDraw

S = 4                      # 超采样倍数
BG = (17, 17, 19)          # --kd-bg
THEME = (239, 68, 68)      # --kd-theme
HUE_OFFSET = 20            # 和 camelot.ts 对齐

def camelot_color(number, letter):
    """逐行照抄 src/lib/camelot.ts::camelotColor，图标和 UI 必须是同一套色。"""
    hue = ((number - 1) * 30 + HUE_OFFSET) % 360
    sat = 0.45 if letter == "A" else 0.80
    light = (66 + 6 * math.cos(math.radians(hue - 240))) / 100
    r, g, b = colorsys.hls_to_rgb(hue / 360, light, sat)
    return (int(r * 255), int(g * 255), int(b * 255))

def new(size):
    img = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)

def rounded_bg(draw, size, radius_ratio=0.225):
    """macOS 的 squircle 近似。图标必须自带底，透明底在浅色壁纸上会糊掉。"""
    n = size * S
    draw.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * radius_ratio), fill=BG)

def ring_segments(draw, size, cx, cy, r_out, r_in, lit, gap_deg=3.5, dim=(46, 46, 52)):
    """12 段环。lit 是 {段号: 颜色}，其余画成暗底——留着轮廓才看得出"这是个刻度环"。"""
    for i in range(12):
        a0 = i * 30 - 90 + gap_deg / 2
        a1 = (i + 1) * 30 - 90 - gap_deg / 2
        color = lit.get(i + 1, dim)
        draw.arc([cx - r_out, cy - r_out, cx + r_out, cy + r_out],
                 a0, a1, fill=color, width=int(r_out - r_in))

def concept_a(size):
    """A · 和声接歌：外环大调、内环小调，点亮 8B 和它的三个兼容位。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    cx = cy = n / 2
    # 外环 = B（大调，饱和度高）
    lit_b = {8: camelot_color(8, "B"), 7: camelot_color(7, "B"), 9: camelot_color(9, "B")}
    ring_segments(d, size, cx, cy, n * 0.40, n * 0.305, lit_b)
    # 内环 = A（小调）。只点亮同号那格 = 相对大小调
    lit_a = {8: camelot_color(8, "A")}
    ring_segments(d, size, cx, cy, n * 0.275, n * 0.195, lit_a)
    return img.resize((size, size), Image.LANCZOS)

def concept_b(size):
    """B · 云中轮：外环完整，中心挖出一朵极简的云（kumo）。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    cx = cy = n / 2
    lit = {i: camelot_color(i, "B") for i in range(1, 13)}
    ring_segments(d, size, cx, cy, n * 0.40, n * 0.315, lit)
    # 云：三个圆 + 一个底座矩形，取并集
    r = n * 0.085
    for dx, dy, k in ((-0.075, 0.015, 1.0), (0.0, -0.03, 1.32), (0.082, 0.02, 0.95)):
        d.ellipse([cx + dx * n - r * k, cy + dy * n - r * k,
                   cx + dx * n + r * k, cy + dy * n + r * k], fill=(238, 238, 242))
    d.rounded_rectangle([cx - n * 0.155, cy + n * 0.005, cx + n * 0.16, cy + n * 0.10],
                        radius=int(n * 0.05), fill=(238, 238, 242))
    return img.resize((size, size), Image.LANCZOS)

def concept_c(size):
    """C · 单环极简：只留兼容那一段弧 + 一个当前位的实心点。小尺寸最抗压。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    cx = cy = n / 2
    r_out, r_in = n * 0.385, n * 0.275
    w = int(r_out - r_in)
    # 整圈暗底
    d.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], outline=(44, 44, 50), width=w)
    # 兼容区间：−1 / 当前 / +1 连成一段亮弧
    d.arc([cx - r_out, cy - r_out, cx + r_out, cy + r_out],
          -90 - 30, -90 + 60, fill=camelot_color(8, "B"), width=w)
    # 当前位：实心圆点，红色（唯一的强调）
    ang = math.radians(-90 + 15)
    pr = (r_out + r_in) / 2
    dot = n * 0.072
    d.ellipse([cx + pr * math.cos(ang) - dot, cy + pr * math.sin(ang) - dot,
               cx + pr * math.cos(ang) + dot, cy + pr * math.sin(ang) + dot], fill=THEME)
    return img.resize((size, size), Image.LANCZOS)

def concept_d(size):
    """D · 轮 + 波形：环内嵌三色波形，把"分析"这一层也说出来。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size)
    cx = cy = n / 2
    lit = {i: camelot_color(i, "B") for i in (7, 8, 9)}
    ring_segments(d, size, cx, cy, n * 0.40, n * 0.325, lit)
    # 中间一段三色波形（红=低频 绿=中频 蓝=高频，和 waveform.rs 同一套语义）
    bars = [(0.22, (239, 68, 68)), (0.42, (239, 68, 68)), (0.66, (110, 210, 130)),
            (0.95, (110, 210, 130)), (0.72, (120, 170, 245)), (0.48, (120, 170, 245)),
            (0.30, (239, 68, 68))]
    bw = n * 0.036
    span = len(bars) * bw * 1.62
    x = cx - span / 2 + bw * 0.3
    for h, color in bars:
        hh = n * 0.135 * h
        d.rounded_rectangle([x, cy - hh, x + bw, cy + hh], radius=int(bw / 2), fill=color)
        x += bw * 1.62
    return img.resize((size, size), Image.LANCZOS)

CONCEPTS = {"A-和声接歌": concept_a, "B-云中轮": concept_b,
            "C-单环极简": concept_c, "D-轮+波形": concept_d}

if __name__ == "__main__":
    # 对比图：每个方案三个尺寸，看小尺寸抗不抗压才是关键
    sizes = [256, 64, 32]
    pad, gap = 28, 26
    W = pad * 2 + sum(sizes) + gap * (len(sizes) - 1)
    rowh = max(sizes) + 34
    sheet = Image.new("RGB", (W, pad * 2 + rowh * len(CONCEPTS)), (24, 24, 27))
    dd = ImageDraw.Draw(sheet)
    for row, (name, fn) in enumerate(CONCEPTS.items()):
        y = pad + row * rowh
        dd.text((pad, y + max(sizes) + 12), name, fill=(210, 210, 216))
        x = pad
        for s in sizes:
            sheet.paste(fn(s), (x, y + (max(sizes) - s) // 2), fn(s))
            x += s + gap
    sheet.save("design/icon/concepts.png")
    for name, fn in CONCEPTS.items():
        fn(512).save(f"design/icon/{name.split('-')[0]}-512.png")
    print("ok")
