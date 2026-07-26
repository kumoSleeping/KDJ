"""SVG 图标方案生成器 → HTML 对照表 → Chrome 截图。

和之前 PIL 那套的区别不在"换了个库"，在于这里能用：
  · 超椭圆外形（squircle.py），不是 border-radius
  · 线性/径向/锥形渐变——平涂色块是"廉价感"最大的来源
  · 内高光 + 外投影，形体才立得起来
  · 蒙版和路径布尔，负空间才能做干净

每个方案都是一段 viewBox="0 0 512 512" 的 SVG，所以同一份标记
直接实例化成 200/64/32/16 四档，小尺寸不是缩图而是真的重新光栅化。
"""
import os
from squircle import squircle_path

here = os.path.dirname(os.path.abspath(__file__))
SQ = squircle_path(512)

# 统一的底：不是平涂 #111113，而是顶部微亮的径向渐变 + 一道内高光。
# 平底在 macOS 的 Dock 里看着像一块贴纸，有微弱光照才像个"物体"。
DEFS_BASE = f"""
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0"   stop-color="#26262c"/>
    <stop offset=".55" stop-color="#151518"/>
    <stop offset="1"   stop-color="#0e0e10"/>
  </linearGradient>
  <linearGradient id="red" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff6b6b"/>
    <stop offset="1" stop-color="#dc2626"/>
  </linearGradient>
  <linearGradient id="redSoft" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f87171"/>
    <stop offset="1" stop-color="#e02424"/>
  </linearGradient>
  <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="1" stop-color="#d8d8e0"/>
  </linearGradient>
  <clipPath id="sq"><path d="{SQ}"/></clipPath>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
    <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#dc2626" flood-opacity=".55"/>
  </filter>
  <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
    <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity=".45"/>
  </filter>
</defs>"""

# 底 + 顶部内高光（1px 亮边是 iOS/macOS 图标的通用手法）
BASE = f"""
<path d="{SQ}" fill="url(#bg)"/>
<g clip-path="url(#sq)">
  <ellipse cx="256" cy="-40" rx="330" ry="230" fill="#ffffff" opacity=".055"/>
  <path d="{SQ}" fill="none" stroke="#ffffff" stroke-opacity=".16" stroke-width="3"/>
</g>"""

def svg(body, extra_defs=""):
    return f'<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">{DEFS_BASE}{extra_defs}{BASE}{body}</svg>'

# 箭头路径：杆是圆角矩形，头是三角，合成一条 path 才能整体上渐变
def arrow_path(cx=256, top=118, shaft_w=64, shaft_bot=290, head_w=196, tip=372, r=14):
    l, rr = cx - shaft_w / 2, cx + shaft_w / 2
    return (f"M {l+r} {top} H {rr-r} A {r} {r} 0 0 1 {rr} {top+r} "
            f"V {shaft_bot} H {cx+head_w/2} L {cx} {tip} L {cx-head_w/2} {shaft_bot} "
            f"V {top+r} A {r} {r} 0 0 1 {l+r} {top} Z")

VARIANTS = {}

VARIANTS["G1 渐变箭头"] = svg(f"""
  <path d="{arrow_path()}" fill="url(#red)" filter="url(#soft)"/>
  <rect x="146" y="404" width="220" height="34" rx="17" fill="url(#ink)"/>""")

VARIANTS["G2 红盘挖箭头"] = svg(f"""
  <circle cx="256" cy="256" r="168" fill="url(#red)" filter="url(#glow)"/>
  <g fill="#141416">
    <path d="{arrow_path(top=136, shaft_bot=272, tip=340, head_w=168, shaft_w=56)}"/>
    <rect x="176" y="358" width="160" height="26" rx="13"/>
  </g>""")

VARIANTS["G3 落下发光"] = svg(f"""
  <path d="{arrow_path(top=108, shaft_bot=282, tip=368)}" fill="url(#red)" filter="url(#glow)"/>
  <rect x="140" y="408" width="232" height="30" rx="15" fill="url(#ink)"/>
  <rect x="140" y="408" width="232" height="30" rx="15" fill="#ff6b6b" opacity=".25"/>""")

VARIANTS["G4 负空间"] = svg(f"""
  <g>
    <rect x="88" y="88" width="336" height="336" rx="96" fill="url(#red)" filter="url(#soft)"/>
    <g fill="#15151a">
      <path d="{arrow_path(top=146, shaft_bot=272, tip=336, head_w=152, shaft_w=52, r=12)}"/>
      <rect x="186" y="352" width="140" height="24" rx="12"/>
    </g>
  </g>""")

