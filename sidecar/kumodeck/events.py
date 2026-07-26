"""EventHub：把工作线程产生的事件广播给所有 WebSocket 连接。

## 这里最容易写错的地方：跨线程边界

WebSocket 活在 uvicorn 的 asyncio 事件循环里，而下载 / 扫描 / 分析全部跑在**工作线程**
（ThreadPoolExecutor / threading.Thread）里。`asyncio.Queue` 不是线程安全的，
在工作线程里直接 `queue.put_nowait()` 看着能跑，但唤醒不了在事件循环里 `await get()`
的协程——表现就是"事件发了，前端收不到"，而且只在有并发时偶发。

正确做法只有一条：**任何来自非事件循环线程的投递，都必须经过
`loop.call_soon_threadsafe()`**（这是 asyncio 里少数几个显式声明线程安全的 API）。
所以流程是：

    工作线程                          事件循环线程
    publish(type, payload)
      ├─ json.dumps（在调用方线程做，别占着事件循环干序列化）
      └─ loop.call_soon_threadsafe(_fanout, msg) ──▶ _fanout(msg)
                                                       ├─ sub1.queue.put_nowait(msg)
                                                       └─ sub2.queue.put_nowait(msg)
                                                             ▲ 每个连接一个独立队列
                                                             │ 各自的发送协程 await get()

每个连接一个独立队列，是为了让慢客户端（比如被断点卡住的 devtools）只撑爆自己那个队列，
不会阻塞其他连接；队列满了就丢**最旧**的一条——进度类事件天然是"后一条覆盖前一条"，
丢旧的比丢新的正确。

`_subscribers` 集合只在事件循环线程上被修改（subscribe/unsubscribe 都是从 WS 协程里调的，
_fanout 也在事件循环上跑），所以它不需要锁。
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel

logger = logging.getLogger("kumodeck.events")

DEFAULT_QUEUE_SIZE = 512


def _json_default(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    return str(value)


def encode_event(type_: str, payload: Any) -> str:
    return json.dumps(
        {"type": type_, "payload": payload},
        ensure_ascii=False,
        default=_json_default,
    )


class Subscriber:
    """一个 WS 连接的收件箱。"""

    __slots__ = ("queue", "dropped")

    def __init__(self, maxsize: int) -> None:
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=maxsize)
        self.dropped = 0

    def push(self, message: str) -> None:
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            # 丢最旧的一条给新消息腾位置。get_nowait 之后队列必然有空位
            # （只有事件循环线程能动这个队列，中间不会被插队）。
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover - 理论上不可达
                pass
            self.dropped += 1
            try:
                self.queue.put_nowait(message)
            except asyncio.QueueFull:  # pragma: no cover
                pass

    async def get(self) -> str:
        return await self.queue.get()


class EventHub:
    def __init__(self, queue_size: int = DEFAULT_QUEUE_SIZE) -> None:
        self._queue_size = queue_size
        self._subscribers: set[Subscriber] = set()
        # _loop 会被工作线程读、被事件循环线程写，用普通属性赋值即可（GIL 保证引用赋值原子），
        # 但读到 None 时必须安全退化成"丢弃事件"。
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------ 生命周期

    def set_loop(self, loop: asyncio.AbstractEventLoop | None) -> None:
        """由 FastAPI lifespan 在启动时调用，交出主事件循环。"""
        self._loop = loop

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        return self._loop

    # ------------------------------------------------------------ 订阅

    def subscribe(self) -> Subscriber:
        """只允许在事件循环线程调用（WS 端点里）。"""
        sub = Subscriber(self._queue_size)
        self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    # ------------------------------------------------------------ 广播

    def publish(self, type_: str, payload: Any) -> None:
        """线程安全：任何线程都能调。没有 WS 连接时是廉价的空操作。"""
        loop = self._loop
        if loop is None:
            return
        if not self._subscribers:
            # 没人听就别做序列化了——扫描/分析进度每秒能来几十条。
            return
        try:
            message = encode_event(type_, payload)
        except (TypeError, ValueError) as exc:
            logger.warning("事件 %s 序列化失败：%s", type_, exc)
            return
        try:
            loop.call_soon_threadsafe(self._fanout, message)
        except RuntimeError:
            # 事件循环已经关了（进程正在退出），静默丢弃。
            pass

    def publish_toast(self, level: str, text: str) -> None:
        self.publish("toast", {"level": level, "text": text})

    def _fanout(self, message: str) -> None:
        """只在事件循环线程执行。"""
        for sub in list(self._subscribers):
            sub.push(message)
