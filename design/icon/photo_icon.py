"""直接用用户照片当图标：把小熊抠出来贴到深色底上。

抠图不追求发丝级：小熊是画面里唯一"又亮又红"的东西，
按 (亮度, 红占比) 打分取最大连通块，再羽化 3px 边缘就够了。
"""
import os
from collections import deque
from PIL import Image, ImageDraw, ImageFilter
from render import S, new, rounded_bg

here = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.expanduser("~/.claude/image-cache/ad8efae5-a714-4184-8102-de0dadb42dae/3.png")

def bear_mask(im):
    """亮红像素 → 二值掩码 → 最大连通块。在缩小图上做，快且够准。"""
    small = im.convert("RGB").resize((im.width // 4, im.height // 4))
    w, h = small.size
    px = small.load()
    hit = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            # 又亮又红：红是主导通道，且绝对亮度够高（排除被红光染色的暗背景）
            if r > 150 and r > g * 1.55 and r > b * 1.35:
                hit[y][x] = True
    # BFS 找最大连通块
    seen = [[False] * w for _ in range(h)]
    best = []
    for y in range(h):
        for x in range(w):
            if hit[y][x] and not seen[y][x]:
                comp, queue = [], deque([(x, y)])
                seen[y][x] = True
                while queue:
                    cx, cy = queue.popleft()
                    comp.append((cx, cy))
                    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < w and 0 <= ny < h and hit[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            queue.append((nx, ny))
                if len(comp) > len(best):
                    best = comp
    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    for x, y in best:
        mp[x, y] = 255
    # 收掉毛边、补掉脸上的黑洞（眼睛嘴巴不是红色，会在掩码上开洞）
    mask = mask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(5))
    xs = [p[0] for p in best]; ys = [p[1] for p in best]
    return mask.resize(im.size, Image.LANCZOS), (min(xs)*4, min(ys)*4, max(xs)*4, max(ys)*4)

im = Image.open(SRC)
mask, (x0, y0, x1, y1) = bear_mask(im)
pad = int((x1 - x0) * 0.06)
box = (max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad))
bear = im.convert("RGBA").crop(box)
m = mask.crop(box).filter(ImageFilter.GaussianBlur(3))
bear.putalpha(m)
bear.save(os.path.join(here, "bear-cut.png"))

def photo_icon(size):
    img, d = new(size)
    n = size * S
    rounded_bg(d, size)
    # 小熊占图标 78%，坐得比几何图形满一点——照片元素缩小后视觉重量轻
    target = int(n * 0.78)
    k = target / max(bear.width, bear.height)
    scaled = bear.resize((int(bear.width * k), int(bear.height * k)), Image.LANCZOS)
    img.alpha_composite(scaled, (int((n - scaled.width) / 2), int((n - scaled.height) / 2)))
    return img.resize((size, size), Image.LANCZOS)

sizes = [256, 128, 64, 32, 16]
pad_, gap = 28, 24
W = pad_ * 2 + sum(sizes) + gap * (len(sizes) - 1)
sheet = Image.new("RGB", (W, pad_ * 2 + 256 + 34), (24, 24, 27))
dd = ImageDraw.Draw(sheet)
x = pad_
for s in sizes:
    t = photo_icon(s)
    sheet.paste(t, (x, pad_ + (256 - s) // 2), t)
    x += s + gap
dd.text((pad_, pad_ + 256 + 12), "PHOTO 直接用照片抠图", fill=(215, 215, 222))
sheet.save(os.path.join(here, "photo-icon.png"))
photo_icon(1024).save(os.path.join(here, "PHOTO-1024.png"))
print("ok")