VARIANTS["G5 黑胶+箭头"] = svg(f"""
  <g filter="url(#soft)">
    <circle cx="256" cy="256" r="172" fill="url(#vinyl)"/>
    <g fill="none" stroke="#ffffff" stroke-opacity=".10" stroke-width="3">
      <circle cx="256" cy="256" r="148"/><circle cx="256" cy="256" r="126"/>
      <circle cx="256" cy="256" r="104"/>
    </g>
    <circle cx="256" cy="256" r="76" fill="url(#red)"/>
    <circle cx="256" cy="256" r="15" fill="#0e0e10"/>
  </g>""", """
  <radialGradient id="vinyl" cx=".38" cy=".28" r=".85">
    <stop offset="0" stop-color="#3a3a44"/><stop offset=".6" stop-color="#1b1b20"/>
    <stop offset="1" stop-color="#121216"/>
  </radialGradient>""")

VARIANTS["G6 凹槽托盘"] = svg(f"""
  <path d="{arrow_path(top=104, shaft_bot=256, tip=330, head_w=180, shaft_w=60)}"
        fill="url(#red)" filter="url(#soft)"/>
  <path d="M 128 316 v 60 a 28 28 0 0 0 28 28 h 200 a 28 28 0 0 0 28 -28 v -60"
        fill="none" stroke="url(#ink)" stroke-width="34" stroke-linecap="round"/>""")

VARIANTS["G7 白杆红头"] = svg(f"""
  <rect x="228" y="112" width="56" height="180" rx="14" fill="url(#ink)"/>
  <path d="M 158 268 H 354 L 256 380 Z" fill="url(#red)" filter="url(#glow)"/>
  <rect x="146" y="412" width="220" height="30" rx="15" fill="url(#ink)" opacity=".55"/>""")

VARIANTS["G8 描边"] = svg("""
  <g fill="none" stroke="url(#red)" stroke-width="44" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 256 118 V 322"/>
    <path d="M 166 246 L 256 336 L 346 246"/>
  </g>
  <path d="M 150 414 H 362" fill="none" stroke="url(#ink)" stroke-width="38" stroke-linecap="round"/>""")

VARIANTS["G9 唱片落下"] = svg(f"""
  <rect x="232" y="96" width="48" height="132" rx="12" fill="url(#ink)" opacity=".75"/>
  <g filter="url(#glow)">
    <circle cx="256" cy="330" r="126" fill="url(#redSoft)"/>
    <circle cx="256" cy="330" r="34" fill="#101013"/>
  </g>
  <path d="M 196 258 L 256 318 L 316 258" fill="none" stroke="url(#ink)"
        stroke-width="26" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>""")

VARIANTS["G10 方托盘"] = svg(f"""
  <path d="{arrow_path(top=96, shaft_bot=248, tip=322, head_w=184, shaft_w=62)}"
        fill="url(#red)" filter="url(#soft)"/>
  <rect x="120" y="348" width="272" height="76" rx="26" fill="url(#ink)"/>
  <rect x="120" y="348" width="272" height="76" rx="26" fill="#000" opacity=".18"
        style="mix-blend-mode:multiply"/>""")

SIZES = [200, 64, 32, 16]

def build_sheet(path):
    cells = []
    for name, s in VARIANTS.items():
        row = "".join(
            f'<div class="ic" style="width:{z}px;height:{z}px">{s}</div>' for z in SIZES)
        cells.append(f'<figure><div class="row">{row}</div><figcaption>{name}</figcaption></figure>')
    html = f"""<meta charset="utf-8"><style>
      body{{margin:0;background:#1a1a1e;font:13px -apple-system,sans-serif;color:#d4d4d8;
            padding:26px;display:grid;grid-template-columns:repeat(2,1fr);gap:30px 46px}}
      figure{{margin:0}}
      .row{{display:flex;align-items:center;gap:18px}}
      .ic svg{{display:block;width:100%;height:100%}}
      figcaption{{margin-top:10px;opacity:.8}}
    </style>{''.join(cells)}"""
    open(path, "w").write(html)

if __name__ == "__main__":
    p = os.path.join(here, "svg-sheet.html")
    build_sheet(p)
    print(p)
