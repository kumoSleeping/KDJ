#!/usr/bin/env bash
# Android 原生媒体能力不能以无限膨胀安装包为代价。检查要交付的 arm64 release APK；SCNet 的
# ExecuTorch Vulkan runtime 是一份约 19 MiB 的 page-aligned native library，模型 .pte
# 则在首次启用时另行下载，不能拿旧 20 MiB 媒体播放器预算误杀真实测试包。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/gen/android/app/build/outputs/apk"
MAX_BYTES=$((48 * 1024 * 1024))
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
    echo "::error::$(basename "$apk") 超过 48 MiB 单包预算"
    failed=1
  fi
done < <(
  if (( $# > 0 )); then
    printf '%s\0' "$@"
  else
    # Debug APK 保留 Rust DWARF，体积不能代表安装给测试者的 release 包。只要 release
    # 目录即可避免一次本地 debug 编译把随后 release 的门禁误报成失败。
    find "$OUT" -type f -path '*/release/*.apk' -print0 | sort -z
  fi
)

if (( found == 0 )); then
  echo "::error::没有找到 Android APK"
  exit 1
fi
exit "$failed"
