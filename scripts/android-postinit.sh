#!/usr/bin/env bash
#
# `tauri android init` 之后必须重做的所有事，一个脚本管完。
#
# 为什么需要这个脚本：`src-tauri/gen/android/` 是生成物，按 Tauri 官方建议
# **不进版本库**，于是每次 init 都会把手改冲掉。凡是"改了 gen/android 才生效"
# 的东西，都只能做成 init 之后的补丁步骤，且本地和 CI 必须跑同一份——
# 两边各写一套的下场是"我这儿能装，CI 出来的装不上"。
#
# 做四件事：
#   1. release 放行 localhost 明文（不然装到真机是白屏）
#   2. AndroidManifest 注入曲库媒体读取权限（gen/android 不进版本库，
#      清单手改会被 init 冲掉；缺了它们运行时申请会被系统静默拒绝，
#      曲库在共享存储里永远扫到 0 首）
#   3. 注入签名配置（不签名的 APK 在 Android 7+ 上根本装不了）
#   4. 把仓库里的真图标盖过模板默认图标
#
# 签名的钥匙从环境变量来，脚本本身不含任何密码：
#   ANDROID_KEYSTORE_BASE64   keystore 文件的 base64（CI 用；本地可省）
#   ANDROID_KEYSTORE_PATH     keystore 路径（本地用，默认 ~/.android/kdj-release.jks）
#   ANDROID_KEYSTORE_PASSWORD 口令
#   ANDROID_KEY_ALIAS         别名（默认 kdj）
# 一个都没有时**跳过签名**继续跑，出未签名包——本地只想验证能不能编时不该被卡住。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$ROOT/src-tauri/gen/android"
GRADLE="$GEN/app/build.gradle.kts"

[ -f "$GRADLE" ] || { echo "::error::$GRADLE 不存在，先跑 tauri android init"; exit 1; }

# ---------------------------------------------------------------- 1. 明文
# 这个 app 的前端在 WebView 里对 127.0.0.1 上的进程内 axum 发明文请求
#（token 鉴权，见 auth.rs）。Android 对 targetSdk 28+ 默认禁明文，
# 不开的话 release 包装上真机就是白屏，而 debug 包复现不出来（模板里 debug 本来就是 true）。
# 四家平台的 API 全走 https，实际放行的只有本机回环这一条。
python3 - "$GRADLE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('manifestPlaceholders["usesCleartextTraffic"] = "false"',
              'manifestPlaceholders["usesCleartextTraffic"] = "true"')
open(p, "w").write(s)
PY
if grep -q 'usesCleartextTraffic"\] = "false"' "$GRADLE"; then
  echo "::error::usesCleartextTraffic 还留着 false —— 模板形状变了，去对一下"
  exit 1
fi
echo "✓ 明文放行"

# ---------------------------------------------------------------- 2. 清单权限
# 曲库扫描走 std::fs 裸路径，Android 13+ 要 READ_MEDIA_AUDIO/VIDEO
#（视频容器也是曲库媒体），≤12 要 READ_EXTERNAL_STORAGE。
# 这三条必须进 AndroidManifest 运行时申请才有意义：没声明的权限，
# requestPermissions 不弹窗、直接返回拒绝，系统设置里也不出现——
# 用户看到的是「授权了文件夹却什么都扫不到」。
MANIFEST="$GEN/app/src/main/AndroidManifest.xml"
[ -f "$MANIFEST" ] || { echo "::error::$MANIFEST 不存在，先跑 tauri android init"; exit 1; }
python3 - "$MANIFEST" <<'PY'
import re
import sys

p = sys.argv[1]
s = open(p).read()

SNIPPETS = {
    "android.permission.READ_MEDIA_AUDIO":
        '    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
    "android.permission.READ_MEDIA_VIDEO":
        '    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
    # 13+ 起由细粒度媒体权限接替，旧权限只声明到 32
    "android.permission.READ_EXTERNAL_STORAGE":
        '    <uses-permission\n'
        '        android:name="android.permission.READ_EXTERNAL_STORAGE"\n'
        '        android:maxSdkVersion="32" />',
}

