"""曲库层测试。

不造真音频：分析/标签部分单独测，这里只压 service 的 SQL 逻辑，
假数据直接 INSERT 进库（造 mp3 又慢又依赖 ffmpeg，跑不动 CI）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kumodeck.library.db import Database  # noqa: E402
from kumodeck.library.folders import (  # noqa: E402
    MANIFEST_NAME,
    FolderError,
    apply_order,
    build_tree,
    count_audio_files,
    ensure_inside,
    infer_roots,
    init_manifests,
    link_file,
    link_state,
    move_folder,
    read_manifest,
    resolve_roots,
    unique_target,
    write_manifest,
)
from kumodeck.library.scan import collect_files  # noqa: E402
from kumodeck.library.service import (  # noqa: E402
    LibraryService,
    TrackNotFound,
    bpm_bucket,
    camelot_relations,
    normalize_path,
    parse_key_filter,
)
from kumodeck.models import TrackPatch  # noqa: E402
from kumodeck.tagging import to_id3_key  # noqa: E402


@pytest.fixture()
def service(tmp_path: Path) -> LibraryService:
    return LibraryService(Database(tmp_path / "kumodeck.db"))


def u(text: str) -> str:
    """假路径统一换成平台分隔符：服务层按 os.sep 拼路径前缀，
    Windows 上 '\\music\\' 匹配不上写死的 '/music/'，CI 三平台都要绿。"""
    return text.replace("/", os.sep)


def insert(service: LibraryService, **kwargs) -> int:
    """直接塞一行假数据，绕开 upsert_file 的文件系统依赖。"""
    row = {
        "path": u(f"/music/{kwargs.get('title', 'x')}.mp3"),
        "filename": f"{kwargs.get('title', 'x')}.mp3",
        "title": "Untitled",
        "artist": "",
        "album": "",
        "bpm": None,
        "camelot": "",
        "music_key": "",
        "energy": None,
        "duration": 200.0,
        "size": 1000,
        "source_platform": "local",
        "analyzed_at": None,
        "added_at": "2026-01-01T00:00:00Z",
        "modified_at": "2026-01-01T00:00:00Z",
    }
    row.update(kwargs)
    columns = ", ".join(row)
    placeholders = ", ".join("?" * len(row))
    conn = service.db.connect()
    with conn:
        cursor = conn.execute(
            f"INSERT INTO tracks ({columns}) VALUES ({placeholders})", list(row.values())
        )
    return int(cursor.lastrowid)


# ---------------------------------------------------------------- (a) upsert 幂等


def test_upsert_file_is_idempotent(service: LibraryService, tmp_path: Path):
    audio = tmp_path / "Track One.mp3"
    audio.write_bytes(b"not really audio")

    first = service.upsert_file(audio)
    second = service.upsert_file(audio)
    third = service.upsert_file(audio, source_platform="wyy", source_key="123")

    assert first == second == third
    assert service.stats().total == 1

    track = service.get(first)
    assert track is not None
    # 读不到 ID3 时用文件名兜底，列表里不能显示空标题
    assert track.title == "Track One"
    assert track.path == normalize_path(audio)
    assert track.source_platform == "wyy"
    assert track.source_key == "123"


def test_upsert_file_picks_up_changes(service: LibraryService, tmp_path: Path):
    audio = tmp_path / "a.flac"
    audio.write_bytes(b"x" * 10)
    track_id = service.upsert_file(audio)

    audio.write_bytes(b"y" * 4096)
    import os

    os.utime(audio, (100000.0, 100000.0))  # 强制 mtime 变化
    assert service.upsert_file(audio) == track_id

    track = service.get(track_id)
    assert track is not None and track.size == 4096


def test_get_by_path_matches_unnormalized(service: LibraryService, tmp_path: Path):
    audio = tmp_path / "b.mp3"
    audio.write_bytes(b"x")
    track_id = service.upsert_file(audio)
    # 带 ".." 的等价路径也要能查到（下载器传进来的路径不一定归一化）
    weird = str(tmp_path / "sub" / ".." / "b.mp3")
    found = service.get_by_path(weird)
    assert found is not None and found.id == track_id


# ---------------------------------------------------------------- (b) 过滤 + 分页


@pytest.fixture()
def filled(service: LibraryService) -> LibraryService:
    insert(service, title="Sunrise", artist="Alpha", album="Dawn", bpm=128.0,
           camelot="8A", music_key="A minor", energy=7, analyzed_at="2026-02-01T00:00:00Z",
           added_at="2026-01-05T00:00:00Z")
    insert(service, title="Midnight", artist="Beta", album="Night", bpm=174.0,
           camelot="9A", music_key="E minor", energy=9, analyzed_at="2026-02-02T00:00:00Z",
           added_at="2026-01-04T00:00:00Z")
    insert(service, title="Sunset", artist="Alpha & Gamma", album="Dusk", bpm=95.0,
           camelot="3A", music_key="Bb minor", energy=3, analyzed_at="2026-02-03T00:00:00Z",
           added_at="2026-01-03T00:00:00Z")
    insert(service, title="Untagged", artist="", album="", added_at="2026-01-02T00:00:00Z")
    return service


def test_query_matches_title_artist_album_filename(filled: LibraryService):
    assert [t.title for t in filled.list_tracks(q="sun").items] == ["Sunrise", "Sunset"]
    assert {t.title for t in filled.list_tracks(q="alpha").items} == {"Sunrise", "Sunset"}
    assert [t.title for t in filled.list_tracks(q="night").items] == ["Midnight"]
    assert [t.title for t in filled.list_tracks(q="Midnight.mp3").items] == ["Midnight"]
    # 大小写不敏感
    assert len(filled.list_tracks(q="SUNRISE").items) == 1


def test_query_escapes_like_wildcards(filled: LibraryService):
    insert(filled, title="100% Pure", added_at="2026-01-06T00:00:00Z")
    assert [t.title for t in filled.list_tracks(q="100%").items] == ["100% Pure"]
    # "%" 被转义后不该匹配到所有曲目
    assert len(filled.list_tracks(q="%").items) == 1


def test_key_filter_accepts_camelot_and_key_name(filled: LibraryService):
    for value in ("8A", "8a", "A minor", "Am", "a min"):
        page = filled.list_tracks(key=value)
        assert [t.title for t in page.items] == ["Sunrise"], value


def test_range_and_analyzed_filters(filled: LibraryService):
    assert {t.title for t in filled.list_tracks(bpm_min=120).items} == {"Sunrise", "Midnight"}
    assert {t.title for t in filled.list_tracks(bpm_min=120, bpm_max=130).items} == {"Sunrise"}
    assert {t.title for t in filled.list_tracks(energy_min=7).items} == {"Sunrise", "Midnight"}
    assert [t.title for t in filled.list_tracks(analyzed=False).items] == ["Untagged"]
    assert len(filled.list_tracks(analyzed=True).items) == 3


def test_pagination_is_stable(filled: LibraryService):
    page1 = filled.list_tracks(sort="added_at", order="asc", limit=2, offset=0)
    page2 = filled.list_tracks(sort="added_at", order="asc", limit=2, offset=2)
    assert page1.total == page2.total == 4
    assert page1.limit == 2 and page2.offset == 2
    assert [t.title for t in page1.items] == ["Untagged", "Sunset"]
    assert [t.title for t in page2.items] == ["Midnight", "Sunrise"]
    # 两页不重不漏
    assert len({t.id for t in page1.items} & {t.id for t in page2.items}) == 0


def test_sort_puts_nulls_last_and_orders_camelot_numerically(filled: LibraryService):
    for order in ("asc", "desc"):
        titles = [t.title for t in filled.list_tracks(sort="bpm", order=order).items]
        assert titles[-1] == "Untagged", order

    insert(filled, title="Tenner", camelot="10A", bpm=100.0)
    codes = [t.camelot for t in filled.list_tracks(sort="camelot", order="asc").items if t.camelot]
    assert codes == ["3A", "8A", "9A", "10A"]  # 不能是字符串序的 10A < 3A


# ---------------------------------------------------------------- (c) 和声推荐


@pytest.fixture()
def harmonic(service: LibraryService) -> tuple[LibraryService, int]:
    source = insert(service, title="Source", bpm=128.0, camelot="8A", music_key="A minor")
    insert(service, title="Same", bpm=128.0, camelot="8A")
    insert(service, title="Up", bpm=129.0, camelot="9A")
    insert(service, title="Down", bpm=127.0, camelot="7A")
    insert(service, title="Relative", bpm=128.0, camelot="8B")
    insert(service, title="Boost", bpm=128.0, camelot="3A")       # +7，默认不出现
    insert(service, title="Clash", bpm=128.0, camelot="5A")       # 不兼容
    insert(service, title="TooFast", bpm=150.0, camelot="9A")     # 调兼容但对不上拍
    insert(service, title="HalfTime", bpm=64.5, camelot="8A")     # 半速可用
    insert(service, title="TwoStep", bpm=128.0, camelot="10A")    # ±2，放宽档
    insert(service, title="Diagonal", bpm=128.0, camelot="9B")    # 斜接，放宽档
    return service, source


def test_harmonic_narrow_returns_only_the_core_four(harmonic):
    service, source = harmonic
    matches = service.harmonic_matches(source, 6.0, 50, wide=False)
    codes = {m.track.camelot for m in matches}

    assert codes == {"7A", "8A", "9A", "8B"}
    assert "3A" not in codes  # +7 属于放宽档，窄模式不给
    assert "5A" not in codes  # 怎么都不兼容
    assert "TooFast" not in {m.track.title for m in matches}

    labels = {m.track.camelot: (m.relation, m.relation_label) for m in matches}
    assert labels["9A"] == ("energy_up", "提能量")
    assert labels["7A"] == ("energy_down", "降能量")
    assert labels["8B"] == ("relative", "转大小调")


def test_harmonic_wide_is_the_default_and_ranks_extras_lower(harmonic):
    service, source = harmonic
    matches = service.harmonic_matches(source, 6.0, 50)
    by_code = {m.track.camelot: m for m in matches}

    # 放宽档把 +7 也带进来了，但它必须排在同调后面——"更多"不能变成"更差"
    assert by_code["3A"].relation == "energy_boost"
    assert by_code["3A"].score < by_code["8A"].score
    assert "5A" not in by_code
    # 每种关系都要真的能被 pydantic 构造出来——models.Literal 漏一个就是整条接口 500
    assert by_code["10A"].relation == "two_step"
    assert by_code["9B"].relation == "diagonal"
    assert {m.relation for m in matches} >= {"same", "energy_boost", "two_step", "diagonal"}


def test_harmonic_score_is_higher_is_better_and_sorted(harmonic):
    service, source = harmonic
    matches = service.harmonic_matches(source, 6.0, 50)

    scores = [m.score for m in matches]
    assert scores == sorted(scores, reverse=True)
    assert all(0.0 < s <= 1.0 for s in scores)
    # 同调同速必然排第一
    assert matches[0].track.title == "Same"
    assert matches[0].relation == "same" and matches[0].tempo_ratio == 1.0


def test_harmonic_accepts_half_and_double_time(harmonic):
    service, source = harmonic
    by_title = {m.track.title: m for m in service.harmonic_matches(source, 6.0, 50, wide=False)}
    half = by_title["HalfTime"]
    assert half.tempo_ratio == 2.0            # 64.5 × 2 = 129 ≈ 128
    assert half.bpm_delta == pytest.approx(1.0)
    # 折算过的比同速的排后面
    assert half.score < by_title["Same"].score


def test_camelot_wide_adds_two_step_and_diagonal(harmonic):
    relations = camelot_relations("8A", wide=True)
    assert relations["10A"] == "two_step" and relations["6A"] == "two_step"
    assert relations["9B"] == "diagonal" and relations["7B"] == "diagonal"
    # 核心四条不能被放宽档覆盖掉（绕圈时可能撞号）
    assert relations["8A"] == "same" and relations["8B"] == "relative"


def test_harmonic_edge_cases(service: LibraryService):
    no_key = insert(service, title="NoKey", bpm=128.0)
    assert service.harmonic_matches(no_key, 6.0, 50) == []
    assert service.harmonic_matches(999999, 6.0, 50) == []

    source = insert(service, title="S", bpm=128.0, camelot="8A")
    insert(service, title="NoBpm", camelot="8A")
    # 候选没分析出 BPM，没法保证能对拍，不该推荐
    assert service.harmonic_matches(source, 6.0, 50) == []

    limited = insert(service, title="L", bpm=128.0, camelot="12A")
    for i in range(5):
        insert(service, title=f"C{i}", bpm=128.0, camelot="1A", path=u(f"/m/c{i}.mp3"))
    assert len(service.harmonic_matches(limited, 6.0, 2)) == 2


def test_camelot_relations_wraps_around():
    assert camelot_relations("12A") == {
        "12A": "same", "1A": "energy_up", "11A": "energy_down", "12B": "relative",
    }
    assert camelot_relations("1B") == {
        "1B": "same", "2B": "energy_up", "12B": "energy_down", "1A": "relative",
    }
    assert camelot_relations("8A", wide=True)["3A"] == "energy_boost"
    assert camelot_relations("") == {}
    assert camelot_relations("13A") == {}


# ---------------------------------------------------------------- (d) sort 注入


@pytest.mark.parametrize(
    "evil",
    [
        "id; DROP TABLE tracks",
        "id) --",
        "(SELECT 1)",
        "title, (SELECT COUNT(*) FROM sqlite_master)",
        "",
        "nonexistent_column",
        "1=1",
        "path' OR '1'='1",
    ],
)
def test_illegal_sort_falls_back_without_injection(filled: LibraryService, evil: str):
    page = filled.list_tracks(sort=evil, order="drop table")
    # 落回默认排序（added_at desc），既不炸也不执行注入
    assert page.total == 4
    assert [t.title for t in page.items] == ["Sunrise", "Midnight", "Sunset", "Untagged"]

    conn = filled.db.connect()
    assert conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 4


def test_query_string_cannot_inject(filled: LibraryService):
    assert filled.list_tracks(q="'; DROP TABLE tracks; --").items == []
    assert filled.list_tracks(key="8A'; DROP TABLE tracks; --").items == []
    conn = filled.db.connect()
    assert conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] == 4


# ---------------------------------------------------------------- patch / delete


def test_patch_updates_fields_and_tags(filled: LibraryService):
    track = filled.list_tracks(q="Sunrise").items[0]
    updated = filled.patch(track.id, TrackPatch(rating=4, comment="opener", tags=["peak", "warmup"]))
    assert updated.rating == 4
    assert updated.comment == "opener"
    assert updated.tags == ["peak", "warmup"]
    assert updated.modified_at != track.modified_at

    # 只传 tags 时其它字段不动
    again = filled.patch(track.id, TrackPatch(tags=[]))
    assert again.tags == []
    assert again.rating == 4 and again.comment == "opener"

    assert filled.patch(track.id, TrackPatch(rating=99)).rating == 5  # 夹取到 0..5

    with pytest.raises(TrackNotFound):
        filled.patch(123456, TrackPatch(rating=1))


def test_delete_removes_row_and_tags(filled: LibraryService, tmp_path: Path):
    track = filled.list_tracks(q="Sunrise").items[0]
    filled.patch(track.id, TrackPatch(tags=["x"]))
    assert filled.delete(track.id) is True
    assert filled.get(track.id) is None
    assert filled.delete(track.id) is False

    conn = filled.db.connect()
    assert conn.execute("SELECT COUNT(*) FROM tags WHERE track_id = ?", (track.id,)).fetchone()[0] == 0

    audio = tmp_path / "gone.mp3"
    audio.write_bytes(b"x")
    victim = filled.upsert_file(audio)
    assert filled.delete(victim, delete_file=True) is True
    assert not audio.exists()


# ---------------------------------------------------------------- 分析队列 / 统计


class FakeAnalysis:
    duration = 321.0
    bpm = 128.5
    bpm_confidence = 0.9
    first_beat = 0.31
    key = "A minor"
    camelot = "8a"
    open_key = "1m"
    key_confidence = 0.7
    energy = 8
    rms_db = -9.5
    peak_db = -0.5
    errors = ["chroma 帧不足"]


def test_pending_and_save_analysis(filled: LibraryService):
    pending = filled.pending_analysis_ids(None, force=False)
    assert len(pending) == 1  # 只有 Untagged 没分析

    target = pending[0]
    filled.save_analysis(target, FakeAnalysis())
    track = filled.get(target)
    assert track is not None
    assert track.bpm == 128.5
    assert track.camelot == "8A"
    assert track.energy == 8
    assert track.analyzed_at is not None
    # 子分析出错也要标记成已分析，否则队列永远清不空
    assert track.analysis_error == "chroma 帧不足"
    # 容器头里已有时长就不覆盖（假数据里是 200s）
    assert track.duration == 200.0

    assert filled.pending_analysis_ids(None, force=False) == []
    assert len(filled.pending_analysis_ids(None, force=True)) == 4
    assert filled.pending_analysis_ids([target], force=True) == [target]
    assert filled.pending_analysis_ids([target], force=False) == []
    assert filled.pending_analysis_ids([], force=True) == []
    assert filled.pending_analysis_ids([987654], force=True) == []


def test_save_analysis_fills_missing_duration(service: LibraryService):
    track_id = insert(service, title="NoDuration", duration=None)
    service.save_analysis(track_id, FakeAnalysis())
    track = service.get(track_id)
    assert track is not None and track.duration == 321.0


def test_stats_buckets(filled: LibraryService):
    stats = filled.stats()
    assert stats.total == 4
    assert stats.analyzed == 3
    assert stats.total_size == 4000
    assert stats.total_duration == pytest.approx(800.0)
    assert stats.by_camelot == {"3A": 1, "8A": 1, "9A": 1}  # 按轮盘顺序
    assert stats.by_bpm_bucket == {"90-99": 1, "120-129": 1, "170+": 1}
    assert stats.by_platform == {"local": 4}


def test_bpm_bucket_edges():
    assert bpm_bucket(60) == "<90"
    assert bpm_bucket(89.9) == "<90"
    assert bpm_bucket(90) == "90-99"
    assert bpm_bucket(128) == "120-129"
    assert bpm_bucket(169.9) == "160-169"
    assert bpm_bucket(170) == "170+"
    assert bpm_bucket(300) == "170+"


# ---------------------------------------------------------------- 扫描 / 工具


def test_collect_files_filters_junk(tmp_path: Path):
    (tmp_path / "good.mp3").write_bytes(b"x")
    (tmp_path / "._good.mp3").write_bytes(b"x")     # macOS 资源叉
    (tmp_path / "cover.jpg").write_bytes(b"x")
    nested = tmp_path / "sub"
    nested.mkdir()
    (nested / "deep.flac").write_bytes(b"x")
    trash = tmp_path / ".Trash"
    trash.mkdir()
    (trash / "deleted.mp3").write_bytes(b"x")
    modules = tmp_path / "node_modules"
    modules.mkdir()
    (modules / "pkg.mp3").write_bytes(b"x")

    names = {Path(p).name for p in collect_files([str(tmp_path)], recursive=True)}
    assert names == {"good.mp3", "deep.flac"}

    shallow = {Path(p).name for p in collect_files([str(tmp_path)], recursive=False)}
    assert shallow == {"good.mp3"}

    # 直接给文件路径也要认；重复入参只算一次
    single = collect_files([str(tmp_path / "good.mp3"), str(tmp_path / "good.mp3")], recursive=True)
    assert len(single) == 1
    assert collect_files([str(tmp_path / "missing")], recursive=True) == []


def test_scan_paths_is_incremental(service: LibraryService, tmp_path: Path):
    from kumodeck.library.scan import scan_paths

    (tmp_path / "one.mp3").write_bytes(b"x")
    (tmp_path / "two.mp3").write_bytes(b"y")

    events: list[tuple[int, int, str]] = []
    ids = scan_paths(service, [str(tmp_path)], True, lambda d, t, c: events.append((d, t, c)))
    assert len(ids) == 2
    assert events[0][1] == 2 and events[-1][0] == 2

    again = scan_paths(service, [str(tmp_path)], True, lambda d, t, c: None)
    assert sorted(again) == sorted(ids)  # 幂等，没有产生新行
    assert service.stats().total == 2


def test_parse_key_filter():
    assert parse_key_filter("8A") == ("8A", "8A")
    assert parse_key_filter(" 12b ") == ("12B", "12b")
    assert parse_key_filter("A minor")[0] == "8A"
    assert parse_key_filter("Am")[0] == "8A"
    assert parse_key_filter("C major")[0] == "8B"
    assert parse_key_filter("G# minor")[0] == "1A"  # 同音异名要能查到 Ab minor
    assert parse_key_filter("C# minor")[0] == "12A"
    assert parse_key_filter("13A")[0] == ""
    assert parse_key_filter("") == ("", "")


def test_to_id3_key():
    assert to_id3_key("A minor") == "Am"
    assert to_id3_key("C major") == "C"
    assert to_id3_key("F# minor") == "F#m"
    assert to_id3_key("Db major") == "Db"
    assert to_id3_key("Am") == "Am"
    assert to_id3_key("") == ""
    assert len(to_id3_key("Db minor")) <= 3  # TKEY 最多 3 个字符


def test_read_tags_never_raises(tmp_path: Path):
    from kumodeck.tagging import read_cover, read_tags

    junk = tmp_path / "broken.mp3"
    junk.write_bytes(b"definitely not audio")
    info = read_tags(junk)
    assert info["title"] == "" and info["format"] == "mp3" and info["size"] == 20
    assert read_cover(junk) is None

    missing = read_tags(tmp_path / "ghost.flac")
    assert missing["size"] == 0 and missing["duration"] is None


# ---------------------------------------------------------------- 真实音频（需要 ffmpeg）

HAVE_FFMPEG = shutil.which("ffmpeg") is not None


def make_audio(tmp_path: Path, ext: str, codec: list[str]) -> Path:
    """用 ffmpeg 造一段 1 秒正弦，带基础标签。"""
    out = tmp_path / f"tone.{ext}"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         "-ar", "44100", "-ac", "2", *codec,
         "-metadata", "title=Test Title", "-metadata", "artist=Kumo",
         "-metadata", "album=Deck", "-metadata", "genre=Techno", "-metadata", "date=2024",
         str(out)],
        check=True,
    )
    return out


@pytest.mark.skipif(not HAVE_FFMPEG, reason="需要 ffmpeg 造测试音频")
@pytest.mark.parametrize(
    ("ext", "codec"),
    [
        ("mp3", ["-codec:a", "libmp3lame", "-b:a", "192k"]),
        ("flac", ["-codec:a", "flac"]),
        ("m4a", ["-codec:a", "aac", "-b:a", "128k"]),
        ("ogg", ["-codec:a", "libvorbis"]),
        ("wav", []),
    ],
)
def test_tag_roundtrip_on_real_files(tmp_path: Path, ext: str, codec: list[str]):
    from kumodeck.tagging import read_tags, write_analysis_tags

    audio = make_audio(tmp_path, ext, codec)

    info = read_tags(audio)
    assert info["title"] == "Test Title"
    assert info["artist"] == "Kumo"
    assert info["album"] == "Deck"
    assert info["genre"] == "Techno"
    assert info["year"] == "2024"
    assert info["format"] == ext
    assert info["duration"] == pytest.approx(1.0, abs=0.1)
    assert info["samplerate"] == 44100 and info["channels"] == 2
    assert info["bitrate"] and info["bitrate"] > 0  # kbps，不是 bps

    write_analysis_tags(audio, bpm=128.37, camelot="8A", music_key="A minor", energy=7, comment="opener")

    # 写分析标签不能把原有的元数据冲掉
    after = read_tags(audio)
    assert after["title"] == "Test Title" and after["artist"] == "Kumo"

    from mutagen import File as MutagenFile

    keys = {str(k) for k in MutagenFile(str(audio)).tags.keys()}
    if ext in ("mp3", "wav"):
        assert {"TBPM", "TKEY", "COMM::eng", "TXXX:CAMELOT", "TXXX:EnergyLevel"} <= keys
    elif ext == "m4a":
        assert {"tmpo", "©cmt", "----:com.apple.iTunes:initialkey"} <= keys
    else:
        assert {"bpm", "key", "initialkey", "comment"} <= keys

    # 重复写不该堆出重复注释帧
    write_analysis_tags(audio, bpm=130.0, camelot="9A", music_key="E minor", energy=8)
    keys2 = {str(k) for k in MutagenFile(str(audio)).tags.keys()}
    assert len(keys2) == len(keys)


@pytest.mark.skipif(not HAVE_FFMPEG, reason="需要 ffmpeg 造测试音频")
def test_scan_and_upsert_real_files(service: LibraryService, tmp_path: Path):
    from kumodeck.library.scan import scan_paths

    make_audio(tmp_path, "mp3", ["-codec:a", "libmp3lame", "-b:a", "192k"])
    (tmp_path / "notes.txt").write_text("skip me")

    ids = scan_paths(service, [str(tmp_path)], True, lambda d, t, c: None)
    assert len(ids) == 1
    track = service.get(ids[0])
    assert track is not None
    assert track.title == "Test Title" and track.artist == "Kumo"
    assert track.format == "mp3" and track.duration and track.duration > 0


def test_write_analysis_tags_reports_failure(tmp_path: Path):
    from kumodeck.tagging import TaggingError, write_analysis_tags

    with pytest.raises(TaggingError):
        write_analysis_tags(tmp_path / "missing.mp3", bpm=120.0)
    junk = tmp_path / "junk.xyz"
    junk.write_bytes(b"nope")
    with pytest.raises(TaggingError):
        write_analysis_tags(junk, bpm=120.0)


# ---------------------------------------------------------------- 并发


def test_concurrent_writes_do_not_lock(tmp_path: Path):
    """扫描线程 + 分析线程并发写是常态，WAL + busy_timeout 必须扛得住。"""
    service = LibraryService(Database(tmp_path / "concurrent.db"))
    files = []
    for i in range(40):
        f = tmp_path / f"t{i}.mp3"
        f.write_bytes(b"x" * (i + 1))
        files.append(f)

    errors: list[Exception] = []

    def worker(chunk):
        try:
            for f in chunk:
                service.upsert_file(f)
                service.list_tracks(q="t", limit=10)
                service.stats()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=(files[i::4],)) for i in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert service.stats().total == 40
    service.db.close_all()


# ---------------------------------------------------------------- (i) 文件夹模式


@pytest.fixture()
def roots(tmp_path: Path) -> list[Path]:
    """一个曲库根 + 两层子目录，模拟 DJ 的 set 目录结构。"""
    root = tmp_path / "djay"
    (root / "温州" / "encore").mkdir(parents=True)
    (root / "杭州").mkdir()
    return resolve_roots([str(root)])


def test_folder_tree_counts_recursively(service: LibraryService, roots: list[Path]):
    root = roots[0]
    insert(service, path=str(root / "杭州" / "a.mp3"), title="a")
    insert(service, path=str(root / "温州" / "b.mp3"), title="b")
    insert(service, path=str(root / "温州" / "encore" / "c.mp3"), title="c")
    insert(service, path=u("/somewhere/else/d.mp3"), title="d")

    tree = build_tree([str(root)], service.all_paths())
    assert len(tree.roots) == 1
    node = tree.roots[0]
    assert node.is_root and node.total_count == 3
    # 根目录本身没有直接躺着的曲目，但累计要把两级子目录都算上
    assert node.track_count == 0
    wenzhou = next(child for child in node.children if child.name == "温州")
    assert (wenzhou.track_count, wenzhou.total_count) == (1, 2)
    # 曲库目录之外的那一首必须被点出来，否则用户会以为丢了
    assert tree.outside == 1


def test_folder_filter_is_shallow_by_default(service: LibraryService, roots: list[Path]):
    root = roots[0]
    insert(service, path=str(root / "温州" / "b.mp3"), title="b")
    insert(service, path=str(root / "温州" / "encore" / "c.mp3"), title="c")

    shallow = service.list_tracks(folder=str(root / "温州"))
    assert [t.title for t in shallow.items] == ["b"]
    deep = service.list_tracks(folder=str(root / "温州"), folder_deep=True, sort="title", order="asc")
    assert [t.title for t in deep.items] == ["b", "c"]


def test_ensure_inside_rejects_traversal_and_siblings(tmp_path: Path, roots: list[Path]):
    root = roots[0]
    assert ensure_inside(str(root / "杭州"), roots) == root / "杭州"
    with pytest.raises(FolderError):
        ensure_inside(str(root / ".." / ".." / "etc"), roots)
    # 同前缀的兄弟目录：纯字符串前缀比较会放过它，is_relative_to 不会
    sibling = tmp_path / "djay-evil"
    sibling.mkdir()
    with pytest.raises(FolderError):
        ensure_inside(str(sibling), roots)


def test_ensure_inside_rejects_symlink_escape(tmp_path: Path, roots: list[Path]):
    """曲库里放一个指向外面的符号链接，也不能借它把文件搬出去。"""
    outside = tmp_path / "outside"
    outside.mkdir()
    trap = roots[0] / "trap"
    try:
        trap.symlink_to(outside, target_is_directory=True)
    except OSError:
        # Windows 上创建符号链接要开发者模式/管理员权限，环境不给就跳过——
        # 被测的 realpath 防线逻辑本身与平台无关
        pytest.skip("此环境不允许创建符号链接")
    with pytest.raises(FolderError):
        ensure_inside(str(trap), roots)


def test_unique_target_never_overwrites(tmp_path: Path):
    (tmp_path / "a.mp3").write_bytes(b"1")
    assert unique_target(tmp_path, "a.mp3").name == "a (2).mp3"
    (tmp_path / "a (2).mp3").write_bytes(b"2")
    assert unique_target(tmp_path, "a.mp3").name == "a (3).mp3"


def test_link_file_shares_one_inode(tmp_path: Path):
    source = tmp_path / "src" / "a.mp3"
    source.parent.mkdir()
    source.write_bytes(b"audio")
    dest = tmp_path / "dst"
    dest.mkdir()

    target, method = link_file(source, dest)
    assert method == "hardlink"
    assert target.stat().st_ino == source.stat().st_ino
    # 两端都该被认出来是链接，列表里才好打标记
    assert link_state(source) == "hardlink" and link_state(target) == "hardlink"


def test_relocate_keeps_analysis(service: LibraryService, tmp_path: Path):
    track_id = insert(service, title="keeper", bpm=128.0, camelot="8A", rating=4)
    moved = service.relocate(track_id, tmp_path / "new" / "keeper.mp3")
    assert moved.path == normalize_path(tmp_path / "new" / "keeper.mp3")
    assert moved.filename == "keeper.mp3"
    # 移动不改内容，分析结果和人工标记都不该丢
    assert (moved.bpm, moved.camelot, moved.rating) == (128.0, "8A", 4)


def test_clone_metadata_copies_analysis_and_tags(service: LibraryService):
    source = insert(service, title="orig", bpm=140.0, camelot="6A", rating=5)
    service.patch(source, TrackPatch(tags=["set-a"]))
    target = insert(service, path=u("/music/link.mp3"), title="link")

    service.clone_metadata(source, target)
    clone = service.get(target)
    assert clone is not None
    assert (clone.bpm, clone.camelot, clone.rating, clone.tags) == (140.0, "6A", 5, ["set-a"])


def test_rebase_paths_only_replaces_the_prefix(service: LibraryService):
    """目录名在路径里出现两次时，SQL 的 replace() 会改错，这里必须只换前缀。"""
    track_id = insert(service, path=u("/music/set1/set1/a.mp3"), title="a")
    changed = service.rebase_paths(Path(u("/music/set1")), Path(u("/music/set2")))
    assert changed == [track_id]
    moved = service.get(track_id)
    assert moved is not None and moved.path == u("/music/set2/set1/a.mp3")


def test_infer_roots_handles_two_separate_trees(tmp_path: Path, monkeypatch):
    """下载目录 + 自建歌单目录是常见布局，取公共祖先会退到家目录，必须分头推。"""
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    downloads = tmp_path / "Music" / "KumoDeck" / "netease"
    sets = tmp_path / "git" / "djay" / "温州"
    downloads.mkdir(parents=True)
    sets.mkdir(parents=True)

    roots = infer_roots([str(downloads / "a.mp3"), str(sets / "b.mp3")])
    assert roots == sorted([tmp_path / "Music" / "KumoDeck", tmp_path / "git" / "djay"])


def test_infer_roots_stops_at_home(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    music = tmp_path / "Music"
    music.mkdir()
    # 歌直接躺在 ~/Music 下时，再往上就是家目录了，只能拿 ~/Music 当根
    assert infer_roots([str(music / "a.mp3")]) == [music]


def test_manifest_controls_child_order(roots: list[Path]):
    root = roots[0]
    (root / "7yue").mkdir()
    # 磁盘上是 7yue / 杭州 / 温州，清单里指定成另一个顺序
    write_manifest(root, ["温州", "杭州", "7yue"])
    tree = build_tree([str(root)], [])
    assert [child.name for child in tree.roots[0].children] == ["温州", "杭州", "7yue"]
    assert tree.roots[0].managed is True


def test_apply_order_drops_stale_and_appends_new(roots: list[Path]):
    root = roots[0]
    (root / "新建").mkdir()
    # "已删除" 在清单里但磁盘上没有；"新建" 在磁盘上但清单里没有
    ordered = apply_order(root, ["温州", "已删除", "杭州"])
    assert ordered[:2] == ["温州", "杭州"]
    assert ordered[2:] == ["新建"]


def test_init_manifests_is_idempotent_and_recursive(roots: list[Path]):
    root = roots[0]
    created = init_manifests(root, roots)
    # djay / 温州 / 温州-encore / 杭州 共 4 层目录
    assert created == 4
    assert (root / MANIFEST_NAME).is_file()
    assert (root / "温州" / "encore" / MANIFEST_NAME).is_file()
    # 再跑一次不该覆盖已排好的顺序
    write_manifest(root, ["杭州", "温州"])
    assert init_manifests(root, roots) == 0
    assert read_manifest(root)["order"] == ["杭州", "温州"]


def test_broken_manifest_falls_back_to_name_order(roots: list[Path]):
    root = roots[0]
    (root / MANIFEST_NAME).write_text("{ this is not json", "utf-8")
    tree = build_tree([str(root)], [])
    # 清单坏了只该丢掉顺序，不该让整棵树打不开
    assert [child.name for child in tree.roots[0].children] == ["杭州", "温州"]


def test_move_folder_rejects_self_and_root_and_duplicates(roots: list[Path]):
    root = roots[0]
    with pytest.raises(FolderError):
        move_folder(str(root), str(root / "杭州"), roots)          # 根目录不能搬
    with pytest.raises(FolderError):
        move_folder(str(root / "温州"), str(root / "温州" / "encore"), roots)  # 搬进自己里
    (root / "杭州" / "温州").mkdir()
    with pytest.raises(FolderError):
        move_folder(str(root / "温州"), str(root / "杭州"), roots)  # 目标下同名，不静默合并


def test_move_folder_moves_the_whole_subtree(roots: list[Path]):
    root = roots[0]
    (root / "温州" / "encore" / "a.mp3").write_bytes(b"x")
    old, new = move_folder(str(root / "温州"), str(root / "杭州"), roots)
    assert old == root / "温州" and new == root / "杭州" / "温州"
    assert (new / "encore" / "a.mp3").is_file()
    assert not (root / "温州").exists()


def test_count_audio_files_ignores_dirs_and_dotfiles(roots: list[Path]):
    d = roots[0] / "杭州"
    (d / "a.mp3").write_bytes(b"x")
    (d / "b.flac").write_bytes(b"x")
    (d / "note.txt").write_bytes(b"x")
    (d / ".hidden.mp3").write_bytes(b"x")
    assert count_audio_files(d) == 2


def test_tree_reports_pending_files(service: LibraryService, roots: list[Path]):
    root = roots[0]
    (root / "温州" / "a.mp3").write_bytes(b"x")
    (root / "温州" / "b.mp3").write_bytes(b"x")
    insert(service, path=str(root / "温州" / "a.mp3"), title="a")
    tree = build_tree([str(root)], service.all_paths())
    wenzhou = next(c for c in tree.roots[0].children if c.name == "温州")
    # 磁盘上 2 个、库里 1 首 → 还有 1 个待导入
    assert (wenzhou.file_count, wenzhou.track_count, wenzhou.pending_count) == (2, 1, 1)
    assert tree.roots[0].pending_count == 1


def test_resolve_roots_drops_nested_duplicates(roots: list[Path]):
    root = roots[0]
    # 子目录被误登记成根时，只保留最外层的那个，否则树上会出现两份
    resolved = resolve_roots([str(root), str(root / "温州"), str(root / "杭州")])
    assert resolved == [root]
