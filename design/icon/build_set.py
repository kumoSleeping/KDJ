"""把选中的图标（wave4 的 E3：白色整圆 CD + 三条主题色竖杠）铺成全平台素材。

先落在 out/ 里，**不动 src-tauri/icons** —— 换图标是不可逆覆盖，
确认之前不该碰打包目录。文件名和 src-tauri/icons 一一对应，
确认后直接 rsync 过去即可。

三个坑写在这里，别按"渲染一张大的再缩"的直觉来做：
1. 小尺寸每档单独渲染。把 512 缩到 16 会把三条竖杠糊成一坨灰，
   而单独渲染时圆角/线宽是按那一档的像素算的，能留住形。
2. Android 的 ic_launcher_foreground 是自适应图标的前景层，
   系统会把它裁进各种形状的遮罩里，安全区只有中间 66%，
   所以前景层要按 66% 缩、且不能带背景板。
3. iOS 不接受带 alpha 的 PNG，圆角也由系统裁——所以 iOS 那套要
   平铺不透明背景、且不画自己的圆角。
"""
import os, subprocess, shutil
from PIL import Image, ImageDraw
from render import S, BG, new, rounded_bg
from disc import make as _disc, INK, THEME

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "out")
shutil.rmtree(out, ignore_errors=True)

# 选中的图标：S3 = 红盘 + 0.30 方孔。换白盘只需把 COLOR 改成 INK。
COLOR, SQ, RAD = THEME, 0.30, 0.300

def render(size, *, rad=RAD, rounded=True, opaque=False):
    img = _disc(size, rad=rad, sq=SQ, color=COLOR)
    if not rounded:
        # iOS：系统自己裁圆角，自己再画一层会露出双重圆角的毛边；
        # 同时 iOS 不收带 alpha 的 PNG，所以底要铺实。
        flat = Image.new("RGBA", img.size, BG + (255,))
        n = size * S
        d = ImageDraw.Draw(flat)
        c, r = size / 2, size * rad
        d.ellipse([c - r, c - r, c + r, c + r], fill=COLOR + (255,))
        half = r * SQ
        d.rectangle([c - half, c - half, c + half, c + half], fill=BG + (255,))
        img = flat
    return img.convert("RGB") if opaque else img

def foreground(size):
    """Android 自适应图标前景：无底板，标记缩进 66% 安全区。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c, r = size / 2, size * RAD * 0.66
    d.ellipse([c - r, c - r, c + r, c + r], fill=COLOR + (255,))
    half = r * SQ
    # 前景层不能用 BG 填方孔（那会在遮罩里变成一块实心深色方块），
    # 必须真的掏成透明，让下面的背景层透上来
    d.rectangle([c - half, c - half, c + half, c + half], fill=(0, 0, 0, 0))
    return img

def save(img, *parts):
    p = os.path.join(out, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p)

# ---- Tauri 桌面 ----
for s in [32, 64, 128, 256, 512]:
    save(render(s), f"{s}x{s}.png")
save(render(256), "128x128@2x.png")
save(render(512), "icon.png")
save(render(1024), "icon-1024.png")

# ---- Windows Store ----
for name, s in [("Square30x30Logo", 30), ("Square44x44Logo", 44), ("Square71x71Logo", 71),
                ("Square89x89Logo", 89), ("Square107x107Logo", 107), ("Square142x142Logo", 142),
                ("Square150x150Logo", 150), ("Square284x284Logo", 284),
                ("Square310x310Logo", 310), ("StoreLogo", 50)]:
    save(render(s), f"{name}.png")

# ---- Windows .ico ----
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [render(s) for s in ico_sizes]
os.makedirs(out, exist_ok=True)
imgs[-1].save(os.path.join(out, "icon.ico"), sizes=[(s, s) for s in ico_sizes],
              append_images=imgs[:-1])

# ---- macOS .icns ----
iconset = os.path.join(out, "icon.iconset")
os.makedirs(iconset)
for s in [16, 32, 128, 256, 512]:
    render(s).save(os.path.join(iconset, f"icon_{s}x{s}.png"))
    render(s * 2).save(os.path.join(iconset, f"icon_{s}x{s}@2x.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(out, "icon.icns")], check=True)
shutil.rmtree(iconset)

# ---- Android ----
for dpi, s in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    save(render(s), f"android/mipmap-{dpi}/ic_launcher.png")
    save(render(s), f"android/mipmap-{dpi}/ic_launcher_round.png")
    save(foreground(s), f"android/mipmap-{dpi}/ic_launcher_foreground.png")

# ---- iOS（不透明、不自带圆角）----
IOS = {
    "AppIcon-20x20@1x": 20, "AppIcon-20x20@2x": 40, "AppIcon-20x20@2x-1": 40,
    "AppIcon-20x20@3x": 60, "AppIcon-29x29@1x": 29, "AppIcon-29x29@2x": 58,
    "AppIcon-29x29@2x-1": 58, "AppIcon-29x29@3x": 87, "AppIcon-40x40@1x": 40,
    "AppIcon-40x40@2x": 80, "AppIcon-40x40@2x-1": 80, "AppIcon-40x40@3x": 120,
    "AppIcon-60x60@2x": 120, "AppIcon-60x60@3x": 180, "AppIcon-76x76@1x": 76,
    "AppIcon-76x76@2x": 152, "AppIcon-83.5x83.5@2x": 167, "AppIcon-512@2x": 1024,
}
for name, s in IOS.items():
    save(render(s, rounded=False, opaque=True), f"ios/{name}.png")

n = sum(len(f) for _, _, f in os.walk(out))
print(f"生成 {n} 个文件 → {out}")
