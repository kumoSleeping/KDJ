#!/usr/bin/env bash
# 建立 sidecar 的 Python 环境。优先 uv（快 10x），没有就退回 venv+pip。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/sidecar"

if command -v uv >/dev/null 2>&1; then
  uv venv --python 3.12 .venv
  VIRTUAL_ENV="$ROOT/sidecar/.venv" uv pip install -e ".[dev]"
else
  python3 -m venv .venv
  ./.venv/bin/python -m pip install -U pip
  ./.venv/bin/python -m pip install -e ".[dev]"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "⚠️  没有找到 ffmpeg —— BPM/调性分析与视频合流都依赖它（macOS: brew install ffmpeg）"
fi
echo "✅ sidecar 就绪：$ROOT/sidecar/.venv"
