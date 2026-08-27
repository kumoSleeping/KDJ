#!/usr/bin/env bash
# KDJ 一键发版：bump 五处版本号 → 校验 → 提交推送 → 盯 CI → 验证更新端点。
#
# 用法：
#   scripts/release.sh 0.2.13            # 全量校验后发版
#   SKIP_VALIDATION=1 scripts/release.sh 0.2.13   # 跳过本地 typecheck/build/test（慎用）
#   WATCH=0 scripts/release.sh 0.2.13    # 推完就退出，不等 CI
#
# 设计约束（都是踩过的坑）：
#   - package.json / package-lock.json / Cargo.toml / Cargo.lock / tauri.conf.json
#     五处版本必须一致，release.yml 的 gate 会拒发不一致的推送；
#   - 新版本必须大于远端最新 v* tag（本地 tag 不算数）；
#   - 推送前要求工作区干净，避免把半成品改动混进 release 提交；
#   - 新 Release 以 --latest=false 创建，不会抢占更新通道；latest-json 在至少
#     一个平台产物就绪后写入本版清单并提升 Latest。单平台失败不再用旧清单
#     占位伪装「已是最新」。脚本最后仍必须验证
#     releases/latest/download/latest.json 的 version 真的变成了新版本。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法：scripts/release.sh <x.y.z>" >&2
  exit 2
fi

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==> %s\033[0m\n' "$*"; }

# ---- 前置检查 -------------------------------------------------------------
info "前置检查"
branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == "main" ]] || { red "必须在 main 分支发版（当前：$branch）"; exit 1; }

git fetch origin main --tags --quiet

if [[ -n "$(git status --porcelain)" ]]; then
  red "工作区有未提交改动，先提交或 stash 再发版："
  git status --short
  exit 1
fi

if [[ -z "$(git log origin/main..HEAD --oneline)" ]]; then
  info "本地没有领先 origin/main 的提交，本次只是纯版本号发版"
fi

# 版本必须大于远端最新 tag（语义化比较，不是字符串比较）
latest_tag=$(git ls-remote --tags origin 'v*' \
  | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -1)
info "远端最新 tag：${latest_tag:-（无）}"
if [[ -n "$latest_tag" ]]; then
  newest=$(printf '%s\n%s\n' "$latest_tag" "v$VERSION" | sort -V | tail -1)
  [[ "$newest" == "v$VERSION" && "$latest_tag" != "v$VERSION" ]] \
    || { red "v$VERSION 必须大于远端最新 tag $latest_tag"; exit 1; }
fi

