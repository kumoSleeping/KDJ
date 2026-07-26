"""所有 HTTP / WS 出入参模型。

这是前后端契约（对应 `src/types.ts`），字段名两边必须一一对应。
改这里必须同步改 `src/types.ts` 和 `docs/00-architecture.md`。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

Platform = Literal["wyy", "qqm", "soundcloud", "bilibili", "local"]
Quality = Literal["flac", "320", "128"]
TaskState = Literal["queued", "running", "done", "failed", "canceled"]
AccountState = Literal["missing", "valid", "expired", "unknown"]
QrStateValue = Literal["waiting", "scanned", "done", "expired", "refused", "error"]


# ---------------------------------------------------------------- 基础


class Health(BaseModel):
    ok: bool = True
    version: str
    ffmpeg: bool
    data_dir: str
    download_dir: str


VideoFormat = Literal["mp4", "mkv", "mov"]


class Settings(BaseModel):
    download_dir: str
    library_dirs: list[str] = Field(default_factory=list)
    default_quality: Quality = "flac"
    filename_template: str = "{title} - {artist}"
    concurrent_downloads: int = 3
    auto_analyze: bool = True
    write_tags_after_analyze: bool = False
    analysis_duration: float = 240.0
    theme: Literal["light", "dark", "system"] = "dark"
    soundcloud_enabled: bool = False
    netease_use_download_api: bool = False
    video_max_height: int = 1080
    video_transcode: bool = False
    # 视频单独一个下载目录：视频动辄几百 MB，混进音乐目录会把曲库扫描搅乱
    video_download_dir: str = Field(default_factory=lambda: str(Path.home() / "Downloads" / "KumoDeck"))
    video_format: VideoFormat = "mp4"
    # 平台按钮的显示顺序 = 下载来源优先级（前端拖动排序后存这里）
    platform_priority: list[str] = Field(
        default_factory=lambda: ["wyy", "qqm", "soundcloud", "bilibili"]
    )
    # 入队后是否立刻开始下载。DJ 常常先攒一批再统一下，默认攒着。
    auto_start_downloads: bool = False


# ---------------------------------------------------------------- 账号


class Account(BaseModel):
    platform: Platform
    label: str
    state: AccountState
    nickname: str = ""
    avatar: str = ""
    detail: str = ""
    # SoundCloud 走 yt-dlp，没有扫码登录这回事。前端据此决定要不要显示登录按钮——
    # 硬编码平台名单迟早和后端漂移，所以让 provider 自己声明。
    supports_login: bool = True


class QrSession(BaseModel):
    platform: Platform
    session_id: str
    image: str  # data:image/png;base64,...
    url: str = ""
    expires_in: int = 180


class QrState(BaseModel):
    session_id: str
    state: QrStateValue
    message: str = ""
    account: Account | None = None


# ---------------------------------------------------------------- 搜索


class SongSource(BaseModel):
    """一首歌在某个平台上的具体来源。"""

    platform: Platform
    key: str
    title: str
    artists: list[str] = Field(default_factory=list)
    album: str = ""
    duration: float | None = None  # 秒
    cover: str = ""
    max_quality: Quality | None = None
    vip: bool = False
    payload: dict[str, Any] = Field(default_factory=dict)  # 回传给下载接口的原始数据

    @property
    def artist_text(self) -> str:
        return ", ".join(self.artists) if self.artists else "Unknown"


class MergedGroup(BaseModel):
    """混合搜索聚合出来的一首歌（跨平台去重后的结果）。"""

    group_id: str
    title: str
    artists: list[str] = Field(default_factory=list)
    album: str = ""
    duration: float | None = None
    cover: str = ""
    sources: list[SongSource] = Field(default_factory=list)
    best_source_index: int = 0
    score: float = 0.0
    in_library: bool = False


class SearchRequest(BaseModel):
    query: str
    platforms: list[Platform] = Field(default_factory=lambda: ["wyy", "qqm"])
    limit: int = 20
    merge: bool = True


class SearchResponse(BaseModel):
    query: str
    groups: list[MergedGroup] = Field(default_factory=list)
    per_platform: dict[str, list[SongSource]] = Field(default_factory=dict)
    errors: dict[str, str] = Field(default_factory=dict)
    elapsed_ms: float = 0.0


class ResolveRequest(BaseModel):
    url: str
    limit: int = 500


class ResolveResponse(BaseModel):
    kind: Literal["song", "playlist", "album", "unknown"]
    platform: Platform
    title: str
    sources: list[SongSource] = Field(default_factory=list)


# ---------------------------------------------------------------- 批量投喂


IntakeKind = Literal["search", "song", "playlist", "album", "unknown", "error"]


class IntakeRequest(BaseModel):
    """一大段文本进来，按行/逗号拆开，逐条决定是搜索还是解析链接。"""

    text: str
    platforms: list[Platform] = Field(default_factory=lambda: ["wyy", "qqm"])
    limit: int = 20
    merge: bool = True
    max_entries: int = 50


class IntakeItem(BaseModel):
    """一条输入对应的结果。歌单/专辑是一个"包"，关键词搜索是一组候选。"""

    entry: str  # 拆出来的原始文本（链接或关键词）
    kind: IntakeKind
    platform: Platform | None = None
    title: str = ""
    groups: list[MergedGroup] = Field(default_factory=list)
    errors: dict[str, str] = Field(default_factory=dict)
    error: str = ""


class IntakeResponse(BaseModel):
    items: list[IntakeItem] = Field(default_factory=list)
    skipped: int = 0  # 超出 max_entries 被丢掉的条数
    elapsed_ms: float = 0.0


# ---------------------------------------------------------------- 下载


class DownloadRequest(BaseModel):
    sources: list[SongSource]
    quality: Quality | None = None
    analyze: bool | None = None  # None = 跟随设置


class DownloadTask(BaseModel):
    id: str
    kind: Literal["audio", "video"] = "audio"
    platform: Platform
    title: str
    artist: str = ""
    quality: str = ""
    state: TaskState = "queued"
    progress: float = 0.0  # 0..1
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    path: str = ""
    error: str = ""
    track_id: int | None = None
    created_at: float = 0.0
    updated_at: float = 0.0


# ---------------------------------------------------------------- 视频


class VideoPage(BaseModel):
    index: int
    title: str
    duration: int


class VideoStreamOption(BaseModel):
    quality_id: int
    label: str
    height: int
    codec: str = ""


class VideoInfo(BaseModel):
    bvid: str
    title: str
    author: str = ""
    cover: str = ""
    duration: int = 0
    pages: list[VideoPage] = Field(default_factory=list)
    options: list[VideoStreamOption] = Field(default_factory=list)
    logged_in: bool = False


class VideoDownloadRequest(BaseModel):
    url: str = ""
    bvid: str = ""
    page_index: int = 0
    max_height: int = 1080
    audio_only: bool = False
    transcode: bool = False


# ---------------------------------------------------------------- 曲库


class Track(BaseModel):
    id: int
    path: str
    filename: str
    title: str = ""
    artist: str = ""
    album: str = ""
    genre: str = ""
    year: str = ""
    duration: float | None = None
    bitrate: int | None = None
    samplerate: int | None = None
    channels: int | None = None
    format: str = ""
    size: int = 0
    bpm: float | None = None
    bpm_confidence: float | None = None
    first_beat: float | None = None
    music_key: str = ""
    camelot: str = ""
    open_key: str = ""
    key_confidence: float | None = None
    energy: int | None = None
    rms_db: float | None = None
    peak_db: float | None = None
    rating: int = 0
    color: str = ""
    comment: str = ""
    cue_ms: int | None = None
    source_platform: str = "local"
    source_key: str = ""
    analyzed_at: str | None = None
    added_at: str = ""
    modified_at: str = ""
    analysis_error: str = ""
    tags: list[str] = Field(default_factory=list)
    # 所在目录（= path 的父目录），前端文件夹树按它归位，省得在前端切字符串
    folder: str = ""
    # ""=普通文件，"hardlink"/"symlink"=和别处共用同一份数据
    link: str = ""


class TrackPage(BaseModel):
    items: list[Track] = Field(default_factory=list)
    total: int = 0
    offset: int = 0
    limit: int = 200


class TrackPatch(BaseModel):
    rating: int | None = None
    color: str | None = None
    comment: str | None = None
    cue_ms: int | None = None
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    genre: str | None = None
    tags: list[str] | None = None


class ScanRequest(BaseModel):
    paths: list[str] = Field(default_factory=list)
    recursive: bool = True
    analyze: bool = False


class ScanResponse(BaseModel):
    job_id: str
    found: int = 0


class AnalyzeRequest(BaseModel):
    track_ids: list[int] | None = None
    force: bool = False
    # 走插队通道（单独一条线程），给"正在放的这首"用，不必等批量跑完
    priority: bool = False


class AnalyzeResponse(BaseModel):
    job_id: str
    queued: int = 0


class HarmonicMatch(BaseModel):
    track: Track
    # 和 service.RELATION_LABELS 一一对应，加关系必须两边一起改，
    # 否则新关系会在这里被 pydantic 打回，整条推荐接口 500。
    relation: Literal[
        "same", "energy_up", "energy_down", "relative", "energy_boost", "two_step", "diagonal"
    ]
    relation_label: str
    bpm_delta: float
    tempo_ratio: float = 1.0
    score: float = 0.0


class FolderNode(BaseModel):
    path: str
    name: str
    parent: str = ""
    # 该目录下直接躺着的曲目数
    track_count: int = 0
    # 含所有子目录的曲目数
    total_count: int = 0
    # 这一层目录里实际躺着几个音频文件。> track_count 说明还没扫进曲库
    file_count: int = 0
    # 含子目录的未入库文件数
    pending_count: int = 0
    children: list["FolderNode"] = Field(default_factory=list)
    is_root: bool = False
    # 目录里有 .kumodeck.json（顺序已受管），false = 还没初始化，按名字排
    managed: bool = False


class FolderTree(BaseModel):
    roots: list[FolderNode] = Field(default_factory=list)
    # 落在所有曲库根目录之外的曲目数（比如下载目录还没加进曲库目录）
    outside: int = 0


FileOp = Literal["move", "link"]


class FolderOpRequest(BaseModel):
    track_ids: list[int] = Field(default_factory=list)
    dest: str
    op: FileOp = "move"


class FolderOpResult(BaseModel):
    # move：被改了路径的曲目 id；link：新建出来的曲目 id
    track_ids: list[int] = Field(default_factory=list)
    op: FileOp = "move"
    # 实际用的链接方式统计，例如 {"hardlink": 3, "copy": 1}
    methods: dict[str, int] = Field(default_factory=dict)
    errors: dict[str, str] = Field(default_factory=dict)


class FolderCreateRequest(BaseModel):
    parent: str
    name: str


class FolderRenameRequest(BaseModel):
    path: str
    name: str


class FolderDeleteRequest(BaseModel):
    path: str


class FolderMoveRequest(BaseModel):
    """把 path 这个文件夹整个搬进 dest_parent。"""

    path: str
    dest_parent: str


class FolderOrderRequest(BaseModel):
    """把 path 下的子目录顺序改成 names 给的顺序，落进 path/.kumodeck.json。"""

    path: str
    names: list[str] = Field(default_factory=list)


class FolderInitRequest(BaseModel):
    """给 path 及其子目录补上 .kumodeck.json。省略 path = 所有曲库根。"""

    path: str = ""


class LibraryStats(BaseModel):
    total: int = 0
    analyzed: int = 0
    total_duration: float = 0.0
    total_size: int = 0
    by_camelot: dict[str, int] = Field(default_factory=dict)
    by_bpm_bucket: dict[str, int] = Field(default_factory=dict)
    by_platform: dict[str, int] = Field(default_factory=dict)
