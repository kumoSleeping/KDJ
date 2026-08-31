#!/usr/bin/env bash
#
# `tauri android init` 之后必须重做的所有事，一个脚本管完。
#
# 为什么需要这个脚本：`src-tauri/gen/android/` 是生成物，按 Tauri 官方建议
# **不进版本库**，于是每次 init 都会把手改冲掉。凡是"改了 gen/android 才生效"
# 的东西，都只能做成 init 之后的补丁步骤，且本地和 CI 必须跑同一份——
# 两边各写一套的下场是"我这儿能装，CI 出来的装不上"。
#
# 做六件事：
#   1. 清退并拒绝旧 ExecuTorch / NativeLoader / fbjni 生成物
#   2. release 同时开启 R8 与资源裁剪，但保持现代 Android 的未压缩 native library 布局
#   3. 只对 localhost / 127.0.0.1 放行明文（其余目标继续强制 TLS）
#   4. AndroidManifest 注入曲库媒体读取权限（gen/android 不进版本库，
#      清单手改会被 init 冲掉；缺了它们运行时申请会被系统静默拒绝，
#      曲库在共享存储里永远扫到 0 首）
#   5. 注入签名配置（不签名的 APK 在 Android 7+ 上根本装不了）
#   6. 把仓库里的真图标盖过模板默认图标
#
# 签名的钥匙从环境变量来，脚本本身不含任何密码：
#   ANDROID_KEYSTORE_BASE64   keystore 文件的 base64（CI 用；本地可省）
#   ANDROID_KEYSTORE_PATH     keystore 路径（本地用，默认 ~/.android/kdj-release.jks）
#   ANDROID_KEYSTORE_PASSWORD 口令
#   ANDROID_KEY_ALIAS         别名（默认 kdj）
# 一个都没有时**跳过 release 签名**继续跑——本地只想验证能不能编时不该被卡住；
# Gradle 的 `--debug` APK 仍由 Android debug key 自动签名，release 则不可安装。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$ROOT/src-tauri/gen/android"
GRADLE="$GEN/app/build.gradle.kts"

[ -f "$GRADLE" ] || { echo "::error::$GRADLE 不存在，先跑 tauri android init"; exit 1; }

# --------------------------------------------------------- 1. 清退旧模型 runtime
# gen/android 可能是旧版本留下的增量目录。仅仅停止“注入”不够：历史脚本已经写入的
# AAR、Gradle dependency、JNI bridge 和 R8 keep rule 会继续进包。这里精确删除 KDJ
# 曾经生成的文件与行，避免误碰 Tauri/Android 自身依赖。
APP_DIR="$GEN/app"
if [ -d "$APP_DIR/libs" ]; then
  find "$APP_DIR/libs" -maxdepth 1 -type f \
    \( -name 'executorch-vulkan-*.aar' -o -name 'executorch-vulkan-*.aar.partial' \) \
    -delete
fi
rm -f \
  "$APP_DIR/src/main/java/com/kdj/app/StemRuntime.kt" \
  "$APP_DIR/proguard/kdj-executorch.pro"

# --------------------------------------------------------- 2. release 体积策略
# Gradle 依赖行的旧 runtime 清理与 release resource shrink 必须同样能跨 `android init`
# 重放。native library 继续采用现代未压缩布局，绝不注入 useLegacyPackaging。
python3 - "$GRADLE" <<'PY'
import re
import sys

path = sys.argv[1]
lines = open(path).read().splitlines(keepends=True)
stale = (
    "KDJ_EXECUTORCH_VULKAN",
    'ndk { abiFilters += "arm64-v8a" }',
    'implementation(files("libs/executorch-vulkan-',
    'implementation("com.facebook.soloader:nativeloader:',
    'implementation("com.facebook.fbjni:fbjni:',
)
clean = [line for line in lines if not any(marker in line for marker in stale)]

# Tauri regenerates this file, so locate the release block structurally instead of relying on one
# exact template string. Resource shrinking requires R8; fail closed if a future template disables
# minification rather than silently producing a larger APK.
release_starts = [
    index
    for index, line in enumerate(clean)
    if re.match(r'^\s*getByName\("release"\)\s*\{\s*$', line)
]
if len(release_starts) != 1:
    print("::error::Gradle 模板里找不到唯一的 release build type")
    raise SystemExit(1)
release_start = release_starts[0]

depth = 0
release_end = None
for index in range(release_start, len(clean)):
    depth += clean[index].count("{") - clean[index].count("}")
    if index > release_start and depth == 0:
        release_end = index
        break
if release_end is None:
    print("::error::Gradle release build type 的大括号不完整")
    raise SystemExit(1)

release = clean[release_start : release_end + 1]
minify = [index for index, line in enumerate(release) if "isMinifyEnabled" in line]
if len(minify) != 1 or not re.search(r'isMinifyEnabled\s*=\s*true\b', release[minify[0]]):
    print("::error::release 必须且只能有一条 isMinifyEnabled = true")
    raise SystemExit(1)

shrink = [index for index, line in enumerate(release) if "isShrinkResources" in line]
if len(shrink) > 1:
    print("::error::release 出现重复 isShrinkResources 配置")
    raise SystemExit(1)
if shrink:
    release[shrink[0]] = re.sub(
        r'isShrinkResources\s*=\s*(?:true|false)',
        'isShrinkResources = true',
        release[shrink[0]],
    )
    if not re.search(r'isShrinkResources\s*=\s*true\b', release[shrink[0]]):
        print("::error::无法把 release isShrinkResources 规范成 true")
        raise SystemExit(1)
