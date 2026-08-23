#!/bin/zsh
set -euo pipefail

# Reproduce the isolated GPU Audio / RT3S research environment without installing its proprietary
# engine into /Library and without linking CC BY-NC-SA code into KDJ.

repo_root=${0:A:h:h}
reference_root=${KDJ_REFERENCE_ROOT:-$HOME/Frameworks}
work_root=${KDJ_RT3S_WORK_ROOT:-/tmp/kdj-rt3s-reference}
artifact_root="$work_root/artifacts"
source_copy="$work_root/gpuaudio-sdk-src"
build_root="$work_root/gpuaudio-sdk-build"
platform_expanded="$work_root/platform-expanded"
engine_expanded="$work_root/engine-expanded"

mkdir -p "$reference_root" "$artifact_root"

clone_pin() {
  local url=$1
  local destination=$2
  local commit=$3
  if [[ -d "$destination/.git" ]]; then
    if [[ -n $(git -C "$destination" status --short) ]]; then
      print -u2 "Refusing dirty reference checkout: $destination"
      return 1
    fi
    if [[ $(git -C "$destination" rev-parse HEAD) != "$commit" ]]; then
      print -u2 "Reference checkout exists at a different commit: $destination"
      print -u2 "Expected $commit; found $(git -C "$destination" rev-parse HEAD)"
      return 1
    fi
  else
    git clone "$url" "$destination"
    git -C "$destination" checkout --detach "$commit"
  fi
}

verify() {
  local file_path=$1
  local bytes=$2
  local sha=$3
  [[ -f "$file_path" ]] || { print -u2 "Missing artifact: $file_path"; return 1; }
  [[ $(stat -f %z "$file_path") == "$bytes" ]] || {
    print -u2 "Size mismatch for $file_path"; return 1
  }
  [[ $(shasum -a 256 "$file_path" | awk '{print $1}') == "$sha" ]] || {
    print -u2 "SHA-256 mismatch for $file_path"; return 1
  }
}

download_verified() {
  local url=$1
  local file_path=$2
  local bytes=$3
  local sha=$4
  if ! verify "$file_path" "$bytes" "$sha" 2>/dev/null; then
    rm -f "$file_path"
    curl -fL --retry 3 -o "$file_path" "$url"
  fi
  verify "$file_path" "$bytes" "$sha"
}

stemgen="$reference_root/stemgen-rt"
sdk="$reference_root/gpuaudio-sdk"
processor="$reference_root/rt3s_processor"
rt3slib="$reference_root/RT3SLib"
lucidrains="$reference_root/HS-TasNet-lucidrains"

clone_pin https://github.com/sweetspotsoundsystem/stemgen-rt.git "$stemgen" \
  eaaba4fe8ed77a312ddaee34948bea34e0cbc30b
clone_pin https://github.com/gpuaudio/gpuaudio-sdk.git "$sdk" \
  4cde62009594e0f4f1db712d27be4fea8b0d06c8
clone_pin https://github.com/gpuaudio/rt3s_processor.git "$processor" \
  f0631f5f7d1460d5ba9b9d4f456722315fa0c1d2
clone_pin https://github.com/gpuaudio/RT3SLib.git "$rt3slib" \
  2de98f8129073927f7a7dc4fb2629535ebf70c79
clone_pin https://github.com/lucidrains/HS-TasNet.git "$lucidrains" \
  5bd950260d26efb2797c7c2d8b101c77f69abda7

git -C "$sdk" submodule update --init --recursive

download_verified \
  https://media.githubusercontent.com/media/sweetspotsoundsystem/stemgen-rt/eaaba4fe8ed77a312ddaee34948bea34e0cbc30b/model/model.onnx \
  "$artifact_root/stemgen-model.onnx" 497166 \
  3e6432f8704c44ed61f9709296acea07112913a62cc7465b1ea44071197f58b1
download_verified \
  https://media.githubusercontent.com/media/sweetspotsoundsystem/stemgen-rt/eaaba4fe8ed77a312ddaee34948bea34e0cbc30b/model/model.onnx.data \
  "$artifact_root/stemgen-model.onnx.data" 210763776 \
  355f036eb618a03b878e01e5da1b4b0e5463c725c4cb2ed18f94888003c7d722
download_verified \
  https://github.com/gpuaudio/platform_headers/releases/download/v0.0.1/RT3S_model.zip \
  "$artifact_root/RT3S_model.zip" 185693806 \
  3e9bf313557081abcc5fd54f448f21702964253277cd6cce56bd53b88406a935

