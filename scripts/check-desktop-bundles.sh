#!/usr/bin/env bash
set -euo pipefail

# Desktop release artifact check.
#
# Usage:
#   check-desktop-bundles.sh <matrix-label> <version> <require-updater> [target roots...]
#
# Fails when an installer the release promises is missing or built twice, when an updater
# signature is missing on a tag build, or when the Windows program imports an external VC++
# runtime. Sizes are printed for the record (decimal MB, as the GitHub Releases API counts);
# there is no size limit: a limit stopped 1.1.0-rc3 over 5 kB and was taken out (2026-10-14).

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <macos-arm64|macos-x86_64|windows-x86_64|linux-x86_64> <x.y.z[-suffix]> <true|false> [target roots...]" >&2
  exit 2
fi
label="$1"
version="$2"
require_updater="$3"
shift 3

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'; then
  echo "version must use x.y.z or x.y.z-suffix format" >&2
  exit 2
fi
case "$require_updater" in
  true|false) ;;
  *) echo "require-updater must be true or false" >&2; exit 2 ;;
esac

roots=()
if [ "$#" -gt 0 ]; then
  for root in "$@"; do
    [ -d "$root" ] && roots+=("$root")
  done
else
  [ -d target ] && roots+=(target)
  [ -d src-tauri/target ] && roots+=(src-tauri/target)
fi
if [ "${#roots[@]}" -eq 0 ]; then
  echo "no build output roots exist" >&2
  exit 2
fi

failures=0
matches=()

format_mb() {
  awk -v bytes="$1" 'BEGIN { printf "%.2f MB", bytes / 1000000 }'
}

find_exact() {
  local bundle_dir="$1"
  local filename="$2"
  local root path
  matches=()
  for root in "${roots[@]}"; do
    while IFS= read -r -d '' path; do
      matches+=("$path")
    done < <(find "$root" -type f -path "*/release/bundle/${bundle_dir}/${filename}" -print0 2>/dev/null || true)
  done
}

report_missing() {
  local artifact="$1"
  local expected="$2"
  local status="$3"
  printf '| `%s` | — | %s: `%s` |\n' "$artifact" "$status" "$expected"
}

check_artifact() {
  local artifact="$1"
  local bundle_dir="$2"
  local filename="$3"
  local file bytes

  find_exact "$bundle_dir" "$filename"
  if [ "${#matches[@]}" -ne 1 ]; then
    report_missing "$artifact" "*/release/bundle/${bundle_dir}/${filename}" "FAIL (found ${#matches[@]})"
    failures=$((failures + 1))
    return
  fi

  file="${matches[0]}"
  bytes=$(wc -c <"$file" | tr -d ' ')
  printf '| `%s` | %s | present |\n' "$(basename "$file")" "$(format_mb "$bytes")"
}

check_signature() {
  local artifact="$1"
  local bundle_dir="$2"
  local filename="$3"

  find_exact "$bundle_dir" "$filename.sig"
  if [ "${#matches[@]}" -eq 1 ]; then
    return
  fi
  if [ "$require_updater" = true ] || [ "${#matches[@]}" -gt 1 ]; then
    report_missing "$artifact signature" "*/release/bundle/${bundle_dir}/${filename}.sig" "FAIL (found ${#matches[@]})"
    failures=$((failures + 1))
  else
    report_missing "$artifact signature" "optional on non-tag builds" "SKIP"
  fi
}

check_optional_mac_updater() {
  local arch="$1"
  local filename

  filename="KDJ.app.tar.gz"
  find_exact macos "$filename"
  if [ "${#matches[@]}" -eq 0 ]; then
    report_missing "macOS ${arch} updater" "not generated without updater credentials" "SKIP"
    return
  fi
  check_artifact "macOS ${arch} updater" macos "$filename"
  check_signature "macOS ${arch} updater" macos "$filename"
}

echo "### Desktop bundles — \`$label\`"
echo
echo '| Artifact | Size | Result |'
echo '| --- | ---: | --- |'

case "$label" in
  macos-arm64)
    check_artifact "macOS arm64 DMG" dmg "KDJ_${version}_aarch64.dmg"
    if [ "$require_updater" = true ]; then
      updater="KDJ_${version}_aarch64.app.tar.gz"
      check_artifact "macOS arm64 updater" macos "$updater"
      check_signature "macOS arm64 updater" macos "$updater"
    else
      check_optional_mac_updater aarch64
    fi
    ;;
  macos-x86_64)
    check_artifact "macOS x86_64 DMG" dmg "KDJ_${version}_x64.dmg"
    if [ "$require_updater" = true ]; then
      updater="KDJ_${version}_x86_64.app.tar.gz"
      check_artifact "macOS x86_64 updater" macos "$updater"
      check_signature "macOS x86_64 updater" macos "$updater"
    else
      check_optional_mac_updater x86_64
    fi
    ;;
  windows-x86_64)
    # Test the installed program's imports, since CI has VC++ runtimes preinstalled.
    find_exact nsis "KDJ_${version}_x64-setup.exe"
    if [ "${#matches[@]}" -eq 1 ]; then
      app="$(dirname "$(dirname "$(dirname "${matches[0]}")")")/kdj-app.exe"
      powershell.exe -NoProfile -File \
        "$(dirname "$0")/check-windows-runtime.ps1" -Binary "$app"
    fi
    # NSIS is the default installer/updater. MSI is also a promised release format.
    check_artifact "Windows NSIS" nsis "KDJ_${version}_x64-setup.exe"
    check_signature "Windows NSIS" nsis "KDJ_${version}_x64-setup.exe"
    check_artifact "Windows MSI" msi "KDJ_${version}_x64_en-US.msi"
    check_signature "Windows MSI" msi "KDJ_${version}_x64_en-US.msi"
    ;;
  linux-x86_64)
    # Keep every supported Linux format: compact distro packages plus portable AppImage.
    check_artifact "Linux deb" deb "KDJ_${version}_amd64.deb"
    check_signature "Linux deb" deb "KDJ_${version}_amd64.deb"
    check_artifact "Linux rpm" rpm "KDJ-${version}-1.x86_64.rpm"
    check_signature "Linux rpm" rpm "KDJ-${version}-1.x86_64.rpm"
    check_artifact "Linux AppImage" appimage "KDJ_${version}_amd64.AppImage"
    check_signature "Linux AppImage" appimage "KDJ_${version}_amd64.AppImage"
    ;;
  *)
    echo "unsupported desktop matrix label: $label" >&2
    exit 2
    ;;
esac

echo
if [ "$failures" -gt 0 ]; then
  echo "**Result: FAIL — $failures missing or duplicated artifact(s).**"
  exit 1
fi
echo "**Result: PASS.**"
