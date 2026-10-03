"""索引器：把文件夹变成索引。

三件事，顺序是有讲究的：

1. **扫描**（`scan_files`）：递归找出该进库的文件。要挡掉三类东西 ——
   Office 编辑中生成的 `~$xxx.docx` 锁文件（正文是垃圾）、系统文件、
   不支持的扩展名。
2. **增量**（`reindex`）：`(size, mtime)` 都没变的文件**不重新抽取**。
   抽取是整条链路上最慢的一步（PDF/Word 解析），只该做一次；
   冷启动时索引直接从库里重建段落（见 `store.SqliteParagraphStore`）。
3. **下线**：磁盘上删掉的文件要跟着从索引和数据里去掉，
   否则搜索结果里会留着一份点不开的文件。

## 更新一份文档时的顺序（错了会静默错）

```
engine.remove_document(id)   ← 此刻库里还是**旧段落**，才撤得干净旧 gram
store.upsert_document(...)   ← 覆盖成新段落
engine.add_document(doc)     ← 按**新段落**建新 gram
```

先覆盖段落再撤索引的话，撤的是新 gram、留下的是旧 gram：
旧内容继续搜得到，而且命中的片段会指向错的行。这条没有测试能直接看出来
（现象是「改了文件但搜出来的还是老内容」），所以写在代码里。
"""
from __future__ import annotations

import dataclasses
import os
import pathlib
from typing import Callable

from . import extract, store
from .chunk import chunk_text
from .paths import normalize_path

#: 跳过这些前缀的文件名（Office 锁文件、隐藏文件、编辑器临时文件）
SKIP_NAME_PREFIXES = ("~$", "~", ".")

#: 跳过这些文件名（小写比较）
SKIP_NAMES = frozenset({"thumbs.db", "desktop.ini", ".ds_store"})

#: 进度回调：(已完成数, 总数, 最近处理的文件名)
ProgressFn = Callable[[int, int, str], None]


@dataclasses.dataclass
class IndexReport:
    """一次索引的结果。`failed` 直接给人看，所以里面是带文件名的句子。"""

    indexed: int = 0
    skipped_unchanged: int = 0
    dropped: int = 0
    failed: list[str] = dataclasses.field(default_factory=list)


def _should_skip(name: str) -> bool:
    lowered = name.lower()
    if lowered in SKIP_NAMES:
        return True
    return any(name.startswith(p) for p in SKIP_NAME_PREFIXES)


def scan_files(folders: list[str]) -> list[pathlib.Path]:
    """递归扫出该进库的文件。文件夹不存在时返回空（不抛 —— 用户可能拔了移动硬盘）。"""
    found: list[pathlib.Path] = []
    for folder in folders:
        root = pathlib.Path(folder)
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not _should_skip(d))
            for name in sorted(filenames):
                if _should_skip(name):
                    continue
                path = pathlib.Path(dirpath) / name
                if extract.is_supported(path):
                    found.append(path)
    return found


def reindex(
    folders: list[str],
    engine,
    on_progress: ProgressFn | None = None,
) -> IndexReport:
    """扫描并索引这些文件夹（增量），核对哪些文件已经不在磁盘上。

    `engine` 是 `SearchEngine`；这里只按它的 `remove_document` / `add_document`
    两个方法用它（测试里可以塞假实现）。
    """
    report = IndexReport()
    files = scan_files(folders)
    total = len(files)
    scanned_keys: set[str] = set()

    for done, path in enumerate(files, start=1):
        key = normalize_path(str(path))
        scanned_keys.add(key)

        try:
            stat = path.stat()
        except OSError:
            # 扫到之后、读之前被删/被锁 —— 跳过就好
            if on_progress:
                on_progress(done, total, path.name)
            continue

        meta = store.document_meta(key)
        if meta is not None and int(meta["size"]) == stat.st_size and abs(float(meta["mtime"]) - stat.st_mtime) < 0.001:
            report.skipped_unchanged += 1
            if on_progress:
                on_progress(done, total, path.name)
            continue

        try:
            raw = extract.read_raw_file(path)
        except extract.ExtractError as e:
            report.failed.append(str(e))
            if on_progress:
                on_progress(done, total, path.name)
            continue

        paragraphs = chunk_text(raw.text)
        if meta is not None:
            engine.remove_document(int(meta["id"]))
        store.upsert_document(raw, paragraphs)
        doc = store.indexed_document(key)
        if doc is not None:
            engine.add_document(doc)
            report.indexed += 1

        if on_progress:
            on_progress(done, total, path.name)

    # 磁盘上已经没有的文件下线（只管这次扫到的这批文件夹底下的）
    for stale in store.document_paths_under(folders):
        if stale in scanned_keys:
            continue
        meta = store.document_meta(stale)
        if meta is None:
            continue
        engine.remove_document(int(meta["id"]))
        store.delete_documents([stale])
        report.dropped += 1

    return report


def remove_folder(folder: str, engine) -> int:
    """注销一个文件夹：撤索引 → 删数据 → 删登记，返回下线的文档数。

    顺序不能反：`remove_document` 要读该文档的段落才能把 gram 撤干净，
    段落先删掉就会留下摘不掉的孤儿 gram。
    """
    key = normalize_path(folder)
    paths = store.document_paths_in_folder(key)
    for path in paths:
        meta = store.document_meta(path)
        if meta is not None:
            engine.remove_document(int(meta["id"]))
    dropped = store.delete_documents(paths)
    store.remove_folder_record(key)
    return dropped
