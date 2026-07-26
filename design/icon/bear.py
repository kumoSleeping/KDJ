"""照片里的红色小熊灯 → 矢量图标。

留什么、丢什么：
  · 留：圆红脸、两只顶在头上的小耳朵（浅色耳尖）、极简的点眼+鼻嘴、
        肚子里透出来的那团暖黄灯光——它是"灯"的身份，也是唯一的第二色。
  · 丢：照片里的一切环境（打碟机、线材），以及立体感过强的高光——
        图标要在 16px 活下来，细节只能留脸。
"""
import os
from squircle import squircle_path

here = os.path.dirname(os.path.abspath(__file__))
SQ = squircle_path(512)

DEFS = f"""
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#232328"/>
    <stop offset=".55" stop-color="#141417"/>
    <stop offset="1" stop-color="#0e0e10"/>
  </linearGradient>
  <radialGradient id="body" cx=".42" cy=".30" r=".95">
    <stop offset="0" stop-color="#ff8a75"/>
    <stop offset=".45" stop-color="#f4574a"/>
    <stop offset="1" stop-color="#d92b23"/>
  </radialGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5">
    <stop offset="0" stop-color="#ffd76b"/>
    <stop offset=".55" stop-color="#ffb445"/>
    <stop offset="1" stop-color="#ff8d3a" stop-opacity="0"/>
  </radialGradient>
  <clipPath id="sq"><path d="{SQ}"/></clipPath>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".40"/>
  </filter>
  <filter id="halo" x="-60%" y="-60%" width="220%" height="220%">
    <feDropShadow dx="0" dy="0" stdDeviation="26" flood-color="#f4574a" flood-opacity=".45"/>
  </filter>
</defs>"""

BASE = f"""
<path d="{SQ}" fill="url(#bg)"/>
<g clip-path="url(#sq)">
  <ellipse cx="256" cy="-30" rx="330" ry="220" fill="#ffffff" opacity=".05"/>
</g>"""

def face(scale=1.0, cx=256, cy=262, black="#241a18"):
    """点眼 + 鼻嘴。鼻嘴是照片同款：小圆鼻下面一个 ω 微笑。"""
    s = scale
    return f"""
  <g fill="{black}">
    <circle cx="{cx - 62*s}" cy="{cy - 18*s}" r="{11*s}"/>
    <circle cx="{cx + 62*s}" cy="{cy - 18*s}" r="{11*s}"/>
    <circle cx="{cx}" cy="{cy + 14*s}" r="{9*s}"/>
  </g>
  <path d="M {cx - 34*s} {cy + 34*s} Q {cx - 17*s} {cy + 52*s} {cx} {cy + 36*s}
           Q {cx + 17*s} {cy + 52*s} {cx + 34*s} {cy + 34*s}"
        fill="none" stroke="{black}" stroke-width="{10*s}" stroke-linecap="round"/>"""

def ears(cx=256, cy=250, r=170, tip="#cbb7b3"):
    ex = 118
    return f"""
  <g>
    <circle cx="{cx-ex}" cy="{cy-r+18}" r="46" fill="url(#body)"/>
    <circle cx="{cx+ex}" cy="{cy-r+18}" r="46" fill="url(#body)"/>
    <circle cx="{cx-ex}" cy="{cy-r+10}" r="24" fill="{tip}"/>
    <circle cx="{cx+ex}" cy="{cy-r+10}" r="24" fill="{tip}"/>
  </g>"""

def bear(*, glow=True, halo=False, r=170, cy=250):
    body_filter = "url(#halo)" if halo else "url(#soft)"
    glow_svg = (f'<ellipse cx="256" cy="{cy + r*0.62}" rx="86" ry="58" fill="url(#glow)" opacity=".95"/>'
                if glow else "")
    return f"""
  <g filter="{body_filter}">
    {ears(cy=cy, r=r)}
    <circle cx="256" cy="{cy}" r="{r}" fill="url(#body)"/>
    {glow_svg}
    {face(cy=cy + 12)}
  </g>"""

def svg(body):
    return f'<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">{DEFS}{BASE}{body}</svg>'

VARIANTS = {
    "X1 小熊+肚灯":   svg(bear()),
    "X2 小熊·无灯":   svg(bear(glow=False)),
    "X3 红光晕":      svg(bear(halo=True)),
    "X4 大脸怼满":    svg(bear(r=210, cy=268)),
}

SIZES = [200, 64, 32, 16]

cells = []
for name, s in VARIANTS.items():
    row = "".join(f'<div class="ic" style="width:{z}px;height:{z}px">{s}</div>' for z in SIZES)
    cells.append(f'<figure><div class="row">{row}</div><figcaption>{name}</figcaption></figure>')
html = f"""<meta charset="utf-8"><style>
  body{{margin:0;background:#1a1a1e;font:13px -apple-system,sans-serif;color:#d4d4d8;
        padding:26px;display:grid;grid-template-columns:repeat(2,1fr);gap:30px 46px}}
  figure{{margin:0}} .row{{display:flex;align-items:center;gap:18px}}
  .ic svg{{display:block;width:100%;height:100%}} figcaption{{margin-top:10px;opacity:.8}}
</style>{''.join(cells)}"""
open(os.path.join(here, "bear-sheet.html"), "w").write(html)
print("ok")
