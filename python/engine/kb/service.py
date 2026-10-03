"""服务层：把「库」「索引器」「引擎」三块拼成一个常驻服务。

## 引擎是单例，索引常驻内存

倒排索引在内存里，段落留在 SQLite（`SqliteParagraphStore`）。
所以：**启动时从库重建索引**（几百份文档零点几秒），
搜索路径上只碰索引，只有真的要显示片段时才回库取段落。

## 索引在后台线程里跑

一个几百份文件的知识库要几秒到几十秒，HTTP 请求不能干等。
接口立刻返回、进度靠 `status()` 轮询 —— 与控制台里实例的运行状态是同一套做法。

**防重入 + 补跑**：已经在跑就不再起第二个（两个线程一起写库、一起改索引，
结果不可预期）；但跑的过程中新登记的文件夹会被记下来，这一轮结束后补跑一次。
不排队（队列会越积越长），也不丢（丢掉的后果是「登记了却没索引」，
而用户唯一的判断依据是搜索结果里没有它 —— 他会以为功能坏了）。
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import threading
from typing import Callable

from . import indexer, store
from .engine import SearchEngine
from .indexer import IndexReport
from .paths import normalize_path

#: 一次搜索最多返回几条结果（超出由前端提示「收窄一下」）
MAX_RESULTS = 50

#: 单条结果最多给几段命中片段（`matchCount` 会告诉前端一共命中几处）
MAX_SNIPPETS = 5

#: 「打开原文件」的实现，测试里替换掉（进程内启动编辑器不可测）
_open_with_system: Callable[[str], None]


def _open_with_system(path: str) -> None:  # noqa: F811 —— 覆盖上面的注解声明
    """用系统默认程序打开。只有在同一台机器上才有意义（引擎是本机 sidecar）。"""
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


# ── 引擎单例 ──────────────────────────────────────────────────────────

_engine: SearchEngine | None = None
_engine_lock = threading.Lock()


def engine() -> SearchEngine:
    """常驻引擎。首次调用时从库里重建索引。"""
    global _engine
    with _engine_lock:
        if _engine is None:
            store_ = store.SqliteParagraphStore()
            _engine = SearchEngine(store.load_documents(), paragraph_store=store_)
        return _engine


def reset() -> None:
    """丢掉单例（测试用；也用于「设置页里换了数据目录」这类整机重置）。"""
    global _engine, _runner
    with _engine_lock:
        _engine = None
    _runner = None


def reload() -> None:
    """从库里重建索引（文件夹或文件变动之后）。"""
    global _engine
    with _engine_lock:
        _engine = SearchEngine(store.load_documents(), paragraph_store=store.SqliteParagraphStore())


# ── 后台索引 ──────────────────────────────────────────────────────────


class IndexRunner:
    """在后台线程里跑索引，并对外暴露进度。

    `reindex_fn` 可注入，就是为了让「防重入」和「补跑」这两件事能被确定性地测到 ——
    靠 `sleep` 去抢线程时序的测试是不稳定的。
    """

    def __init__(
        self,
        engine_getter: Callable[[], SearchEngine],
        reindex_fn: Callable[..., IndexReport] = indexer.reindex,
    ) -> None:
        self._engine_getter = engine_getter
        self._reindex_fn = reindex_fn
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._rerun_requested = False
        self._progress = {"running": False, "done": 0, "total": 0, "current": ""}
        self._failed: list[str] = []

    def start(self, folders: list[str]) -> bool:
        """起一轮索引。已经在跑就返回 False（并记下「跑完要补一次」）。"""
        with self._lock:
            if self._progress["running"]:
                self._rerun_requested = True
                return False
            self._progress = {"running": True, "done": 0, "total": 0, "current": ""}
            self._failed = []
            self._rerun_requested = False
            self._thread = threading.Thread(target=self._run, args=(list(folders),), daemon=True)
            self._thread.start()
            return True

    def request_rerun(self) -> None:
        """请这一轮结束后再补跑一次（登记了新文件夹时调用）。"""
        with self._lock:
            if self._progress["running"]:
                self._rerun_requested = True

    def _run(self, folders: list[str]) -> None:
        while True:
            report = self._reindex_fn(folders, self._engine_getter(), on_progress=self._on_progress)
            with self._lock:
                self._failed = list(report.failed)
                if not self._rerun_requested:
                    self._progress["running"] = False
                    return
                # 补跑：文件夹列表要重新读，否则新登记的那个永远扫不到
                self._rerun_requested = False
                folders = store.folder_paths()

    def _on_progress(self, done: int, total: int, name: str) -> None:
        with self._lock:
            self._progress["done"] = done
            self._progress["total"] = total
            self._progress["current"] = name

    def wait(self, timeout: float = 30.0) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def snapshot(self) -> dict:
        with self._lock:
            return {**self._progress, "failed": list(self._failed)}


_runner: IndexRunner | None = None


def runner() -> IndexRunner:
    global _runner
    if _runner is None:
        _runner = IndexRunner(engine_getter=engine)
    return _runner


def run_index_sync() -> IndexReport:
    """同步跑一轮（测试与脚本用）。"""
    return indexer.reindex(store.folder_paths(), engine())


# ── 对外动作 ──────────────────────────────────────────────────────────


def add_folder(path: str) -> dict:
    """登记一个文件夹并开始索引。已经在索引中就记下补跑，不排第二个线程。"""
    store.add_folder(path)
    key = normalize_path(path)
    started = runner().start(store.folder_paths())
    if not started:
        runner().request_rerun()
    row = next((f for f in store.list_folders() if f["path"] == key), None)
    return {"folder": _folder_payload(row) if row else None, "started": started}


def _folder_payload(row: dict) -> dict:
    """仓储层用 snake_case（贴着 SQL），响应层一律 camelCase（贴着前端）。

    转换只在这一个地方做：以前 `/rows` 就是因为两边各写一份字段名，
    引擎回 snake_case、前端读 camelCase，页面不报错但整张表是空的。
    """
    return {"path": row["path"], "name": row["name"], "docCount": row["doc_count"]}


def remove_folder(path: str) -> int:
    """注销文件夹：撤回它的文档与索引。"""
    return indexer.remove_folder(path, engine())


def reindex_all() -> dict:
    """重新扫一遍全部已登记文件夹。"""
    started = runner().start(store.folder_paths())
    if not started:
        runner().request_rerun()
    return {"started": started}


def status() -> dict:
    snap = runner().snapshot()
    eng = engine()
    return {
        "docCount": eng.document_count,
        "fileCount": eng.file_count,
        "folders": [_folder_payload(f) for f in store.list_folders()],
        "indexing": {
            "running": snap["running"],
            "done": snap["done"],
            "total": snap["total"],
            "current": snap["current"],
        },
        "failed": snap["failed"],
    }


def history(limit: int = 20) -> dict:
    return {
        "items": [
            {"query": r["query"], "resultCount": r["result_count"], "usedAt": r["used_at"]}
            for r in store.list_history(limit)
        ]
    }


def clear_history() -> None:
    store.clear_history()


def search(query: str, limit: int = MAX_RESULTS) -> dict:
    """搜索并记历史。返回前端直接可用的形状（camelCase）。"""
    query = (query or "").strip()
    if not query:
        return {"query": "", "count": 0, "results": []}

    hits = engine().search(query)
    store.add_history(query, len(hits))
    capped = hits[: max(int(limit), 0)]
    return {
        "query": query,
        "count": len(capped),
        "results": [_result_payload(h) for h in capped],
    }


def _result_payload(hit) -> dict:
    snippets = hit.matched_paragraphs[:MAX_SNIPPETS]
    doc = hit.document
    return {
        "path": doc.path,
        "fileName": doc.file_name,
        "fileType": doc.file_type,
        "size": doc.size,
        "mtime": doc.mtime,
        "truncated": doc.truncated,
        "score": hit.score,
        "matchMode": hit.match_mode,
        "matchCount": len(hit.matched_paragraphs),
        "snippets": [{"line": p.line, "text": p.text} for p in snippets],
    }


def open_file(path: str) -> None:
    """用系统默认程序打开一个**已索引**的文件。

    校验它确实在库里：引擎是个本机进程，不该变成一个「随便什么路径都能打开」的入口
    （前端一旦被塞进一个构造出来的路径，弹出来的就是别的程序）。
    """
    key = normalize_path(path)
    if store.document_meta(key) is None:
        raise LookupError(key)
    _open_with_system(key)


def folder_exists(path: str) -> bool:
    return pathlib.Path(path).is_dir()
