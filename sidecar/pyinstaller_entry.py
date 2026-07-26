"""PyInstaller 打包入口。

为什么不直接把 .venv 塞进安装包：venv 不可搬迁（python 二进制是指向构建机
解释器的符号链接、脚本 shebang 写死绝对路径），装到用户机器上必坏。
CI 里用 PyInstaller 把 sidecar 连同解释器冻结成独立可执行（onedir），
Electron 打包时作为 extraResources 带上，主进程直接 spawn 它（见
electron/main.ts 的 sidecarCommand）。命令行参数和 `python -m kumodeck` 完全一致。
"""

import multiprocessing
import sys

from kumodeck.__main__ import main

if __name__ == "__main__":
    # Windows 下 PyInstaller 的子进程会重新跑一遍入口，不加这行会无限自我复制
    multiprocessing.freeze_support()
    sys.exit(main())
