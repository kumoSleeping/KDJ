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
exec "$bundle/Contents/MacOS/kdj-app" "$@"
