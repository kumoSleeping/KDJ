#!/usr/bin/env bash
# 把本机已有的 updater / Android 签名材料安全写进 GitHub Actions Secrets。
# 私钥和口令全部走 stdin，不打印、不放命令行参数，也不会写入仓库。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${KDJ_GITHUB_REPO:-kumoSleeping/KDJ}"
TAURI_KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/kumodeck.key}"
TAURI_PUB="${TAURI_SIGNING_PUBLIC_KEY_PATH:-$HOME/.tauri/kumodeck.key.pub}"
ANDROID_KEYSTORE="${ANDROID_KEYSTORE_PATH:-$HOME/.android/kumodeck-release.jks}"
ANDROID_PASS="${ANDROID_KEYSTORE_PASSWORD_FILE:-$HOME/.android/kumodeck-release.pass}"
ANDROID_ALIAS="${ANDROID_KEY_ALIAS:-kumodeck}"

for command in gh python3 base64 keytool; do
  command -v "$command" >/dev/null || { echo "缺少命令：$command" >&2; exit 1; }
done
for file in "$TAURI_KEY" "$TAURI_PUB" "$ANDROID_KEYSTORE" "$ANDROID_PASS"; do
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
    raise SystemExit("tauri.conf.json 的 updater 公钥与本机 kumodeck.key.pub 不匹配")
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
继续前请确认下面三个文件已经做过加密离线备份：
  $TAURI_KEY
  $ANDROID_KEYSTORE
  $ANDROID_PASS

输入 BACKED-UP 继续；其它输入会安全退出：
EOF
  read -r answer
  [ "$answer" = "BACKED-UP" ] || { echo "已取消，没有修改 GitHub Secrets"; exit 1; }
fi

chmod 600 "$TAURI_KEY" "$ANDROID_PASS"
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" < "$TAURI_KEY"
base64 < "$ANDROID_KEYSTORE" | tr -d '\n' | \
  gh secret set ANDROID_KEYSTORE_BASE64 --repo "$REPO"
gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO" < "$ANDROID_PASS"
printf '%s' "$ANDROID_ALIAS" | gh secret set ANDROID_KEY_ALIAS --repo "$REPO"

echo
echo "✓ GitHub Actions Secrets 已写入（只显示名称和更新时间，不显示值）："
gh secret list --repo "$REPO"
