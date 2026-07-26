"""运行期配置：AppConfig = models.Settings 的全部字段 + 进程级参数（目录/token/监听地址）。

settings.json 落在 data_dir 下。读写规则：
- 读：缺字段用默认值补齐（老版本配置文件升级后仍然能用）；单个字段值非法只丢弃这个字段，
  不能让整份配置作废（用户改坏一个字段不至于把设置全部重置）。
- 写：先写 `.tmp` 再 `os.replace` 原子替换——直接覆写时如果进程在中途被 kill，
  留下的是半截 JSON，下次启动直接解析失败。
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .models import Settings

logger = logging.getLogger("kumodeck.config")

SETTINGS_FILENAME = "settings.json"
DB_FILENAME = "kumodeck.db"

# 从 pydantic 模型反推字段列表，避免 models.py 加字段时这里漏改。
_SETTINGS_FIELDS: tuple[str, ...] = tuple(Settings.model_fields.keys())


@dataclass
class AppConfig:
    """进程内唯一的一份配置。

    注意 `download_dir` 在这里是 Path，在 Settings 里是 str，转换只发生在 to_settings /
    apply_settings 两个边界上。
    """

    data_dir: Path
    download_dir: Path
    token: str = ""
    host: str = "127.0.0.1"
    port: int = 8788

    # ---- 以下与 models.Settings 一一对应（download_dir 见上）----
    library_dirs: list[str] = field(default_factory=list)
    default_quality: str = "flac"
    filename_template: str = "{title} - {artist}"
    concurrent_downloads: int = 3
    auto_analyze: bool = True
    write_tags_after_analyze: bool = False
    analysis_duration: float = 240.0
    theme: str = "dark"
    soundcloud_enabled: bool = False
    netease_use_download_api: bool = False
    video_max_height: int = 1080
    video_transcode: bool = False
    # 和 models.Settings 保持同一个默认值，否则首次启动写出的 settings.json
    # 会带一个空串，UI 上就是一个空输入框。
    video_download_dir: str = field(
        default_factory=lambda: str(Path.home() / "Downloads" / "KumoDeck")
    )
    video_format: str = "mp4"
    # 平台按钮顺序 = 来源优先级；入队默认不直接开跑（攒一批统一下）
    platform_priority: list[str] = field(
        default_factory=lambda: ["wyy", "qqm", "soundcloud", "bilibili"]
    )
    auto_start_downloads: bool = False

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir).expanduser()
        self.download_dir = Path(self.download_dir).expanduser()
        # 设置可能被 HTTP 线程改、被下载线程读，加锁保证读到的是一致的一组值。
        self._lock = threading.RLock()

    # ------------------------------------------------------------ 派生路径

    @property
    def settings_path(self) -> Path:
        return self.data_dir / SETTINGS_FILENAME

    @property
    def db_path(self) -> Path:
        return self.data_dir / DB_FILENAME

    @property
    def sessions_dir(self) -> Path:
        return self.data_dir / "sessions"

    @property
    def video_dir(self) -> Path:
        """视频下载目录。留空 = 跟随音频下载目录（老配置升上来就是这种情况）。"""
        raw = (self.video_download_dir or "").strip()
        return Path(raw).expanduser() if raw else self.download_dir

    # ------------------------------------------------------------ 构造

    @classmethod
    def create(
        cls,
        *,
        data_dir: str | Path,
        download_dir: str | Path,
        token: str = "",
        host: str = "127.0.0.1",
        port: int = 8788,
    ) -> AppConfig:
        """命令行参数 → AppConfig，并把 settings.json 叠加上来。

        命令行给的 download_dir 只是**默认值**：用户在设置界面改过之后，
        settings.json 里的值优先，否则每次启动都会被 Electron 传的默认目录覆盖回去。
        """
        config = cls(
            data_dir=Path(data_dir),
            download_dir=Path(download_dir),
            token=token,
            host=host,
            port=port,
        )
        config.ensure_dirs()
        config.load()
        config.ensure_dirs()
        return config

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.sessions_dir, self.download_dir, self.video_dir):
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                logger.warning("创建目录失败 %s：%s", path, exc)

    # ------------------------------------------------------------ 读写

    def to_settings(self) -> Settings:
        with self._lock:
            data: dict[str, Any] = {name: getattr(self, name) for name in _SETTINGS_FIELDS}
            data["download_dir"] = str(self.download_dir)
            # list 要复制，否则调用方拿到的是同一个对象，改它等于改配置。
            data["library_dirs"] = list(self.library_dirs)
        return Settings.model_validate(data)

    def apply_settings(self, settings: Settings) -> Settings:
        """用一份完整 Settings 覆盖当前配置并落盘。"""
        with self._lock:
            for name in _SETTINGS_FIELDS:
                if name == "download_dir":
                    continue
                setattr(self, name, getattr(settings, name))
            self.library_dirs = list(settings.library_dirs)
            self.download_dir = Path(settings.download_dir).expanduser()
        self.ensure_dirs()
        self.save()
        return self.to_settings()

    def load(self) -> None:
        """从 settings.json 覆盖当前值；文件不存在 / 损坏时保持默认值。"""
        path = self.settings_path
        if not path.exists():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning("settings.json 读取失败，使用默认设置：%s", exc)
            return
        if not isinstance(raw, dict):
            logger.warning("settings.json 不是对象，忽略")
            return

        base = self.to_settings().model_dump()
        candidate = dict(base)
        for name in _SETTINGS_FIELDS:
            if name in raw and raw[name] is not None:
                candidate[name] = raw[name]

        try:
            settings = Settings.model_validate(candidate)
        except Exception:
            # 整份校验失败时逐字段重试：老版本写进去的非法枚举值（比如已经下线的音质档）
            # 不应该把用户其他设置一起清空。
            settings = self._merge_field_by_field(base, raw)

        with self._lock:
            for name in _SETTINGS_FIELDS:
                if name == "download_dir":
                    continue
                setattr(self, name, getattr(settings, name))
            self.library_dirs = list(settings.library_dirs)
            self.download_dir = Path(settings.download_dir).expanduser()

    def _merge_field_by_field(self, base: dict[str, Any], raw: dict[str, Any]) -> Settings:
        current = dict(base)
        for name in _SETTINGS_FIELDS:
            if name not in raw or raw[name] is None:
                continue
            probe = dict(current)
            probe[name] = raw[name]
            try:
                Settings.model_validate(probe)
            except Exception as exc:
                logger.warning("settings.json 字段 %s 非法，已忽略：%s", name, exc)
                continue
            current = probe
        return Settings.model_validate(current)

    def save(self) -> None:
        settings = self.to_settings()
        path = self.settings_path
        tmp = path.with_name(path.name + ".tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(
                json.dumps(settings.model_dump(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp, path)
        except OSError as exc:
            logger.warning("settings.json 写入失败：%s", exc)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