else:
    indent = re.match(r'^(\s*)', release[minify[0]]).group(1)
    release.insert(minify[0] + 1, f"{indent}isShrinkResources = true\n")

clean[release_start : release_end + 1] = release
open(path, "w").writelines(clean)
PY

stale_found=0
while IFS= read -r -d '' gradle_file; do
  if grep -Eiq 'executorch|com\.facebook\.soloader:nativeloader|com\.facebook\.fbjni:fbjni|(^|[^[:alnum:]_])(nativeloader|fbjni)([^[:alnum:]_]|$)' "$gradle_file"; then
    echo "::error::Gradle 仍残留已停用的模型 runtime：$gradle_file"
    grep -Ein 'executorch|nativeloader|fbjni' "$gradle_file" || true
    stale_found=1
  fi
  if grep -Eq 'useLegacyPackaging[[:space:]]*=' "$gradle_file"; then
    echo "::error::不得启用 legacy native packaging：$gradle_file"
    stale_found=1
  fi
done < <(
  find "$GEN" "$ROOT/plugins/native-audio/android" \
    \( -type d \( -name build -o -name .gradle \) -prune \) -o \
    \( -type f \( -name '*.gradle' -o -name '*.gradle.kts' \) -print0 \)
)

while IFS= read -r -d '' stale_artifact; do
  echo "::error::仍残留已停用的模型 artifact：$stale_artifact"
  stale_found=1
done < <(
  find "$APP_DIR" -type f \
    \( -iname '*executorch*' -o -iname '*fbjni*' -o -iname '*nativeloader*' \
       -o -name 'StemRuntime.kt' \) -print0
)

if (( stale_found != 0 )); then
  exit 1
fi
grep -Eq 'isShrinkResources[[:space:]]*=[[:space:]]*true' "$GRADLE" \
  || { echo "::error::release 资源裁剪未启用"; exit 1; }
echo "✓ 已清退旧 ExecuTorch / NativeLoader / fbjni 生成物"
echo "✓ release 已启用 R8 + resource shrink，native library 保持未压缩布局"

# ---------------------------------------------------------------- 3. 回环明文
# 这个 app 的前端在 WebView 里对 127.0.0.1 上的进程内 axum 发明文请求
#（token 鉴权，见 auth.rs）。Android 对 targetSdk 28+ 默认禁明文，
# 不开的话 release 包装上真机就是白屏。不能把 usesCleartextTraffic 全局翻成 true：
# 这会让未来新增或被重定向到任意 HTTP 远端的请求也静默降级。Android 7+ 会以
# network-security-config 为准，因此保持全局 false，仅列出两个回环名称。
MANIFEST="$GEN/app/src/main/AndroidManifest.xml"
[ -f "$MANIFEST" ] || { echo "::error::$MANIFEST 不存在，先跑 tauri android init"; exit 1; }
NETWORK_SECURITY_DIR="$GEN/app/src/main/res/xml"
NETWORK_SECURITY_CONFIG="$NETWORK_SECURITY_DIR/kdj_network_security_config.xml"
mkdir -p "$NETWORK_SECURITY_DIR"

python3 - "$GRADLE" "$MANIFEST" <<'PY'
import re
import sys

gradle_path, manifest_path = sys.argv[1:]
gradle = open(gradle_path).read()
gradle = re.sub(
    r'(manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*)"true"',
    r'\1"false"',
    gradle,
)
open(gradle_path, "w").write(gradle)

manifest = open(manifest_path).read()
attribute = 'android:networkSecurityConfig="@xml/kdj_network_security_config"'
if attribute not in manifest:
    manifest, count = re.subn(
        r'(<application\b)',
        r'\1\n        ' + attribute,
        manifest,
        count=1,
    )
    if count != 1:
        print("::error::清单里找不到唯一的 <application> 标签，模板形状变了")
        raise SystemExit(1)
    open(manifest_path, "w").write(manifest)
PY

cat > "$NETWORK_SECURITY_CONFIG" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
EOF

if grep -Eq 'usesCleartextTraffic"\][[:space:]]*=[[:space:]]*"true"' "$GRADLE"; then
  echo "::error::Gradle 仍在全局放行明文；模板形状变了，去对一下"
  exit 1
fi
grep -q 'android:networkSecurityConfig="@xml/kdj_network_security_config"' "$MANIFEST" \
  || { echo "::error::networkSecurityConfig 未注入清单"; exit 1; }
grep -q '<base-config cleartextTrafficPermitted="false"' "$NETWORK_SECURITY_CONFIG" \
  || { echo "::error::network security base-config 必须拒绝明文"; exit 1; }
echo "✓ 明文仅放行回环（localhost / 127.0.0.1）"

# ---------------------------------------------------------------- 4. 清单权限
# 曲库扫描走 std::fs 裸路径，Android 13+ 要 READ_MEDIA_AUDIO/VIDEO
#（视频容器也是曲库媒体），≤12 要 READ_EXTERNAL_STORAGE。
# 这三条必须进 AndroidManifest 运行时申请才有意义：没声明的权限，
# requestPermissions 不弹窗、直接返回拒绝，系统设置里也不出现——
# 用户看到的是「授权了文件夹却什么都扫不到」。
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

# ---------------------------------------------------------------- 5. 签名
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
  echo "⚠ 没有 keystore 或口令：release APK 会是 unsigned（--debug APK 仍自动签名）"
fi

# ---------------------------------------------------------------- 6. 图标
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
