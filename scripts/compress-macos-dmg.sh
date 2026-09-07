#!/usr/bin/env bash
# Losslessly recompress the installer container, not the app or signed updater archive.
# UDBZ is supported by every macOS version KDJ supports. Tauri's default UDZO is
# larger for our Rust executable; keep the original if conversion does not save bytes.
# Run before signing/notarizing the DMG itself. App signatures inside are unchanged.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -f "$1" ] || [[ "$1" != *.dmg ]]; then
  echo "usage: $0 <existing unsigned installer.dmg>" >&2
  exit 2
fi
dmg="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
if codesign --display "$dmg" >/dev/null 2>&1; then
  echo "::error::Refusing to recompress a signed DMG; compress before signing/notarizing: $dmg" >&2
  exit 1
fi

# Staging next to the original keeps replacement atomic, including on external volumes.
work=$(mktemp -d "${dmg}.repack.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
hdiutil convert "$dmg" -format UDBZ -o "$work/installer.dmg" >/dev/null
hdiutil verify "$work/installer.dmg" >/dev/null
before=$(wc -c < "$dmg" | tr -d ' ')
after=$(wc -c < "$work/installer.dmg" | tr -d ' ')
if (( after < before )); then
  mv -f "$work/installer.dmg" "$dmg"
  echo "DMG $(basename "$dmg"): $before -> $after bytes (UDBZ, verified)"
else
  echo "DMG $(basename "$dmg"): keeping $before bytes (UDBZ would be $after)"
fi
