#!/usr/bin/env bash
set -euo pipefail

root="${1:-target}"
echo "Bundle size report: $root"

find "$root" -type f \
  \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.AppImage' -o -name '*.deb' \
     -o -name '*.rpm' -o -name '*.msi' -o -name '*-setup.exe' \) -print0 2>/dev/null \
  | while IFS= read -r -d '' file; do
      bytes=$(wc -c <"$file" | tr -d ' ')
      printf '%12d  %s\n' "$bytes" "$file"
    done

find "$root" -type d -name '*.app' -print0 2>/dev/null \
  | while IFS= read -r -d '' app; do
      executable=$(find "$app/Contents/MacOS" -maxdepth 1 -type f -perm -111 -print -quit 2>/dev/null || true)
      [ -n "$executable" ] || continue
      bytes=$(wc -c <"$executable" | tr -d ' ')
      printf '%12d  %s\n' "$bytes" "$executable"
    done
