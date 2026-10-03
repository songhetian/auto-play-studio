"""文件夹归属：把文档路径归到它所属的登记文件夹上。

取件自 know 的 `library.ts`。这里只搬了真正被消费的那几个纯函数；
`inferFolderPaths`（从拖拽进来的散文件反推根文件夹）**没搬** ——
本轮资源页不做拖拽入文件夹，做了再搬。

一条贯穿全篇的规则：**嵌套时归最深的那层**。
`/kb` 和 `/kb/话术` 都登记了，`/kb/话术/退款.md` 算「话术」的，
否则外层文件夹的数字会把内层吞掉，两边加起来大于总数。
"""
from __future__ import annotations

from .paths import normalize_path


def basename(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or path


def is_in_folder(path: str, folder: str) -> bool:
    """路径是否在文件夹下。**精确匹配前缀**，避免 `/kb2` 被当成在 `/kb` 里。"""
    p = normalize_path(path)
    f = normalize_path(folder)
    return bool(f) and (p == f or p.startswith(f + "/"))


def deepest_folder_of(path: str, folders: list[str]) -> str | None:
    """路径归属的登记文件夹；没落在任何一个下面时返回 None。"""
    best: str | None = None
    for folder in folders:
        if is_in_folder(path, folder):
            if best is None or len(normalize_path(folder)) > len(normalize_path(best)):
                best = folder
    return best


def merge_folders(existing: list[str], incoming: list[str]) -> list[str]:
    """合并文件夹列表：按归一化路径去重，保持原有顺序，新的排在后面。"""
    seen = {normalize_path(f) for f in existing}
    merged = list(existing)
    for folder in incoming:
        if not folder:
            continue
        key = normalize_path(folder)
        if key not in seen:
            seen.add(key)
            merged.append(folder)
    return merged


def remove_folder(folders: list[str], path: str) -> list[str]:
    key = normalize_path(path)
    return [f for f in folders if normalize_path(f) != key]


def count_documents_by_folder(folders: list[str], doc_paths: list[str]) -> dict[str, int]:
    """每个登记文件夹名下的文档数（嵌套归最深的那个）。返回 `{归一化文件夹路径: 数量}`。"""
    counts = {normalize_path(f): 0 for f in folders}
    for path in doc_paths:
        owner = deepest_folder_of(path, folders)
        if owner is not None:
            counts[normalize_path(owner)] += 1
    return counts
