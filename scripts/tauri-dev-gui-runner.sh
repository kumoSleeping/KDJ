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
<key>NSDownloadsFolderUsageDescription</key><string>KDJ 需要读取你选择的下载目录中的音乐和视频，以便播放和剪辑。</string>
<key>NSMicrophoneUsageDescription</key><string>KDJ 实时 VJ 需要读取你选择的麦克风或声卡输入，以便匹配素材并同步画面；不会保存录音。</string>
<key>NSBluetoothAlwaysUsageDescription</key><string>KDJ 使用蓝牙在配对电脑之间传输音频识别特征，以同步实时 VJ；不传输录音。</string>
<key>NSBluetoothPeripheralUsageDescription</key><string>KDJ 使用蓝牙连接配对电脑并传输音频识别特征。</string>
<key>NSAudioCaptureUsageDescription</key><string>KDJ 实时 VJ 需要捕获系统音频以匹配素材并同步画面；不会保存录音。</string>
</dict></plist>
PLIST
if [[ "${VITE_KDJ_YOUTUBE_E2E:-}" == "1" ]]; then
  # Acceptance video must remain visibly composited for WKWebView, but the diagnostic app must
  # never become the user's foreground application or add a second KDJ icon to the Dock.
  /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$bundle/Contents/Info.plist"
fi
exec "$bundle/Contents/MacOS/kdj-app" "$@"
