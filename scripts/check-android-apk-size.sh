#!/usr/bin/env bash
# Android 原生媒体能力不能以无限膨胀安装包为代价。检查每个 ABI APK，而不是
# 把互斥的 arm64/armv7 机器码相加；用户实际只会下载其中一个。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/gen/android/app/build/outputs/apk"
MAX_BYTES=$((20 * 1024 * 1024))
BASELINE_BYTES=$((16 * 1024 * 1024))
found=0
failed=0

while IFS= read -r -d '' apk; do
  found=1
  # wc -c 是唯一跨 GNU/BSD 一致的取大小方式；stat 的 -f %z 在 GNU 上是另一套
  # 语义（文件系统信息而不是文件大小），曾把 APK 读成 0 字节误报门禁。
  bytes=$(wc -c < "$apk")
  mib=$(awk -v n="$bytes" 'BEGIN { printf "%.2f", n / 1024 / 1024 }')
  delta=$(awk -v n="$bytes" -v b="$BASELINE_BYTES" 'BEGIN { printf "%+.2f", (n - b) / 1024 / 1024 }')
  echo "APK $(basename "$apk"): ${mib} MiB（相对约 16 MiB 基线 ${delta} MiB）"
  if (( bytes > MAX_BYTES )); then
    echo "::error::$(basename "$apk") 超过 20 MiB 单包预算"
    failed=1
  fi
done < <(find "$OUT" -type f -name '*.apk' -print0 | sort -z)

if (( found == 0 )); then
  echo "::error::没有找到 Android APK"
  exit 1
fi
exit "$failed"
