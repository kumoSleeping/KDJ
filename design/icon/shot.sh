#!/bin/bash
# 用 Chrome 无头把 HTML 截成 PNG。零依赖（不走 playwright，它在这个仓库里
# 只是别的包的传递依赖，从 design/icon 解析不到）。
#
# 坑：--window-size 给的是**物理像素**，Chrome 会先除以 device-scale-factor
# 才得到 CSS 视口。所以这里传 CSS 尺寸，脚本自己乘 scale，
# 否则 3 倍缩放下版面会被压成 1/3 宽然后截出一角。
set -euo pipefail
html="$1"; out="$2"; w="$3"; h="$4"; scale="${5:-3}"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-color-profile=srgb \
  --force-device-scale-factor="$scale" \
  --window-size="$((w * scale)),$((h * scale))" \
  --screenshot="$out" "file://$html" 2>/dev/null
echo "→ $out"