missing = [snippet for name, snippet in SNIPPETS.items() if name not in s]
if missing:
    anchor = re.search(r"<manifest[^>]*>", s)
    if anchor is None:
        print("::error::清单里找不到 <manifest> 标签，模板形状变了，去对一下")
        sys.exit(1)
    block = (
        "\n    <!-- 曲库媒体读取权限（android-postinit.sh 注入；直接手改会被 init 冲掉） -->\n"
        + "\n".join(missing)
    )
    s = s[: anchor.end()] + block + s[anchor.end() :]
    open(p, "w").write(s)

for name in SNIPPETS:
    if name not in s:
        print(f"::error::{name} 注入失败")
        sys.exit(1)
print("  权限已就位" if not missing else f"  已注入 {len(missing)} 条权限")
PY
echo "✓ 清单权限（READ_MEDIA_AUDIO / READ_MEDIA_VIDEO / READ_EXTERNAL_STORAGE≤32）"

# ---------------------------------------------------------------- 3. 签名
KEYSTORE="${ANDROID_KEYSTORE_PATH:-$HOME/.android/kdj-release.jks}"
if [ -n "${ANDROID_KEYSTORE_BASE64:-}" ]; then
  KEYSTORE="$GEN/app/release.jks"
  # base64 -d 在 GNU/BSD 上参数一致，-D 只有 BSD 认，所以统一用 -d
  echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$KEYSTORE"
fi

if [ -f "$KEYSTORE" ] && [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
  # 口令走 keystore.properties 而不是直接写进 build.gradle.kts：
  # gradle 脚本会被打进构建日志和各种缓存，properties 文件不会。
  cat > "$GEN/app/keystore.properties" <<EOF
storeFile=$(cd "$(dirname "$KEYSTORE")" && pwd)/$(basename "$KEYSTORE")
storePassword=$ANDROID_KEYSTORE_PASSWORD
keyAlias=${ANDROID_KEY_ALIAS:-kdj}
keyPassword=${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}
EOF
  chmod 600 "$GEN/app/keystore.properties"

  python3 - "$GRADLE" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if "signingConfigs" in s:
    print("  （已经注入过，跳过）")
    raise SystemExit(0)

# signingConfigs 必须在 buildTypes **之前**：Kotlin DSL 是顺序求值的，
# buildTypes 里 signingConfigs.getByName("release") 找的是那一刻已经存在的配置，
# 放到后面会报 "SigningConfig with name 'release' not found"。
block = '''    val keystoreProps = Properties().apply {
        val f = file("keystore.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    signingConfigs {
        create("release") {
            if (keystoreProps.getProperty("storeFile") != null) {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {'''
s = s.replace("    buildTypes {", block, 1)

# release 用它签。签名配置为空（没配 keystore）时 AGP 会自己退回出未签名包，
# 所以这行无条件加是安全的。
s = s.replace('''        getByName("release") {
            isMinifyEnabled = true''',
'''        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true''', 1)
open(p, "w").write(s)
print("  已注入 signingConfigs")
PY
  # 变量名一律写全大括号：紧跟中文全角括号时，bash 会把 `）` 的字节
  # 当成变量名的一部分，报 "KEYSTORE）: unbound variable"，看着像变量没设
  echo "✓ 签名配置（keystore：${KEYSTORE}）"
else
  echo "⚠ 没有 keystore 或口令，跳过签名——出来的是 unsigned APK，装不进真机"
fi

# ---------------------------------------------------------------- 4. 图标
# init 出来的工程带的是 Tauri 默认图标；真图标（tauri icon 的产物）在仓库里。
# 顺带把自适应图标的背景层从模板的 #fff 换成应用底色——白底配深色前景，
# 在圆形遮罩里会露一圈白边。
if [ -d "$ROOT/src-tauri/icons/android" ]; then
  cp -R "$ROOT/src-tauri/icons/android/." "$GEN/app/src/main/res/"
  python3 - "$GEN/app/src/main/res/values/ic_launcher_background.xml" <<'PY'
import sys, os
p = sys.argv[1]
if os.path.exists(p):
    s = open(p).read().replace("#fff", "#111113")
    open(p, "w").write(s)
PY
  echo "✓ 图标同步（背景层 $(grep -o '#[0-9a-fA-F]*' "$GEN/app/src/main/res/values/ic_launcher_background.xml" | head -1)）"
fi

echo "android-postinit 完成"
