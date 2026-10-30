#!/usr/bin/env bash
# 当前模型分离只使用 Rust 的 model-free 算法，不再打包 ExecuTorch / NativeLoader / fbjni。
# 这里验证 APK 的内容、arm64 split 和 native library 的现代未压缩布局。体积只打印，
# 没有上限（2026-10-14 拆掉）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src-tauri/gen/android/app/build/outputs/apk"
# CI 的时间标记保证只核验刚构建的 APK。
BUILD_MARKER="${KDJ_ANDROID_BUILD_MARKER:-}"
found=0
failed=0

for required_tool in unzip strings; do
  command -v "$required_tool" >/dev/null \
    || { echo "::error::APK 检查缺少工具：$required_tool"; exit 1; }
done

while IFS= read -r -d '' apk; do
  found=1
  # wc -c 是唯一跨 GNU/BSD 一致的取大小方式；stat 的 -f %z 在 GNU 上是另一套
  # 语义（文件系统信息而不是文件大小），曾把 APK 读成 0 字节误报门禁。
  bytes=$(wc -c < "$apk")
  mib=$(awk -v n="$bytes" 'BEGIN { printf "%.2f", n / 1024 / 1024 }')
  echo "APK $(basename "$apk"): ${mib} MiB"

  if ! entries=$(unzip -Z1 "$apk"); then
    echo "::error::$(basename "$apk") 不是可读取的 APK/ZIP"
    failed=1
    continue
  fi

  forbidden_entries=$(
    printf '%s\n' "$entries" \
      | grep -Ei '(^|/)(lib)?(executorch|fbjni|nativeloader)([^/]*)(/|$)|StemRuntime|kdj-executorch' \
      || true
  )
  if [ -n "$forbidden_entries" ]; then
    echo "::error::$(basename "$apk") 仍包含已停用的模型 runtime artifact："
    printf '%s\n' "$forbidden_entries"
    failed=1
  fi

  # AAR 中的 Java/Kotlin 类最终进入 classes*.dex，不一定会留下同名 ZIP entry。
  # strings 只作为明确包名/类名的负向门禁，不把普通的“model”字样误判成 runtime。
  dex_matches=$(
    unzip -p "$apk" 'classes*.dex' \
      | strings \
      | grep -Ei 'org[./]pytorch[./]executorch|com[./]facebook[./](fbjni|jni|soloader[./]nativeloader)|lib(executorch|fbjni|nativeloader)\.so' \
      || true
  )
  if [ -n "$dex_matches" ]; then
    echo "::error::$(basename "$apk") 的 DEX 仍包含 ExecuTorch / NativeLoader / fbjni 类："
    printf '%s\n' "$dex_matches" | sed -n '1,20p'
    failed=1
  fi

  # Rust 的 HTTPS 校验经 JNI 调这个类（android-postinit.sh 第 7 步接入、R8 keep）；
  # 缺了它，应用一启动发出第一条 HTTPS 请求就 abort。
  if ! unzip -p "$apk" 'classes*.dex' | strings | grep -Fq 'Lorg/rustls/platformverifier/CertificateVerifier;'; then
    echo "::error::$(basename "$apk") 的 DEX 缺少 org.rustls.platformverifier.CertificateVerifier"
    failed=1
  fi

  for required in \
    lib/arm64-v8a/libkdj_app_lib.so \
    lib/arm64-v8a/libc++_shared.so; do
    if ! printf '%s\n' "$entries" | grep -Fqx "$required"; then
      echo "::error::$(basename "$apk") 缺少必要的 $required"
      failed=1
    fi
  done

  unexpected_abis=$(
    printf '%s\n' "$entries" \
      | awk -F/ '$1 == "lib" && $2 != "arm64-v8a" { print }'
  )
  if [ -n "$unexpected_abis" ]; then
    echo "::error::$(basename "$apk") 混入非 arm64 ABI，split-per-abi 已失效："
    printf '%s\n' "$unexpected_abis"
    failed=1
  fi

  native_rows=$(unzip -lv "$apk" | awk '$8 ~ /^lib\/arm64-v8a\/.*\.so$/ { print }')
  compressed_native=$(printf '%s\n' "$native_rows" | awk 'NF && $2 != "Stored" { print }')
  if [ -z "$native_rows" ]; then
    echo "::error::$(basename "$apk") 没有可核验的 arm64 native library"
    failed=1
  elif [ -n "$compressed_native" ]; then
    echo "::error::$(basename "$apk") 出现压缩 native library；不得启用 useLegacyPackaging："
    printf '%s\n' "$compressed_native"
    failed=1
  fi
done < <(
  if (( $# > 0 )); then
    for apk_arg in "$@"; do
      if [ ! -f "$apk_arg" ]; then
        echo "::error::指定 APK 不存在：$apk_arg" >&2
        exit 1
      fi
      printf '%s\0' "$apk_arg"
    done
  else
    # Debug APK 保留 Rust DWARF，体积不能代表安装给测试者的 release 包。只要 release
    # 目录即可避免一次本地 debug 编译把随后 release 的门禁误报成失败。
    if [ -n "$BUILD_MARKER" ]; then
      if [ ! -f "$BUILD_MARKER" ]; then
        echo "::error::APK 构建起点不存在：$BUILD_MARKER" >&2
        exit 1
      fi
      find "$OUT" -type f -path '*/release/*.apk' -newer "$BUILD_MARKER" -print0
    else
      echo "::warning::未提供 KDJ_ANDROID_BUILD_MARKER；仅核验现有 release APK，不能证明它来自本次构建" >&2
      find "$OUT" -type f -path '*/release/*.apk' -print0
    fi
  fi
)

if (( found == 0 )); then
  echo "::error::没有找到本次生成的 Android release APK"
  exit 1
fi
exit "$failed"
