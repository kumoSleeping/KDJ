"""音频标签读写（mutagen 封装）。

整个 sidecar 只有这一个模块直接碰 mutagen：
- 扫描入库时读标签（`read_tags`）、取封面（`read_cover`）；
- 分析完成后把 BPM / 调性 / 能量写回文件（`write_analysis_tags`）。

mutagen 用 try 包住：venv 首次安装可能还没装完，曲库层（纯 SQLite 部分）
不应该因为缺一个可选依赖就整个 import 失败。
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

# 扫描器认这些后缀（其余一律跳过）
AUDIO_EXTENSIONS = frozenset(
    {".mp3", ".flac", ".m4a", ".wav", ".aac", ".ogg", ".aiff", ".aif", ".opus"}
)
# 视频也入库：现场素材、MV 常常只有视频版。分析和播放都只取它的音轨
#（分析走 ffmpeg 解码本来就不挑容器；播放由 /library/audio 先抽轨缓存）。
VIDEO_EXTENSIONS = frozenset({".mp4", ".m4v", ".mov", ".webm", ".mkv"})
MEDIA_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS

try:  # pragma: no cover - 依赖是否装上不影响逻辑分支测试
    from mutagen import File as _MutagenFile
    from mutagen.flac import Picture as _FlacPicture
    from mutagen.id3 import APIC, COMM, ID3, TBPM, TKEY, TXXX
    from mutagen.mp4 import AtomDataType, MP4Cover, MP4FreeForm

    MUTAGEN_ERROR = ""
except Exception as exc:  # pragma: no cover
    _MutagenFile = None  # type: ignore[assignment]
    _FlacPicture = None  # type: ignore[assignment]
    APIC = COMM = ID3 = TBPM = TKEY = TXXX = None  # type: ignore[assignment]
    AtomDataType = MP4Cover = MP4FreeForm = None  # type: ignore[assignment]
    MUTAGEN_ERROR = f"mutagen 不可用: {exc}"


class TaggingError(RuntimeError):
    """写标签失败。读标签永远不抛，只有写会抛（写失败必须让上层看见）。"""


EMPTY_TAGS: dict[str, Any] = {
    "title": "",
    "artist": "",
    "album": "",
    "genre": "",
    "year": "",
    "duration": None,
    "bitrate": None,
    "samplerate": None,
    "channels": None,
    "format": "",
    "size": 0,
}


# ---------------------------------------------------------------- 内部工具


def _first(value: Any) -> str:
    """标签值可能是 str / list / mutagen 的各种包装对象，统一成 str。"""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        if not value:
            return ""
        value = value[0]
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace").strip()
        except Exception:
            return ""
    return str(value).strip()


def _open(path: Path):
    """打开文件，任何异常都吞掉返回 None（损坏文件不能中断整次扫描）。"""
    if _MutagenFile is None:
        return None
    try:
        return _MutagenFile(str(path))
    except Exception:
        return None


def _id3_text(tags, frame_id: str) -> str:
    try:
        frames = tags.getall(frame_id)
    except Exception:
        return ""
    if not frames:
        return ""
    frame = frames[0]
    text = getattr(frame, "text", None)
    if text:
        return _first(text)
    return _first(frame)


# RIFF INFO 里的四字符 id → 我们的字段
_RIFF_INFO_KEYS = {
    b"INAM": "title",
    b"IART": "artist",
    b"IPRD": "album",
    b"IGNR": "genre",
    b"ICRD": "year",
}


def _read_riff_info(path: Path) -> dict[str, str]:
    """WAV 的 LIST/INFO chunk。

    mutagen 的 WAVE 只认 ID3 chunk，但 ffmpeg / Audacity / 录音笔写出来的 wav
    元数据都在 RIFF 原生的 LIST-INFO 里，不自己解析的话整个 wav 曲库都是空标题。
    """
    out: dict[str, str] = {}
    try:
        with open(path, "rb") as fh:
            header = fh.read(12)
            if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
                return out
            while True:
                chunk = fh.read(8)
                if len(chunk) < 8:
                    break
                chunk_id = chunk[:4]
                size = int.from_bytes(chunk[4:8], "little")
                if size < 0 or size > 8 * 1024 * 1024:
                    # 音频数据块（几十上百 MB）直接跳过，只找元数据
                    fh.seek(size + (size & 1), 1)
                    continue
                data = fh.read(size + (size & 1))[:size]
                if chunk_id != b"LIST" or data[:4] != b"INFO":
                    continue
                pos = 4
                while pos + 8 <= len(data):
                    sub_id = data[pos : pos + 4]
                    sub_size = int.from_bytes(data[pos + 4 : pos + 8], "little")
                    pos += 8
                    value = data[pos : pos + sub_size]
                    pos += sub_size + (sub_size & 1)
                    field = _RIFF_INFO_KEYS.get(sub_id)
                    if field:
                        out[field] = value.split(b"\x00")[0].decode("utf-8", "replace").strip()
                break
    except Exception:
        return {}
    if out.get("year"):
        out["year"] = out["year"][:4]
    return out


def _read_text_tags(tags) -> dict[str, str]:
    """从三种容器里抠出 title/artist/album/genre/year。"""
    out = {"title": "", "artist": "", "album": "", "genre": "", "year": ""}
    if tags is None:
        return out

    # ID3：mp3 / wav（RIFF 里塞 ID3 chunk）/ aiff 共用同一套帧
    if ID3 is not None and isinstance(tags, ID3):
        out["title"] = _id3_text(tags, "TIT2")
        out["artist"] = _id3_text(tags, "TPE1") or _id3_text(tags, "TPE2")
        out["album"] = _id3_text(tags, "TALB")
        out["genre"] = _id3_text(tags, "TCON")
        year = _id3_text(tags, "TDRC") or _id3_text(tags, "TYER") or _id3_text(tags, "TDOR")
        out["year"] = year[:4]
        return out

    # MP4/M4A：四字符 atom
    if type(tags).__name__ == "MP4Tags":
        get = tags.get
        out["title"] = _first(get("\xa9nam"))
        out["artist"] = _first(get("\xa9ART")) or _first(get("aART"))
        out["album"] = _first(get("\xa9alb"))
        out["genre"] = _first(get("\xa9gen"))
        out["year"] = _first(get("\xa9day"))[:4]
        return out

    # 其余按 vorbis comment / 通用 mapping（flac / ogg / opus / APEv2）处理
    try:
        lower = {str(k).lower(): v for k, v in tags.items()}
    except Exception:
        return out
    out["title"] = _first(lower.get("title"))
    out["artist"] = _first(lower.get("artist")) or _first(lower.get("albumartist"))
    out["album"] = _first(lower.get("album"))
    out["genre"] = _first(lower.get("genre"))
    out["year"] = (_first(lower.get("date")) or _first(lower.get("year")))[:4]
    return out


# ---------------------------------------------------------------- 读


def read_tags(path: Path) -> dict[str, Any]:
    """读一个音频文件的标签 + 流信息。任何情况下都不抛异常，取不到就给空值。

    `bitrate` 单位是 **kbps**（和 Quality 的 "320"/"128" 口径一致），
    不是 mutagen 原始的 bps。
    """
    path = Path(path)
    info = dict(EMPTY_TAGS)

    ext = path.suffix.lower()
    # .aif 和 .aiff 是同一种容器，库里统一记 aiff
    info["format"] = "aiff" if ext == ".aif" else ext.lstrip(".")

    try:
        info["size"] = int(path.stat().st_size)
    except OSError:
        pass

    audio = _open(path)
    if audio is None:
        return info

    stream = getattr(audio, "info", None)
    if stream is not None:
        length = getattr(stream, "length", None)
        if isinstance(length, (int, float)) and length > 0:
            info["duration"] = round(float(length), 3)
        bitrate = getattr(stream, "bitrate", None)
        if isinstance(bitrate, (int, float)) and bitrate > 0:
            info["bitrate"] = int(round(bitrate / 1000))
        elif info["duration"] and info["size"]:
            # FLAC/WAV 的 StreamInfo 不一定带 bitrate，用文件大小反推
            info["bitrate"] = int(round(info["size"] * 8 / info["duration"] / 1000))
        for attr, field in (("sample_rate", "samplerate"), ("channels", "channels")):
            value = getattr(stream, attr, None)
            if isinstance(value, (int, float)) and value > 0:
                info[field] = int(value)

    try:
        info.update(_read_text_tags(getattr(audio, "tags", None)))
    except Exception:
        pass

    if info["format"] == "wav" and not (info["title"] or info["artist"]):
        for field, value in _read_riff_info(path).items():
            if value and not info.get(field):
                info[field] = value
    return info


def read_cover(path: Path) -> tuple[bytes, str] | None:
    """取内嵌封面，返回 (二进制数据, mime)；没有或读失败返回 None。"""
    audio = _open(Path(path))
    if audio is None:
        return None

    try:
        # FLAC：图片不在 vorbis comment 里，单独一个 PICTURE metadata block
        pictures = getattr(audio, "pictures", None)
        if pictures:
            pic = pictures[0]
            return bytes(pic.data), (pic.mime or "image/jpeg")

        tags = getattr(audio, "tags", None)
        if tags is None:
            return None

        if ID3 is not None and isinstance(tags, ID3):
            frames = tags.getall("APIC")
            if frames:
                # 优先封面（type 3 = front cover）
                frames.sort(key=lambda f: 0 if getattr(f, "type", 0) == 3 else 1)
                return bytes(frames[0].data), (frames[0].mime or "image/jpeg")
            return None

        if type(tags).__name__ == "MP4Tags":
            covers = tags.get("covr")
            if covers:
                cover = covers[0]
                fmt = getattr(cover, "imageformat", None)
                mime = "image/png" if (MP4Cover is not None and fmt == MP4Cover.FORMAT_PNG) else "image/jpeg"
                return bytes(cover), mime
            return None

        # Ogg/Opus：base64 后的 FLAC Picture block 塞在 metadata_block_picture 里
        lower = {str(k).lower(): v for k, v in tags.items()}
        raw = _first(lower.get("metadata_block_picture"))
        if raw and _FlacPicture is not None:
            pic = _FlacPicture(base64.b64decode(raw))
            return bytes(pic.data), (pic.mime or "image/jpeg")
        data = lower.get("coverart")
        if data:
            return base64.b64decode(_first(data)), _first(lower.get("coverartmime")) or "image/jpeg"
    except Exception:
        return None
    return None


# ---------------------------------------------------------------- 写


def to_id3_key(music_key: str) -> str:
    """"A minor" / "Am" → "Am"；"Db major" → "Db"。

    ID3 的 TKEY 规定最多 3 个字符：根音 A-G + 可选 `#`/`b` + 小调加 `m`。
    """
    value = (music_key or "").strip().replace("♯", "#").replace("♭", "b")
    if not value:
        return ""
    parts = value.replace("-", " ").split()
    root = parts[0]
    rest = " ".join(parts[1:]).lower()

    if rest:
        minor = rest.startswith("min") or rest.startswith("mol") or rest == "m"
    else:
        # 无后缀写法："Am" / "F#m" / "C"
        minor = len(root) > 1 and root.endswith("m")
        if minor:
            root = root[:-1]
    if not root:
        return ""

    accidental = ""
    tail = root[1:]
    if "#" in tail:
        accidental = "#"
    elif "b" in tail.lower():
        accidental = "b"
    return f"{root[0].upper()}{accidental}{'m' if minor else ''}"


def _comment_text(camelot: str, energy: int | None, comment: str) -> str:
    """DJ 软件里最通用的做法：Camelot 写进 comment（Mixed In Key 就是这么干的）。"""
    parts: list[str] = []
    if camelot:
        parts.append(camelot)
    if energy:
        parts.append(f"Energy {int(energy)}")
    if comment:
        parts.append(comment)
    return " - ".join(parts)


def write_analysis_tags(
    path: Path,
    *,
    bpm: float | None = None,
    camelot: str = "",
    music_key: str = "",
    energy: int | None = None,
    comment: str = "",
) -> None:
    """把分析结果写回文件。

    各家 DJ 软件读调性的字段并不一样，所以能写的都写一遍：
    - **Rekordbox**：mp3 读 `TKEY`，flac/ogg 读 vorbis 的 `INITIALKEY`（没有才退 `KEY`），m4a 读 `----:com.apple.iTunes:initialkey`。
    - **Traktor**：mp3 读 `TKEY`，也认自己写的 `TXXX:INITIALKEY`；flac 读 `INITIALKEY`。
    - **Serato**：主要走自己的 `GEOB` 私有块（我们不碰），导入外部文件时读 `TKEY` / vorbis `KEY`。
    - **Mixed In Key**：把 Camelot 写在 comment（`COMM` / `COMMENT` / `©cmt`）和 `TXXX:EnergyLevel` 里。

    调性字段一律写**传统调名**（"Am"），Camelot 走 comment + 额外的 `CAMELOT` 字段，
    避免 Rekordbox 在 Key 列里显示成 "8A" 这种它并不认识的值。
    """
    path = Path(path)
    if _MutagenFile is None:
        raise TaggingError(MUTAGEN_ERROR or "mutagen 不可用")
    if not path.exists():
        raise TaggingError(f"文件不存在: {path}")

    try:
        audio = _MutagenFile(str(path))
    except Exception as exc:
        raise TaggingError(f"打开失败: {exc}") from exc
    if audio is None:
        raise TaggingError(f"不支持的音频格式: {path.name}")

    if audio.tags is None:
        try:
            audio.add_tags()
        except Exception as exc:
            raise TaggingError(f"无法创建标签块: {exc}") from exc
    tags = audio.tags

    key_text = to_id3_key(music_key)
    camelot = (camelot or "").strip().upper()
    note = _comment_text(camelot, energy, comment)
    bpm_value = float(bpm) if bpm and bpm > 0 else None

    try:
        if ID3 is not None and isinstance(tags, ID3):
            # ID3 规范里 TBPM 是整数字符串，写小数有些老软件会解析失败
            if bpm_value:
                tags.add(TBPM(encoding=3, text=[str(int(round(bpm_value)))]))
            if key_text:
                tags.add(TKEY(encoding=3, text=[key_text]))
                tags.add(TXXX(encoding=3, desc="INITIALKEY", text=[key_text]))
            if camelot:
                tags.add(TXXX(encoding=3, desc="CAMELOT", text=[camelot]))
            if energy:
                tags.add(TXXX(encoding=3, desc="EnergyLevel", text=[str(int(energy))]))
            if note:
                # add() 按 HashKey("COMM::eng") 覆盖，不会堆出一串重复注释
                tags.add(COMM(encoding=3, lang="eng", desc="", text=[note]))
            _save(audio, id3=True)
            return

        if type(tags).__name__ == "MP4Tags":
            if bpm_value:
                # tmpo 是 16bit 无符号整数，必须夹取
                tags["tmpo"] = [max(0, min(65535, int(round(bpm_value))))]
                tags["----:com.apple.iTunes:BPM"] = [_freeform(f"{bpm_value:.2f}")]
            if key_text:
                tags["----:com.apple.iTunes:initialkey"] = [_freeform(key_text)]
                tags["----:com.apple.iTunes:KEY"] = [_freeform(key_text)]
            if camelot:
                tags["----:com.apple.iTunes:CAMELOT"] = [_freeform(camelot)]
            if energy:
                tags["----:com.apple.iTunes:EnergyLevel"] = [_freeform(str(int(energy)))]
            if note:
                tags["\xa9cmt"] = [note]
            _save(audio)
            return

        # vorbis comment：flac / ogg / opus。键名大小写不敏感，习惯写大写
        if bpm_value:
            tags["BPM"] = [f"{bpm_value:.2f}"]
        if key_text:
            tags["INITIALKEY"] = [key_text]
            tags["KEY"] = [key_text]
        if camelot:
            tags["CAMELOT"] = [camelot]
        if energy:
            tags["ENERGYLEVEL"] = [str(int(energy))]
        if note:
            tags["COMMENT"] = [note]
        _save(audio)
    except TaggingError:
        raise
    except Exception as exc:
        raise TaggingError(f"写标签失败: {exc}") from exc


def _freeform(value: str):
    """MP4 的 `----` freeform atom 只收 bytes。"""
    if MP4FreeForm is None or AtomDataType is None:  # pragma: no cover
        return value.encode("utf-8")
    return MP4FreeForm(value.encode("utf-8"), AtomDataType.UTF8)


def _save(audio, *, id3: bool = False) -> None:
    if id3:
        try:
            # ID3v2.3 比 2.4 兼容性好（Windows 资源管理器 / 老版本 Traktor 只认 2.3）
            audio.save(v2_version=3)
            return
        except TypeError:
            pass
    audio.save()
