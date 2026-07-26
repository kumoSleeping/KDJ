#!/usr/bin/env python3
"""端到端冒烟：真起一个 sidecar 进程，把契约里的每条路由都打一遍。

不碰真实平台账号（未登录时搜索会失败，这是预期的，脚本只判断"路由存在且返回结构对"）。
用法：
    sidecar/.venv/bin/python scripts/smoke.py
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "sidecar"
PYTHON = SIDECAR / ".venv" / "bin" / "python"

PASS, FAIL, SKIP = "\033[32m✓\033[0m", "\033[31m✗\033[0m", "\033[33m-\033[0m"
results: list[tuple[str, str, str]] = []


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def call(base: str, token: str, method: str, path: str, body: object = None):
    data = json.dumps(body).encode() if body is not None else None
    request = Request(f"{base}/api{path}", data=data, method=method)
    request.add_header("X-KumoDeck-Token", token)
    if data:
        request.add_header("Content-Type", "application/json")
    with urlopen(request, timeout=30) as response:
        raw = response.read().decode()
        return response.status, (json.loads(raw) if raw else None)


def check(name: str, fn) -> None:
    try:
        detail = fn()
        results.append((PASS, name, detail or ""))
    except HTTPError as exc:
        payload = exc.read().decode()[:160]
        results.append((FAIL, name, f"HTTP {exc.code} {payload}"))
    except Exception as exc:  # noqa: BLE001 — 冒烟脚本要吞掉一切并继续
        results.append((FAIL, name, f"{type(exc).__name__}: {exc}"))


def main() -> int:
    if not PYTHON.exists():
        print(f"缺少 sidecar venv：{PYTHON}\n先跑 npm run sidecar:setup")
        return 2

    port = free_port()
    token = secrets.token_hex(16)
    base = f"http://127.0.0.1:{port}"
    workdir = Path(tempfile.mkdtemp(prefix="kumodeck-smoke-"))

    process = subprocess.Popen(
        [
            str(PYTHON), "-u", "-m", "kumodeck",
            "--host", "127.0.0.1", "--port", str(port), "--token", token,
            "--data-dir", str(workdir / "data"),
            "--download-dir", str(workdir / "downloads"),
        ],
        cwd=SIDECAR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONUTF8": "1"},
        text=True,
    )

    try:
        deadline = time.time() + 40
        ready = False
        while time.time() < deadline:
            if process.poll() is not None:
                print("sidecar 启动即退出：\n" + (process.stdout.read() if process.stdout else ""))
                return 1
            try:
                urlopen(f"{base}/api/health", timeout=2).read()
                ready = True
                break
            except (URLError, HTTPError, TimeoutError):
                time.sleep(0.3)
        if not ready:
            print("sidecar 健康检查超时")
            return 1

        check("GET  /health", lambda: str(call(base, token, "GET", "/health")[1]))
        check("鉴权：无 token 应 401", lambda: _expect_unauthorized(base))
        check("GET  /settings", lambda: str(call(base, token, "GET", "/settings")[1])[:80])
        check("GET  /accounts", lambda: f"{len(call(base, token, 'GET', '/accounts')[1])} 个平台")
        check("GET  /downloads", lambda: f"{len(call(base, token, 'GET', '/downloads')[1])} 条")
        check("POST /downloads/clear", lambda: str(call(base, token, "POST", "/downloads/clear")[1]))
        check("GET  /library/tracks", lambda: f"total={call(base, token, 'GET', '/library/tracks')[1]['total']}")
        check("GET  /library/stats", lambda: str(call(base, token, "GET", "/library/stats")[1])[:80])
        check(
            "POST /library/scan（空目录）",
            lambda: str(call(base, token, "POST", "/library/scan", {"paths": [str(workdir)], "recursive": True})[1]),
        )
        check("文件夹：树 / 新建 / 移动 / 链接", lambda: _folders(base, token, workdir))
        check(
            "POST /library/analyze（无待分析）",
            lambda: str(call(base, token, "POST", "/library/analyze", {"track_ids": None, "force": False})[1]),
        )
        check(
            "POST /search（未登录也应返回结构）",
            lambda: _search(base, token),
        )
        check("POST /intake（多行批量）", lambda: _intake(base, token))
        check("POST /intake（空文本应 400）", lambda: _intake_empty(base, token))
        # WS 单独测：只打 HTTP 的话，uvicorn 缺 websockets 依赖这种问题会一路沉默到 UI 上
        check("WS   /ws 应推 download.list", lambda: _ws(port, token))
        check("WS   /ws 错 token 应拒绝", lambda: _ws_bad_token(port))
        check("POST /accounts/wyy/login/qr", lambda: _qr(base, token, "wyy"))
        check("POST /accounts/qqm/login/qr", lambda: _qr(base, token, "qqm"))
        check("POST /accounts/bilibili/login/qr", lambda: _qr(base, token, "bilibili"))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()

    print()
    for mark, name, detail in results:
        print(f"  {mark} {name:38} {detail}")
    failed = sum(1 for mark, _, _ in results if mark == FAIL)
    print(f"\n{len(results) - failed}/{len(results)} 通过\n")
    return 1 if failed else 0


def _expect_unauthorized(base: str) -> str:
    try:
        urlopen(Request(f"{base}/api/settings"), timeout=5)
    except HTTPError as exc:
        if exc.code in (401, 403):
            return f"HTTP {exc.code}"
        raise
    raise AssertionError("没有 token 也放行了")


def _search(base: str, token: str) -> str:
    _, payload = call(
        base, token, "POST", "/search",
        {"query": "Ave Mujica", "platforms": ["wyy", "qqm"], "limit": 5, "merge": True},
    )
    return f"{len(payload['groups'])} 组 / errors={list(payload['errors'])}"


def _folders(base: str, token: str, workdir: Path) -> str:
    """整条文件夹链路：扫描登记根目录 → 建子目录 → 移动 → 链接 → 越界被挡。

    单元测试盖的是纯函数，这里盖的是"路由 + 真实文件系统 + 数据库"三者接在一起
    还成不成立——WS 那次事故就是只测了单元、没测接缝。
    """
    # 上面那步 scan 已经把 workdir 登记成曲库根目录了，这里放一个文件再扫一次
    (workdir / "seed.mp3").write_bytes(b"not really audio")
    call(base, token, "POST", "/library/scan", {"paths": [str(workdir)], "recursive": True})
    for _ in range(40):
        _, page = call(base, token, "GET", "/library/tracks")
        if page["total"] > 0:
            break
        time.sleep(0.25)
    else:
        raise AssertionError("扫描没把 seed.mp3 入库")
    track_id = page["items"][0]["id"]

    _, tree = call(base, token, "GET", "/library/folders")
    if not tree["roots"]:
        raise AssertionError("扫描过的目录没有变成曲库根")

    root = tree["roots"][0]["path"]
    call(base, token, "POST", "/library/folders/create", {"parent": root, "name": "set1"})
    dest = str(Path(root) / "set1")

    _, moved = call(
        base, token, "POST", "/library/folders/apply",
        {"track_ids": [track_id], "dest": dest, "op": "move"},
    )
    if moved["track_ids"] != [track_id] or not (Path(dest) / "seed.mp3").is_file():
        raise AssertionError(f"移动没落到磁盘上：{moved}")

    call(base, token, "POST", "/library/folders/create", {"parent": root, "name": "set2"})
    dest2 = str(Path(root) / "set2")
    _, linked = call(
        base, token, "POST", "/library/folders/apply",
        {"track_ids": [track_id], "dest": dest2, "op": "link"},
    )
    if not linked["track_ids"] or "hardlink" not in linked["methods"]:
        raise AssertionError(f"链接没走硬链接：{linked}")

    try:
        call(base, token, "POST", "/library/folders/apply",
             {"track_ids": [track_id], "dest": "/tmp", "op": "move"})
    except HTTPError as exc:
        if exc.code != 400:
            raise
    else:
        raise AssertionError("往曲库外面搬文件竟然放行了")

    # 扫子目录不该把它也登记成曲库根：那样它会在树上同时以"根"和"子节点"出现
    call(base, token, "POST", "/library/scan", {"paths": [dest2], "recursive": True})
    _, tree2 = call(base, token, "GET", "/library/folders")
    if len(tree2["roots"]) != len(tree["roots"]):
        raise AssertionError(f"扫子目录多登记了一个根：{[r['path'] for r in tree2['roots']]}")

    _, after = call(base, token, "GET", "/library/tracks?folder=" + quote(dest2))
    return f"move+link ok，{after['total']} 首在 set2，子目录不重复登记，越界被 400"


def _intake(base: str, token: str) -> str:
    """三行输入应该原样变成三个 item，顺序保持。"""
    _, payload = call(
        base, token, "POST", "/intake",
        {
            "text": "Ave Mujica\nFive More Hours\nhttps://example.invalid/not-a-real-link",
            "platforms": ["wyy", "qqm"],
            "limit": 5,
            "merge": True,
        },
    )
    items = payload["items"]
    assert len(items) == 3, f"应拆出 3 条，实际 {len(items)}"
    assert items[2]["kind"] == "error", "无法识别的链接应标成 error 而不是整批失败"
    kinds = "/".join(item["kind"] for item in items)
    return f"{len(items)} 条 [{kinds}] / 共 {sum(len(i['groups']) for i in items)} 首"


def _intake_empty(base: str, token: str) -> str:
    try:
        call(base, token, "POST", "/intake", {"text": "   \n  \n"})
    except HTTPError as exc:
        if exc.code == 400:
            return "HTTP 400"
        raise
    raise AssertionError("空文本也放行了")


def _ws(port: int, token: str) -> str:
    """连上就应该收到一条全量 download.list（契约 2.3 节）。"""
    from websockets.sync.client import connect

    # proxy=None：websockets 14+ 会读 ALL_PROXY，把发往 127.0.0.1 的连接也塞进 SOCKS 代理
    with connect(f"ws://127.0.0.1:{port}/ws?token={token}", open_timeout=10, proxy=None) as socket:
        payload = json.loads(socket.recv(timeout=10))
    assert payload["type"] == "download.list", f"首帧不是 download.list：{payload['type']}"
    return f"首帧 {payload['type']} / {len(payload['payload'])} 条"


def _ws_bad_token(port: int) -> str:
    from websockets.exceptions import InvalidStatus, WebSocketException
    from websockets.sync.client import connect

    try:
        with connect(f"ws://127.0.0.1:{port}/ws?token=wrong", open_timeout=10, proxy=None) as socket:
            socket.recv(timeout=5)
    except (InvalidStatus, WebSocketException, OSError) as exc:
        return f"已拒绝（{type(exc).__name__}）"
    raise AssertionError("错误 token 也放行了")


def _qr(base: str, token: str, platform: str) -> str:
    _, payload = call(base, token, "POST", f"/accounts/{platform}/login/qr")
    image = payload.get("image", "")
    assert image.startswith("data:image/"), "二维码不是 data URL"
    _, state = call(base, token, "GET", f"/accounts/{platform}/login/qr/{payload['session_id']}")
    return f"{len(image)}B 图 / state={state['state']}"


if __name__ == "__main__":
    sys.exit(main())
