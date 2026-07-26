"""生成 Apple 那种超椭圆圆角路径。

`border-radius` 是圆弧接直线，接缝处曲率突变，放大看有"两个圆头夹一段直边"的感觉；
Apple 的图标外形是超椭圆 |x/a|^n + |y/b|^n = 1（n≈5），曲率连续，所以更"饱满"。
这是整个图标质感差异里最便宜也最明显的一项。
"""
import math

def squircle_path(size=512, n=5.0, steps=180):
    a = size / 2
    pts = []
    for i in range(steps + 1):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = a * math.copysign(abs(ct) ** (2 / n), ct)
        y = a * math.copysign(abs(st) ** (2 / n), st)
        pts.append((a + x, a + y))
    d = f"M {pts[0][0]:.2f} {pts[0][1]:.2f} " + " ".join(
        f"L {x:.2f} {y:.2f}" for x, y in pts[1:]) + " Z"
    return d

if __name__ == "__main__":
    print(squircle_path()[:120], "...")