rm -rf "$artifact_root/rt3s-model"
mkdir -p "$artifact_root/rt3s-model"
ditto -x -k "$artifact_root/RT3S_model.zip" "$artifact_root/rt3s-model"
verify "$artifact_root/rt3s-model/params.bw" 200653256 \
  0bbc9b0e335e38e11585e340192421f5fb9e44e49edd0fb3c482377aa4e3bad9

download_verified https://www.gpu.audio/download/26 \
  "$artifact_root/gpu_audio_metapackage_RelWithDebInfo.pkg" 2271038 \
  56c279cfc9b16ee4129b63413475a302721aa66843db51f25e166263b3800d08
pkgutil --check-signature "$artifact_root/gpu_audio_metapackage_RelWithDebInfo.pkg" >/dev/null

rm -rf "$platform_expanded" "$engine_expanded"
pkgutil --expand-full "$artifact_root/gpu_audio_metapackage_RelWithDebInfo.pkg" "$platform_expanded"
os_major=$(sw_vers -productVersion | cut -d. -f1)
engine_pkg="$platform_expanded/Payload/tmp/$os_major/gpu_audio_engine_2.3.0.219_RelWithDebInfo.pkg"
[[ -f "$engine_pkg" ]] || {
  print -u2 "GPU Audio Platform 2.3.0.219 has no package for macOS $os_major"
  exit 1
}
pkgutil --check-signature "$engine_pkg" >/dev/null
pkgutil --expand-full "$engine_pkg" "$engine_expanded"
engine_path="$engine_expanded/Payload/Library/Application Support/GPU Audio/LTS/v2/engine"
[[ -f "$engine_path/libgpu_audio.dylib" ]]

command -v cmake >/dev/null || {
  print -u2 "cmake 3.26.3+ is required (brew install cmake)"
  exit 1
}
xcode_major=$(xcodebuild -version | awk 'NR == 1 {split($2, value, "."); print value[1]}')
if [[ "$os_major" == 26 && "$xcode_major" != 26 ]]; then
  print -u2 "WARNING: official macOS 26 validation requires Xcode 26; found Xcode $xcode_major."
  print -u2 "The build can run, but its timing is not an official supported-toolchain result."
fi

# Configure a disposable source copy because the upstream CMake files download generated headers
# into the source tree. The five locked reference checkouts remain clean evidence.
rm -rf "$source_copy" "$build_root"
mkdir -p "$source_copy"
rsync -a --exclude=.git --exclude='*/.git' "$sdk/" "$source_copy/"
cmake -S "$source_copy" -B "$build_root" -G Xcode \
  -DFETCHCONTENT_SOURCE_DIR_RT3S_MODEL="$artifact_root/rt3s-model"
cmake --build "$build_root" --config RelWithDebInfo --parallel

clang++ -std=c++20 -O3 -Wall -Wextra -Werror "$repo_root/scripts/rt3s-dj-bench.cpp" \
  -I"$source_copy/SoundSourceSeparation/RT3SLib/include" \
  -I"$source_copy/SoundSourceSeparation/RT3SLib/rt3slib/include" \
  "$build_root/SoundSourceSeparation/RT3SLib/rt3slib/RelWithDebInfo/librt3slib.a" \
  -o "$work_root/rt3s-dj-bench"

clang++ -std=c++20 -O3 -Wall -Wextra -Werror -Wno-mismatched-tags \
  -Wno-unused-parameter "$repo_root/scripts/rt3s-dual-graph-bench.cpp" \
  -I"$source_copy/gpuaudio/include" \
  -I"$source_copy/SoundSourceSeparation/RT3SLib/rt3slib/include" \
  -I"$build_root/_deps/json-src/include" \
  -o "$work_root/rt3s-dual-graph-bench"

clang++ -std=c++20 -O3 -Wall -Wextra -Werror \
  "$repo_root/scripts/rt3s-mixed-fp16-params.cpp" \
  -o "$work_root/rt3s-mixed-fp16-params"

cat > "$work_root/run-env.sh" <<EOF
export GPUAUDIO_PATH='$engine_path'
export GPUAUDIO_PROCESSOR_PATH='$build_root/bin/RelWithDebInfo'
export KDJ_RT3S_PARAMS='$artifact_root/rt3s-model/params.bw'
export KDJ_RT3S_BENCH='$work_root/rt3s-dj-bench'
export KDJ_RT3S_DUAL_GRAPH_BENCH='$work_root/rt3s-dual-graph-bench'
export KDJ_RT3S_FP16_CONVERTER='$work_root/rt3s-mixed-fp16-params'
EOF

print "RT3S research environment ready."
print "Run: source '$work_root/run-env.sh'"
print "Then: \$KDJ_RT3S_BENCH bench \$KDJ_RT3S_PARAMS 1 1000 sync parallel"
