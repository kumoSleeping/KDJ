"""B 方案的三个改进变体。"""
import math
from PIL import Image, ImageDraw
from render import S, BG, camelot_color, new, rounded_bg

def wheel(d, n, cx, cy, r_out, r_in, gap_deg):
    for i in range(12):
        a0 = i * 30 - 90 + gap_deg / 2
        a1 = (i + 1) * 30 - 90 - gap_deg / 2
        d.arc([cx - r_out, cy - r_out, cx + r_out, cy + r_out],
              a0, a1, fill=camelot_color(i + 1, "B"), width=int(r_out - r_in))

def cloud(d, n, cx, cy, scale, fill=(240, 240, 244)):
    """压扁的云。原版三个等大圆太圆太萌，这版拉宽压低，接近符号而不是插画。"""
    u = n * scale
    for dx, dy, k in ((-0.60, 0.10, 0.62), (-0.05, -0.22, 0.86), (0.58, 0.06, 0.66)):
        r = u * k
        d.ellipse([cx + dx * u - r, cy + dy * u - r, cx + dx * u + r, cy + dy * u + r], fill=fill)
    d.rounded_rectangle([cx - u * 1.16, cy - u * 0.10, cx + u * 1.16, cy + u * 0.62],
                        radius=int(u * 0.34), fill=fill)

def b1(size):
    """B1 · 云收小压扁，环加粗，缝隙加大。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx = cy = n / 2
    wheel(d, n, cx, cy, n * 0.405, n * 0.30, gap_deg=6)
    cloud(d, n, cx, cy + n * 0.012, 0.115)
    return img.resize((size, size), Image.LANCZOS)

def b2(size):
    """B2 · 无缝隙渐变环：12 段贴合，小尺寸下融成一条连续色环，最抗压。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx = cy = n / 2
    wheel(d, n, cx, cy, n * 0.405, n * 0.295, gap_deg=0)
    cloud(d, n, cx, cy + n * 0.012, 0.115)
    return img.resize((size, size), Image.LANCZOS)

def b3(size):
    """B3 · 云咬进环里：云盖住环的下缘，形成遮挡关系，比"环里放个云"更有层次。"""
    img, d = new(size); n = size * S
    rounded_bg(d, size); cx = cy = n / 2
    wheel(d, n, cx, cy, n * 0.405, n * 0.30, gap_deg=5)
    # 先用底色描一圈把环咬开，再画云——遮挡感靠这个"垫底"做出来
    cloud(d, n, cx, cy + n * 0.055, 0.150, fill=BG)
    cloud(d, n, cx, cy + n * 0.045, 0.132)
    return img.resize((size, size), Image.LANCZOS)

VARIANTS = {"B1-收小压扁": b1, "B2-无缝色环": b2, "B3-云咬环": b3}

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
    sheet.save("design/icon/variants.png")
    for name, fn in VARIANTS.items():
        fn(512).save(f"design/icon/{name.split('-')[0]}-512.png")
    print("ok")