# ---- bump 五处版本号 -------------------------------------------------------
info "bump 版本号到 $VERSION"
npm version "$VERSION" --no-git-tag-version --silent   # package.json + package-lock.json
python3 - "$VERSION" <<'PY'
import json, sys
v = sys.argv[1]
p = "src-tauri/tauri.conf.json"
conf = json.load(open(p))
conf["version"] = v
json.dump(conf, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
PY
# Cargo 侧：workspace 版本 + 所有内部 crate 互相引用的版本约束
sed -i '' "s/^version = \"[0-9.]*\"$/version = \"$VERSION\"/" Cargo.toml
sed -i '' "s/\(kdj-[a-z]* = { version = \"\)[0-9.]*\"/\1$VERSION\"/g" \
  Cargo.toml src-tauri/Cargo.toml crates/*/Cargo.toml
cargo metadata --format-version 1 >/dev/null   # 让 Cargo.lock 跟着走

# 回读校验，别信 sed
tauri=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
npm_v=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
cargo_v=$(sed -n '/^\[workspace.package\]/,/^\[/s/^version = "\([^"]*\)"/\1/p' Cargo.toml)
[[ "$tauri" == "$VERSION" && "$npm_v" == "$VERSION" && "$cargo_v" == "$VERSION" ]] \
  || { red "版本号回读不一致：tauri=$tauri npm=$npm_v cargo=$cargo_v"; exit 1; }

# ---- 本地校验 ---------------------------------------------------------------
if [[ "${SKIP_VALIDATION:-0}" != "1" ]]; then
  info "npm run typecheck"
  npm run typecheck
  info "npm run tauri:web:build"
  npm run tauri:web:build
  info "cargo test --workspace"
  cargo test --workspace
else
  info "SKIP_VALIDATION=1，跳过本地校验"
fi

# ---- 提交推送 ---------------------------------------------------------------
info "提交并推送"
git add package.json package-lock.json Cargo.toml Cargo.lock \
  src-tauri/tauri.conf.json src-tauri/Cargo.toml crates/*/Cargo.toml
git commit -m "release: prepare KDJ $VERSION"
git push origin main

green "已推送。release.yml 检测到新版本后会自动打 tag v$VERSION 并调度构建。"

[[ "${WATCH:-1}" == "1" ]] || exit 0

# ---- 盯 CI：tag 构建必须全绿，否则 latest.json 不会更新 ----------------------
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
info "等待 tag v$VERSION 出现"
for _ in $(seq 1 30); do
  git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1 && break
  sleep 10
done
git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1 \
  || { red "5 分钟内没看到 v$VERSION tag，去 Actions 看 release.yml"; exit 1; }

watch_run() { # $1=workflow 名
  local wf="$1" run_id="" status="" conclusion="" interruptions=0
  for _ in $(seq 1 12); do
    run_id=$(gh run list --workflow="$wf" --limit 5 --json databaseId,headBranch,event \
      --jq ".[] | select(.headBranch==\"v$VERSION\") | .databaseId" 2>/dev/null | head -1)
    [[ -n "$run_id" ]] && break
    sleep 10
  done
  [[ -n "$run_id" ]] || { red "没找到 $wf 在 v$VERSION 上的运行"; return 1; }
  info "$wf 运行中：$(gh run view "$run_id" --json url --jq .url)"
  # `gh run watch` 偶尔会在长达数十分钟的构建中因 GitHub API EOF 退出。构建
  # 本身仍在继续；不要把一次网络断流误报成发行失败，重新查询状态并续看。
  while (( interruptions < 12 )); do
    if gh run watch "$run_id" --exit-status --interval 30 >/dev/null; then
      return 0
    fi
    status=""
    conclusion=""
    for _ in $(seq 1 6); do
      status=$(gh run view "$run_id" --json status --jq .status 2>/dev/null || true)
      conclusion=$(gh run view "$run_id" --json conclusion --jq .conclusion 2>/dev/null || true)
      [[ -n "$status" ]] && break
      sleep 10
    done
    if [[ "$status" == "completed" ]]; then
      [[ "$conclusion" == "success" ]]
      return
    fi
    interruptions=$((interruptions + 1))
    info "$wf 监看连接中断，重新连接（$interruptions/12）"
    sleep 15
  done
  red "$wf 监看连续中断，无法确认最终状态"
  return 1
}

info "盯桌面三平台构建（rust-build）"
build_ok=1
watch_run rust-build || {
  build_ok=0
  red "rust-build 失败或超时。若 latest-json 也没跑成，Latest 不会被提升，更新通道仍指向上一版。"
}

info "盯安卓构建（rust-android）"
watch_run rust-android || red "安卓构建失败，桌面更新不受影响但 APK 缺失"

# ---- 终检：更新端点必须已经是新版本 ------------------------------------------
info "验证更新端点"
served=""
served_labs=""
for i in $(seq 1 10); do
  served=$(curl -sL "https://github.com/$repo/releases/latest/download/latest.json" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null || true)
  served_labs=$(curl -sL "https://github.com/$repo/releases/latest/download/latest-labs.json" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null || true)
  [[ "$served" == "$VERSION" && "$served_labs" == "$VERSION" ]] && break
  [[ "$i" == "10" ]] && {
    red "更新清单未全部就绪：stable=${served:-未知} labs=${served_labs:-未知}"
    [[ "$build_ok" == "1" ]] || red "（rust-build 本身也没有成功）"
    exit 1
  }
  sleep 20
done
if [[ "$build_ok" != "1" ]]; then
  green "✅ KDJ v$VERSION 双更新通道已就绪（stable=${served}, labs=${served_labs}），但 rust-build 有失败步骤，请去 Actions 核对缺了哪些平台。"
else
  green "✅ KDJ v$VERSION 发版完成，stable/labs 更新清单均为该版本。"
fi
