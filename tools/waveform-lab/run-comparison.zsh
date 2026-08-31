#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h:h}
OUTPUT_DIR=${1:-${REPO_ROOT}/artifacts/waveform-comparison-$(date +%Y%m%d-%H%M%S)}
SEED=${2:-$(date +%s)}
SONG_DIR=${KDJ_WAVEFORM_SONG_DIR:-/Users/kumo/Music/test}

mkdir -p "${OUTPUT_DIR}"

CARGO_TARGET_DIR="${REPO_ROOT}/target/waveform-lab" cargo run \
  --manifest-path "${REPO_ROOT}/Cargo.toml" \
  -p kdj-analysis \
  --example waveform_compare \
  -- \
  --random-dir "${SONG_DIR}" \
  --count 2 \
  --seed "${SEED}" \
  --output "${OUTPUT_DIR}/analysis.json"

python3 "${SCRIPT_DIR}/render_comparison.py" \
  "${OUTPUT_DIR}/analysis.json" \
  "${OUTPUT_DIR}"

echo "comparison=${OUTPUT_DIR}/waveform-comparison.png"
