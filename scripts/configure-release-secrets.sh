#!/usr/bin/env bash
# 把本机已有的 updater / Android / macOS / Windows 签名材料安全写进 GitHub Secrets。
# 私钥和口令全部走 stdin，不打印、不放命令行参数，也不会写入仓库。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${KDJ_GITHUB_REPO:-kumoSleeping/KDJ}"
TAURI_KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/kdj.key}"
TAURI_PUB="${TAURI_SIGNING_PUBLIC_KEY_PATH:-$HOME/.tauri/kdj.key.pub}"
TAURI_PASS="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE:-$HOME/.tauri/kdj.key.pass}"
ANDROID_KEYSTORE="${ANDROID_KEYSTORE_PATH:-$HOME/.android/kdj-release.jks}"
ANDROID_PASS="${ANDROID_KEYSTORE_PASSWORD_FILE:-$HOME/.android/kdj-release.pass}"
ANDROID_ALIAS="${ANDROID_KEY_ALIAS:-kdj}"
APPLE_CERTIFICATE_PATH="${APPLE_CERTIFICATE_PATH:-}"
APPLE_CERTIFICATE_PASSWORD_FILE="${APPLE_CERTIFICATE_PASSWORD_FILE:-}"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
APPLE_ID="${APPLE_ID:-}"
APPLE_PASSWORD_FILE="${APPLE_PASSWORD_FILE:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
WINDOWS_CERTIFICATE_PATH="${WINDOWS_CERTIFICATE_PATH:-}"
WINDOWS_CERTIFICATE_PASSWORD_FILE="${WINDOWS_CERTIFICATE_PASSWORD_FILE:-}"

for command in gh python3 base64 keytool; do
  command -v "$command" >/dev/null || { echo "缺少命令：$command" >&2; exit 1; }
done
for name in \
  APPLE_CERTIFICATE_PATH APPLE_CERTIFICATE_PASSWORD_FILE APPLE_SIGNING_IDENTITY \
  APPLE_ID APPLE_PASSWORD_FILE APPLE_TEAM_ID \
  WINDOWS_CERTIFICATE_PATH WINDOWS_CERTIFICATE_PASSWORD_FILE; do
  [ -n "${!name:-}" ] || { echo "缺少环境变量：$name" >&2; exit 1; }
done
for file in \
  "$TAURI_KEY" "$TAURI_PUB" "$TAURI_PASS" \
  "$ANDROID_KEYSTORE" "$ANDROID_PASS" \
  "$APPLE_CERTIFICATE_PATH" "$APPLE_CERTIFICATE_PASSWORD_FILE" "$APPLE_PASSWORD_FILE" \
  "$WINDOWS_CERTIFICATE_PATH" "$WINDOWS_CERTIFICATE_PASSWORD_FILE"; do
  [ -s "$file" ] || { echo "缺少签名材料：$file" >&2; exit 1; }
done
gh auth status >/dev/null

# 公钥是公开信息：这里只比较，不读取/输出私钥。避免把 A 私钥传进 CI、客户端却
# 内嵌 B 公钥，等发版以后才发现所有更新都验签失败。
python3 - "$ROOT/src-tauri/tauri.conf.json" "$TAURI_PUB" <<'PY'
import json, pathlib, sys
embedded = json.load(open(sys.argv[1]))["plugins"]["updater"]["pubkey"].strip()
local = pathlib.Path(sys.argv[2]).read_text().strip()
if embedded != local:
    raise SystemExit("tauri.conf.json 的 updater 公钥与本机 kdj.key.pub 不匹配")
print("✓ Tauri updater 公私钥对应")
PY

password=$(cat "$ANDROID_PASS")
keytool -list -keystore "$ANDROID_KEYSTORE" -storepass "$password" -alias "$ANDROID_ALIAS" \
  >/dev/null
unset password
echo "✓ Android keystore 与 alias 可用"

if [ "${KDJ_KEYS_BACKED_UP:-}" != "1" ]; then
  cat <<EOF

即将把签名材料写入 GitHub 仓库 ${REPO}。
继续前请确认下面签名材料已经做过加密离线备份：
  $TAURI_KEY
  $TAURI_PASS
  $ANDROID_KEYSTORE
  $ANDROID_PASS
  $APPLE_CERTIFICATE_PATH
  $APPLE_CERTIFICATE_PASSWORD_FILE
  $APPLE_PASSWORD_FILE
  $WINDOWS_CERTIFICATE_PATH
  $WINDOWS_CERTIFICATE_PASSWORD_FILE

输入 BACKED-UP 继续；其它输入会安全退出：
EOF
  read -r answer
  [ "$answer" = "BACKED-UP" ] || { echo "已取消，没有修改 GitHub Secrets"; exit 1; }
fi

chmod 600 \
  "$TAURI_KEY" "$TAURI_PASS" "$ANDROID_PASS" \
  "$APPLE_CERTIFICATE_PASSWORD_FILE" "$APPLE_PASSWORD_FILE" \
  "$WINDOWS_CERTIFICATE_PASSWORD_FILE"
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" < "$TAURI_KEY"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$REPO" < "$TAURI_PASS"
base64 < "$ANDROID_KEYSTORE" | tr -d '\n' | \
  gh secret set ANDROID_KEYSTORE_BASE64 --repo "$REPO"
gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO" < "$ANDROID_PASS"
printf '%s' "$ANDROID_ALIAS" | gh secret set ANDROID_KEY_ALIAS --repo "$REPO"
base64 < "$APPLE_CERTIFICATE_PATH" | tr -d '\n' | \
  gh secret set APPLE_CERTIFICATE --repo "$REPO"
gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$REPO" < "$APPLE_CERTIFICATE_PASSWORD_FILE"
printf '%s' "$APPLE_SIGNING_IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY --repo "$REPO"
printf '%s' "$APPLE_ID" | gh secret set APPLE_ID --repo "$REPO"
gh secret set APPLE_PASSWORD --repo "$REPO" < "$APPLE_PASSWORD_FILE"
printf '%s' "$APPLE_TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$REPO"
base64 < "$WINDOWS_CERTIFICATE_PATH" | tr -d '\n' | \
  gh secret set WINDOWS_CERTIFICATE --repo "$REPO"
gh secret set WINDOWS_CERTIFICATE_PASSWORD --repo "$REPO" < "$WINDOWS_CERTIFICATE_PASSWORD_FILE"

echo
echo "✓ GitHub Actions Secrets 已写入（只显示名称和更新时间，不显示值）："
gh secret list --repo "$REPO"
