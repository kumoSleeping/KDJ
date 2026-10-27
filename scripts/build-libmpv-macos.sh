#!/usr/bin/env bash
# Builds a playback-only libmpv for macOS (host architecture) into one self-contained dylib.
#
#   scripts/build-libmpv-macos.sh [out-dir]      (default: src-tauri/vendor/libmpv/macos)
#
# Only what KDJ's video window needs is compiled in: FFmpeg decoders, demuxers and the file/http
# protocols (KDJ hands mpv loopback URLs of its own server, so no TLS), VideoToolbox hardware
# decoding, dav1d for AV1, the OpenGL render API and Core Audio. No encoders, muxers, devices,
# scripting, Vulkan, OCR or network TLS. Every dependency is linked statically into
# libmpv.2.dylib, which then needs nothing but system frameworks. mpv's macOS (cocoa) code is
# kept because VideoToolbox frames reach OpenGL only through it, and since mpv 0.38 it needs
# its Swift half (the Swift runtime is part of macOS).
#
# Needs Xcode command line tools, curl, git and python3 (meson/ninja are installed into a venv
# under the work dir). The work dir (default target/libmpv-build) can be removed afterwards.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/src-tauri/vendor/libmpv/macos}
WORK=${LIBMPV_WORK:-$ROOT/target/libmpv-build}
PREFIX=$WORK/prefix
SRC=$WORK/src
JOBS=$(sysctl -n hw.ncpu)

FFMPEG_VERSION=8.0
MPV_VERSION=0.41.0
LIBPLACEBO_VERSION=v7.360.1
DAV1D_VERSION=1.5.1
FREETYPE_VERSION=2.13.3
FRIBIDI_VERSION=1.0.16
HARFBUZZ_VERSION=11.2.1
LIBASS_VERSION=0.17.4

export MACOSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-10.15}
export PKG_CONFIG_LIBDIR=$PREFIX/lib/pkgconfig
export PKG_CONFIG_PATH=
export CFLAGS="-O2 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
export CXXFLAGS=$CFLAGS
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"

mkdir -p "$SRC" "$PREFIX/lib/pkgconfig" "$OUT"
if [ ! -x "$WORK/venv/bin/meson" ]; then
  python3 -m venv "$WORK/venv"
  "$WORK/venv/bin/pip" install -q meson ninja jinja2 markupsafe
fi
export PATH=$WORK/venv/bin:$PATH

# quiet <log name> <command...>: keeps a step's output in the work dir, shows its tail on failure.
quiet() {
  local log=$WORK/$1.log
  shift
  "$@" >"$log" 2>&1 || { tail -60 "$log"; return 1; }
}

# fetch <url> <directory name inside the archive>
fetch() {
  [ -d "$SRC/$2" ] && return
  local archive=$SRC/$(basename "$1")
  curl -fsSL --retry 3 "$1" -o "$archive"
  tar -xf "$archive" -C "$SRC"
  rm -f "$archive"
}

# meson_lib <directory> <meson options...>
meson_lib() {
  local dir=$SRC/$1
  shift
  [ -f "$dir/build/.kdj-installed" ] && return
  rm -rf "$dir/build"
  meson setup "$dir/build" "$dir" --prefix="$PREFIX" --libdir=lib --buildtype=release \
    --default-library=static -Db_ndebug=true "$@"
  quiet "$(basename "$dir")-install" meson install -C "$dir/build"
  touch "$dir/build/.kdj-installed"
}

fetch "https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.bz2" "dav1d-$DAV1D_VERSION"
meson_lib "dav1d-$DAV1D_VERSION" -Denable_tools=false -Denable_tests=false -Denable_examples=false

fetch "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VERSION.tar.xz" "freetype-$FREETYPE_VERSION"
meson_lib "freetype-$FREETYPE_VERSION" -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled \
  -Dpng=disabled -Dzlib=disabled -Dtests=disabled

fetch "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VERSION/fribidi-$FRIBIDI_VERSION.tar.xz" "fribidi-$FRIBIDI_VERSION"
meson_lib "fribidi-$FRIBIDI_VERSION" -Ddocs=false -Dbin=false -Dtests=false

fetch "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VERSION/harfbuzz-$HARFBUZZ_VERSION.tar.xz" "harfbuzz-$HARFBUZZ_VERSION"
meson_lib "harfbuzz-$HARFBUZZ_VERSION" -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled \
  -Dcairo=disabled -Dicu=disabled -Dgraphite2=disabled -Dchafa=disabled -Dcoretext=disabled \
  -Dtests=disabled -Ddocs=disabled -Dintrospection=disabled -Dutilities=disabled

