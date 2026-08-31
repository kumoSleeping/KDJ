#!/bin/zsh
set -euo pipefail

executable=$1
shift
bundle="/tmp/KDJ Dev.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
ln -sf "$executable" "$bundle/Contents/MacOS/kdj-app"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>KDJ Dev</string>
<key>CFBundleDisplayName</key><string>KDJ Dev</string>
<key>CFBundleIdentifier</key><string>com.kdj.dev</string>
<key>CFBundleExecutable</key><string>kdj-app</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>10.15</string>
</dict></plist>
PLIST
if [[ "${VITE_KDJ_YOUTUBE_E2E:-}" == "1" ]]; then
  # Acceptance video must remain visibly composited for WKWebView, but the diagnostic app must
  # never become the user's foreground application or add a second KDJ icon to the Dock.
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$bundle/Contents/Info.plist"
fi
exec "$bundle/Contents/MacOS/kdj-app" "$@"
