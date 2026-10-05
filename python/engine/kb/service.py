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

from . import embed, indexer, store
from .engine import SearchEngine
from .fuse import rrf_fuse
from .indexer import IndexReport
from .paths import normalize_path
from .semantic import SemanticIndex
from .types import SearchResult

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
#: 语义索引单例。None 有两种含义：还没初始化，或本机没有可用模型 —— `semantic()`
#: 每次都会重新探（`get_embedder` 内部有缓存，探盘很便宜）。
_semantic: SemanticIndex | None = None
_engine_lock = threading.Lock()


def engine() -> SearchEngine:
    """常驻引擎。首次调用时从库里重建索引。"""
    global _engine
    with _engine_lock:
        if _engine is None:
            store_ = store.SqliteParagraphStore()
            _engine = SearchEngine(store.load_documents(), paragraph_store=store_)
        return _engine


def semantic() -> SemanticIndex | None:
    """语义索引单例。没有可用 embedding 模型时返回 None（检索退回纯关键词）。

    懒加载：第一次真正用到时才探模型、建 onnx 会话 —— 没装模型的人
    不该为这份可选能力付启动时间。
    """
    global _semantic
    with _engine_lock:
        if _semantic is not None:
            return _semantic
        embedder = embed.get_embedder()
        if embedder is None:
            return None
        index = SemanticIndex(embedder, store)
        index.load()
        _semantic = index
        return _semantic


def reset() -> None:
    """丢掉单例（测试用；也用于「设置页里换了数据目录」这类整机重置）。"""
    global _engine, _semantic, _runner
    with _engine_lock:
        _engine = None
        _semantic = None
    _runner = None


def reload() -> None:
    """从库里重建索引（文件夹或文件变动之后）。"""
    global _engine, _semantic
    with _engine_lock:
        _engine = SearchEngine(store.load_documents(), paragraph_store=store.SqliteParagraphStore())
        _semantic = None  # 下次检索时按新库重建（向量可能刚被重算过）


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
        embeddings_getter: Callable[[], SemanticIndex | None] | None = None,
    ) -> None:
        self._engine_getter = engine_getter
        self._reindex_fn = reindex_fn
        #: 只有注入它才会把语义索引传下去；不注入（单测的假 reindex_fn）
        #: 时连 `embeddings=` 这个关键字都不会出现，老签名照样能用。
        self._embeddings_getter = embeddings_getter
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
            kwargs: dict = {"on_progress": self._on_progress}
            if self._embeddings_getter is not None:
                kwargs["embeddings"] = self._embeddings_getter()
            report = self._reindex_fn(folders, self._engine_getter(), **kwargs)
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
        _runner = IndexRunner(engine_getter=engine, embeddings_getter=semantic)
    return _runner


def run_index_sync() -> IndexReport:
    """同步跑一轮（测试与脚本用）。"""
    return indexer.reindex(store.folder_paths(), engine(), embeddings=semantic())


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
    return indexer.remove_folder(path, engine(), embeddings=semantic())


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
        # 有没有语义那一路可用。前端拿它决定空结果时给不给「用一句话描述」的引导 ——
        # 模型不在场还说「可以描述着搜」，是把用户往一个不存在的功能上引。
        "semanticEnabled": semantic() is not None,
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
    """搜索并记历史。返回前端直接可用的形状（camelCase）。

    两路召回 + RRF 融合：

    - **关键词路**：现有倒排索引（BM25）。行为一字未改。
    - **语义路**：段落向量余弦。没有模型 / 模型报错时这路为空，
      整条路径的行为与加语义之前**完全一致**（名次、分数、条数都不变）。

    融合只看名次（RRF，`Σ 1/(k+rank)`），两路量纲不同也不受影响。
    关键词命中的结果**保留它原来的 BM25 分数**，语义命中用相似度当分数 ——
    分数只作展示，排序以融合名次为准。
    """
    query = (query or "").strip()
    if not query:
        return {"query": "", "count": 0, "results": []}

    eng = engine()
    hits = eng.search(query)
    keyword_rank = [h.document.id for h in hits]
    keyword_hits = {h.document.id: h for h in hits}

    semantic_best = _semantic_matches(query)
    semantic_rank = list(semantic_best)  # dict 保序：按相似度降序构造

    fused = rrf_fuse([keyword_rank, semantic_rank])
    store.add_history(query, len(fused))

    results: list[dict] = []
    seen_paths: set[str] = set()
    for doc_id, _fused_score in fused:
        hit = keyword_hits.get(doc_id)
        if hit is not None:
            payload = _result_payload(hit, "both" if doc_id in semantic_best else "keyword")
        else:
            payload = _semantic_payload(eng, doc_id, semantic_best[doc_id])
        if payload is None:
            continue
        # 语义是按 doc_id 召回的，同一份文件的多个分片（多个 doc）会各占一个名次；
        # 关键词路已经在引擎里按 path 去过重，这里把两路合并后的重复路径也收掉。
        key = normalize_path(payload["path"])
        if key:
            if key in seen_paths:
                continue
            seen_paths.add(key)
        results.append(payload)

    results = results[: max(int(limit), 0)]
    return {"query": query, "count": len(results), "results": results}


def _semantic_matches(query: str) -> dict[int, tuple[float, int]]:
    """语义路的文档级命中：`{doc_id: (相似度, 最相关段落序号)}`，按相似度降序。

    没有模型、模型报错、维度对不上 —— 一律返回空字典，只走关键词路。
    语义是增强而非必需，绝不能因为它把关键词的结果也拖没。
    """
    index = semantic()
    if index is None:
        return {}
    try:
        matches = index.search(query)
    except Exception:
        return {}
    return {doc_id: (score, idx) for doc_id, score, idx in matches}


def _result_payload(hit, matched_by: str) -> dict:
    return _payload(
        hit.document,
        score=hit.score,
        match_mode=hit.match_mode,
        match_count=len(hit.matched_paragraphs),
        snippets=hit.matched_paragraphs[:MAX_SNIPPETS],
        matched_by=matched_by,
    )


def _semantic_payload(eng: SearchEngine, doc_id: int, best: tuple[float, int]) -> dict | None:
    """语义独有（关键词没召回）的结果：回表取文档与那段原文，补造成同一种形状。"""
    doc = eng.document(doc_id)
    if doc is None:
        return None
    score, idx = best
    paragraphs = eng.paragraphs(doc_id)
    snippet = [paragraphs[idx]] if 0 <= idx < len(paragraphs) else []
    return _payload(
        doc,
        score=score,
        match_mode="and",
        match_count=len(snippet),
        snippets=snippet,
        matched_by="semantic",
    )


def _payload(doc, score: float, match_mode: str, match_count: int, snippets, matched_by: str) -> dict:
    return {
        "path": doc.path,
        "fileName": doc.file_name,
        "fileType": doc.file_type,
        "size": doc.size,
        "mtime": doc.mtime,
        "truncated": doc.truncated,
        "score": score,
        "matchMode": match_mode,
        "matchCount": match_count,
        "snippets": [{"line": p.line, "text": p.text} for p in snippets],
        #: 'keyword' | 'semantic' | 'both' —— 前端据此标注「怎么找到的」
        "matchedBy": matched_by,
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
