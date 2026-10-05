# -*- coding: utf-8 -*-
"""wordlib.json 文件监听：主管发一份词库文件，坐席端自动导入。

现状：词库改完要在页面里手动导入。但教室机往往由主管统一分发一份 `wordlib.json`，
坐席不该被要求"再进页面点一次导入"。所以：**监听文件变化 → 自动走既有 import_json**。

两条硬边界（用户明确）：
- **SQLite 仍是唯一真源**，文件只是投递通道；
- **单向**：文件 → 库。库里的改动不回写文件（不做双向同步）。

实现取舍：
- 不引 `watchdog`：轮询 `mtime_ns + size` 足够（词库是低频变更），零新依赖；
- 变化判定同时看 mtime 与 size：只比 mtime 会在"同一秒内改两次"时漏掉；
- 导入失败**不清库、不重复轰炸**：记下失败时的签名，同一份坏文件只报一次，
  等文件真的变了再重试（"写了一半的 JSON"下一秒会被写完整，签名也随之变化）。
"""
from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime

from .. import db


def read_wordlib(text: str):
    """把 wordlib.json 文本解析成 ``import_json`` 能吃的 payload。

    只要求顶层是合法 JSON，其余字段容错交给 ``service.import_json``
    （它已兼容数组 / ``{"words": [...]}`` 两种结构）。解析失败抛 ``ValueError``。
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("不是合法的 JSON：%s" % exc) from exc


def signature_of(path: str):
    """文件的变更签名 ``(mtime_ns, size)``；文件不存在返回 ``None``。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


@dataclass
class WatchState:
    """监听运行态（给页面看的状态卡用，path 之外的字段不落库）。"""

    path: str = ""
    signature: tuple | None = None
    failed_signature: tuple | None = None
    last_import_at: str = ""
    last_result: dict | None = None
    last_error: str = ""


class WordlibWatcher:
    """把"文件变了就导入"做成可测的纯逻辑：外部依赖全部注入。

    - ``read_text(path)``：读文件文本；
    - ``stat_signature(path)``：取变更签名；
    - ``import_fn(payload)``：真正写库（生产上就是 ``service.import_json``）；
    - ``now()``：当前时间字符串（记 last_import_at）。
    """

    def __init__(self, read_text, stat_signature, import_fn, now):
        self._read_text = read_text
        self._sig = stat_signature
        self._import = import_fn
        self._now = now
        self.state = WatchState()

    def set_path(self, path: str) -> None:
        """切换被监听的文件。换文件后必须重导一次（签名清空）。"""
        path = (path or "").strip()
        if path == self.state.path:
            return
        self.state = WatchState(path=path)

    def poll(self) -> bool:
        """轮询一次，返回本次是否真的导入了（有变化且导入成功）。"""
        path = self.state.path
        if not path:
            return False

        sig = self._sig(path)
        if sig is None:
            # 文件还没到位 / 被删：分发过程中很常见，不当错误，等它出现
            self.state.last_error = "等待词库文件出现"
            self.state.signature = None
            return False

        # 没变化，或这份内容上次就导入失败了（同一份坏文件不重复轰炸）
        if sig == self.state.signature or sig == self.state.failed_signature:
            return False

        try:
            payload = read_wordlib(self._read_text(path))
            result = self._import(payload)
        except Exception as exc:  # noqa: BLE001 —— 坏文件只记录、绝不打断轮询
            self.state.failed_signature = sig
            self.state.last_error = str(exc)
            return False

        self.state.signature = sig
        self.state.last_error = ""
        self.state.last_result = result
        self.state.last_import_at = self._now()
        return True


# ── 生产装配 + 后台线程 ──────────────────────────────────────────────
_watcher: WordlibWatcher | None = None
_thread: threading.Thread | None = None
_stop_event: threading.Event | None = None


def _import_into_db(payload):
    from . import service

    return service.import_json(payload)


def get_watcher() -> WordlibWatcher:
    """取全局监听器（首次调用时按库里的路径装配）。"""
    global _watcher
    if _watcher is None:
        _watcher = WordlibWatcher(
            read_text=lambda p: open(p, encoding="utf-8").read(),
            stat_signature=signature_of,
            import_fn=_import_into_db,
            now=lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        )
        _watcher.set_path(db.get_wordlib_path())
    return _watcher


def start_watcher(interval: float = 3.0) -> threading.Thread:
    """启动后台轮询线程（幂等），返回线程句柄。

    返回句柄是为了让调用方能观察它：什么时候起的、停没停住。
    """
    global _thread, _stop_event
    if _thread is not None and _thread.is_alive():
        return _thread

    _stop_event = threading.Event()
    stop = _stop_event  # 闭包里固定引用，避免全局被重置后线程拿到 None

    def loop() -> None:
        while True:
            try:
                get_watcher().poll()
            except Exception:  # noqa: BLE001 —— 轮询里任何异常都不能让线程退出
                pass
            # 用 Event 等待而不是 time.sleep：停止信号能立刻打断等待，
            # 不必等这一次轮询间隔走完，退出才有确定性。
            if stop.wait(interval):
                return

    _thread = threading.Thread(target=loop, name="wordlib-watch", daemon=True)
    _thread.start()
    return _thread


def stop_watcher(timeout: float = 5.0) -> bool:
    """停掉后台轮询线程，返回「是否在 timeout 内真的停住了」。

    没启动过、或已经停过，都直接返回 True（幂等）。
    """
    global _thread, _stop_event
    if _thread is None or _stop_event is None:
        return True

    _stop_event.set()
    _thread.join(timeout)
    if _thread.is_alive():
        return False

    _thread = None
    _stop_event = None
    return True
