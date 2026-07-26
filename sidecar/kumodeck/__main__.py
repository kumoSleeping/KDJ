"""命令行入口：`python -m kumodeck --host 127.0.0.1 --port 8788 --token xxx ...`

由 Electron 主进程拉起（见 electron/main.ts），端口和 token 都是它随机生成后传进来的。
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from . import __version__


def _default_data_dir() -> Path:
    return Path(os.environ.get("KUMODECK_DATA_DIR") or (Path.home() / ".kumodeck" / "data"))


def _default_download_dir() -> Path:
    return Path(os.environ.get("KUMODECK_DOWNLOAD_DIR") or (Path.home() / "Music" / "KumoDeck"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kumodeck", description="KumoDeck sidecar")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认只听本机）")
    parser.add_argument("--port", type=int, default=8788, help="监听端口")
    parser.add_argument("--token", default="", help="访问令牌，所有请求都要带 X-KumoDeck-Token")
    parser.add_argument("--data-dir", default=str(_default_data_dir()), help="数据目录")
    parser.add_argument("--download-dir", default=str(_default_download_dir()), help="下载目录")
    parser.add_argument("--log-level", default="info", help="uvicorn 日志级别")
    parser.add_argument("--version", action="version", version=f"kumodeck {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # 重量级 import 放在 argparse 之后：`--help` / `--version` 不该等 numpy 和 fastapi 加载。
    import uvicorn

    from .app import create_app
    from .config import AppConfig

    config = AppConfig.create(
        data_dir=args.data_dir,
        download_dir=args.download_dir,
        token=args.token,
        host=args.host,
        port=args.port,
    )
    app = create_app(config)

    # Electron 靠轮询 /api/health 判断就绪，这行主要是给开发时看日志用的。
    print(f"kumodeck sidecar ready on http://{config.host}:{config.port}", flush=True)

    uvicorn.run(app, host=config.host, port=config.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    sys.exit(main())