fetch "https://github.com/libass/libass/releases/download/$LIBASS_VERSION/libass-$LIBASS_VERSION.tar.xz" "libass-$LIBASS_VERSION"
if [ ! -f "$PREFIX/lib/libass.a" ]; then
  (cd "$SRC/libass-$LIBASS_VERSION" && ./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-fontconfig --enable-coretext --disable-require-system-font-provider \
    --disable-libunibreak --disable-asm >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
fi

if [ ! -d "$SRC/libplacebo" ]; then
  git clone -q --depth 1 --recursive --shallow-submodules -b "$LIBPLACEBO_VERSION" \
    https://github.com/haasn/libplacebo "$SRC/libplacebo"
fi
meson_lib libplacebo -Dvulkan=disabled -Dopengl=enabled -Dd3d11=disabled -Dglslang=disabled \
  -Dshaderc=disabled -Dlcms=disabled -Ddovi=disabled -Dlibdovi=disabled -Dunwind=disabled \
  -Dxxhash=disabled -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false

fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION"
if [ ! -f "$PREFIX/lib/libavcodec.a" ]; then
  (cd "$SRC/ffmpeg-$FFMPEG_VERSION" && ./configure --prefix="$PREFIX" \
    --enable-static --disable-shared --disable-programs --disable-doc --disable-debug \
    --pkg-config-flags=--static --extra-cflags="$CFLAGS" --extra-ldflags="$LDFLAGS" \
    --disable-autodetect --enable-videotoolbox --enable-zlib --enable-libdav1d \
    --disable-everything --disable-avdevice --enable-network \
    --enable-decoder=h264,hevc,vp8,vp9,av1,libdav1d,mpeg4,mpeg2video,mpeg1video,h263,msmpeg4v3,vc1,wmv3,mjpeg,png \
    --enable-decoder=aac,aac_latm,mp3,mp3float,mp2,opus,vorbis,flac,alac,ac3,eac3,wmav2 \
    --enable-decoder='pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_f64le,pcm_u8,pcm_alaw,pcm_mulaw' \
    --enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,vp9_videotoolbox,av1_videotoolbox,mpeg4_videotoolbox,mpeg2_videotoolbox \
    --enable-demuxer=mov,matroska,mpegts,hls,flv,avi,asf,mpegps,mp3,aac,ogg,wav,flac,h264,hevc,m4v,data \
    --enable-parser=h264,hevc,vp8,vp9,av1,aac,aac_latm,mpegaudio,opus,vorbis,flac,ac3,mpeg4video,mpegvideo,vc1,png,mjpeg \
    --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe_split,extract_extradata \
    --enable-protocol=file,http,tcp,hls,crypto,data \
    --enable-filter=abuffer,abuffersink,buffer,buffersink,aformat,anull,null,format,aresample,scale \
    >/dev/null && make -j"$JOBS" >/dev/null && make install >/dev/null)
fi

fetch "https://github.com/mpv-player/mpv/archive/refs/tags/v$MPV_VERSION.tar.gz" "mpv-$MPV_VERSION"
MPV_BUILD=$SRC/mpv-$MPV_VERSION/build
if [ ! -f "$MPV_BUILD/.kdj-built" ]; then
  rm -rf "$MPV_BUILD"
  meson setup "$MPV_BUILD" "$SRC/mpv-$MPV_VERSION" --prefix="$PREFIX" --libdir=lib --buildtype=release \
    --default-library=shared -Dprefer_static=true -Db_ndebug=true --auto-features=disabled \
    -Dlibmpv=true -Dcplayer=false -Dtests=false -Dfuzzers=false \
    -Dgl=enabled -Dplain-gl=enabled -Dcocoa=enabled -Dgl-cocoa=enabled -Dvideotoolbox-gl=enabled \
    -Dcoreaudio=enabled -Dzlib=enabled -Dlibavdevice=disabled -Dswift-build=enabled \
    -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled
  quiet mpv-compile meson compile -C "$MPV_BUILD"
  touch "$MPV_BUILD/.kdj-built"
fi

cp "$MPV_BUILD/libmpv.2.dylib" "$OUT/libmpv.2.dylib"
install_name_tool -id @rpath/libmpv.2.dylib "$OUT/libmpv.2.dylib"
strip -x "$OUT/libmpv.2.dylib"
codesign --force -s - "$OUT/libmpv.2.dylib"
echo "--- linked libraries"
otool -L "$OUT/libmpv.2.dylib"
echo "--- size"
ls -l "$OUT/libmpv.2.dylib"
