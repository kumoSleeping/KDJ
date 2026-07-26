"""KumoDeck sidecar —— 多平台音乐/视频下载 + DJ 曲库分析的本地服务。

只在这里放版本号等零依赖常量：本模块会被 `python -m kumodeck` 最先导入，
一旦在这里 import 重量级模块（fastapi/numpy），CLI 的 `--help` 都要等好几秒。
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
