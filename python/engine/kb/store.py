"""知识库的持久层：文件夹登记、文档、段落、搜索历史。

一条约定：**入库的文档路径统一成正斜杠**（`normalize_path`）。
Windows 上正斜杠照样能打开文件，而统一之后「同一个文件夹用两种写法登记」
就不会变成两份索引 —— 这类重复一旦产生，用户看到的是「同一个文件出现两次」，
却完全看不出是路径写法不同导致的。

段落单独成表（`kb_para`），不是塞进文档行的一个大字段：
搜索命中后要「按 doc 取全部段落」，建索引时又要「一遍扫过去」，
这两件事都靠 `PRIMARY KEY (doc_id, idx)` 这一条索引搞定。
"""
from __future__ import annotations

import pathlib
from typing import Any

from .. import db
from . import library
from .chunk import Paragraph
from .extract import RawFile, ext_of
from .paths import normalize_path
from .types import IndexedDocument


# ── 文件夹登记 ────────────────────────────────────────────────────────


def add_folder(path: str) -> None:
    """登记一个要索引的文件夹。同一个文件夹的另一种写法不重复登记。"""
    key = normalize_path(path)
    if not key:
        return
    with db.write() as c:
        c.execute(
            "INSERT OR IGNORE INTO kb_folder(path, name) VALUES (?,?)",
            (key, library.basename(key)),
        )


def remove_folder_record(path: str) -> None:
    """只删登记记录，不动文档（下线文档请用 `indexer.remove_folder`）。"""
    with db.write() as c:
        c.execute("DELETE FROM kb_folder WHERE path=?", (normalize_path(path),))


def folder_paths() -> list[str]:
    return [r["path"] for r in db.query("SELECT path FROM kb_folder ORDER BY saved_at, path")]


def list_folders() -> list[dict[str, Any]]:
    """登记的文件夹 + 各自的文档数（嵌套归最深的那个）。"""
    rows = db.query("SELECT path, name FROM kb_folder ORDER BY saved_at, path")
    folders = [r["path"] for r in rows]
    counts = library.count_documents_by_folder(folders, [r["path"] for r in db.query("SELECT path FROM kb_doc")])
    return [{"path": r["path"], "name": r["name"], "doc_count": counts.get(r["path"], 0)} for r in rows]


def folder_of(path: str) -> str | None:
    """一个路径归属哪个登记文件夹。"""
    return library.deepest_folder_of(path, folder_paths())


# ── 文档 ──────────────────────────────────────────────────────────────


def upsert_document(raw: RawFile, paragraphs: list[Paragraph]) -> int:
    """写入/覆盖一份文档与它的段落，返回文档 id。

    同一个路径**复用同一个 id**：索引器要先按 id 撤掉旧索引再建新的，
    换了 id 就会留下撤不掉的旧 gram。
    """
    key = normalize_path(raw.path)
    file_type = ext_of(key)
    with db.write() as c:
        row = c.execute("SELECT id FROM kb_doc WHERE path=?", (key,)).fetchone()
        if row is not None:
            doc_id = int(row["id"])
            c.execute(
                "UPDATE kb_doc SET file_name=?, file_type=?, size=?, mtime=?, truncated=?, "
                "indexed_at=datetime('now','localtime') WHERE id=?",
                (raw.name, file_type, raw.size, raw.mtime, int(raw.truncated), doc_id),
            )
            c.execute("DELETE FROM kb_para WHERE doc_id=?", (doc_id,))
            # 段落换了，向量也必须跟着作废：留下旧向量，改过的段落会继续被语义命中。
            # 新向量由索引器随后写入（见 indexer.reindex）。
            c.execute("DELETE FROM kb_embed WHERE doc_id=?", (doc_id,))
        else:
            cur = c.execute(
                "INSERT INTO kb_doc(path, file_name, file_type, size, mtime, truncated) VALUES (?,?,?,?,?,?)",
                (key, raw.name, file_type, raw.size, raw.mtime, int(raw.truncated)),
            )
            doc_id = int(cur.lastrowid or 0)
        c.executemany(
            "INSERT INTO kb_para(doc_id, idx, line, text) VALUES (?,?,?,?)",
            [(doc_id, i, p.line, p.text) for i, p in enumerate(paragraphs)],
        )
    return doc_id


def document_meta(path: str) -> dict[str, Any] | None:
    """一份文档的元信息（含 id / size / mtime，供增量判断用）。"""
    rows = db.query("SELECT * FROM kb_doc WHERE path=?", (normalize_path(path),))
    return rows[0] if rows else None


def indexed_document(path: str) -> IndexedDocument | None:
    """把库里的一行还原成引擎用的 `IndexedDocument`。

    段落**刻意不带上**（懒加载）：引擎常驻内存的只有倒排索引与小写副本，
    原文段落要用时才从 `SqliteParagraphStore` 取。
    """
    row = document_meta(path)
    if row is None:
        return None
    return IndexedDocument(
        id=int(row["id"]),
        file_name=row["file_name"],
        file_type=row["file_type"],
        path=row["path"],
        paragraphs=[],
        size=int(row["size"]),
        mtime=float(row["mtime"]),
        truncated=bool(row["truncated"]),
    )


def load_documents() -> list[IndexedDocument]:
    """全部文档（不带段落）。冷启动时用它重建索引。"""
    docs = []
    for row in db.query("SELECT path FROM kb_doc ORDER BY id"):
        doc = indexed_document(row["path"])
        if doc is not None:
            docs.append(doc)
    return docs


def all_document_paths() -> list[str]:
    return [r["path"] for r in db.query("SELECT path FROM kb_doc ORDER BY id")]


def document_paths_in_folder(folder: str) -> list[str]:
    """归本文件夹的文档路径（嵌套归最深的那层 —— 与外层文件夹的计数口径一致）。"""
    return [
        path
        for path in all_document_paths()
        if library.deepest_folder_of(path, folder_paths()) == normalize_path(folder)
    ]


def document_paths_under(folders: list[str]) -> list[str]:
    """落在给定文件夹**之下**的全部文档路径（前缀匹配，不管登记与否）。

    与 `document_paths_in_folder` 的区别是有意的：这个用于「重新扫了这批文件夹，
    核对磁盘上还剩哪些文件」，所以只要路径在这些文件夹下面就算数；
    那个用于「用户点了删掉这个文件夹」，所以要按归属算，别误伤嵌套登记的子文件夹。
    """
    keys = [normalize_path(f) for f in folders]
    return [p for p in all_document_paths() if any(library.is_in_folder(p, k) for k in keys)]


def delete_documents(paths: list[str]) -> int:
    """删掉这些文档与它们的段落，返回实际删掉的行数。"""
    keys = [normalize_path(p) for p in paths if normalize_path(p)]
    if not keys:
        return 0
    removed = 0
    with db.write() as c:
        for key in keys:
            row = c.execute("SELECT id FROM kb_doc WHERE path=?", (key,)).fetchone()
            if row is None:
                continue
            c.execute("DELETE FROM kb_para WHERE doc_id=?", (row["id"],))
            c.execute("DELETE FROM kb_embed WHERE doc_id=?", (row["id"],))
            c.execute("DELETE FROM kb_doc WHERE id=?", (row["id"],))
            removed += 1
    return removed


def doc_count() -> int:
    rows = db.query("SELECT COUNT(*) AS n FROM kb_doc")
    return int(rows[0]["n"]) if rows else 0


# ── 段落（引擎的 ParagraphStore） ─────────────────────────────────────


class SqliteParagraphStore:
    """从库里按需取段落。

    **只读**：故意不实现 `add_document` / `remove_document`。
    段落是索引器通过 `upsert_document` 写进去的；引擎若也能写，
    就会出现「一份文档的段落被两条路径各自写过一遍」这种最难查的状态。
    """

    def get_paragraphs(self, doc_id: int) -> list[Paragraph]:
        rows = db.query("SELECT line, text FROM kb_para WHERE doc_id=? ORDER BY idx", (doc_id,))
        return [Paragraph(line=int(r["line"]), text=r["text"]) for r in rows]

    def has_paragraphs(self, doc_id: int) -> bool:
        return bool(db.query("SELECT 1 FROM kb_para WHERE doc_id=? LIMIT 1", (doc_id,)))


# ── 段落向量（语义检索） ──────────────────────────────────────────────


def upsert_embeddings(doc_id: int, model: str, vectors: list[bytes]) -> None:
    """覆盖一份文档的段落向量。`vectors[i]` = 第 i 段的 float32 BLOB（已归一化）。

    整份覆盖而不是逐行 upsert：段落数变了（增删段）时，逐行更新会留下
    多出来的旧行，那一段会继续被语义命中却指不到任何正文。
    """
    with db.write() as c:
        c.execute("DELETE FROM kb_embed WHERE doc_id=?", (int(doc_id),))
        if vectors:
            c.executemany(
                "INSERT INTO kb_embed(doc_id, idx, dim, model, vec) VALUES (?,?,?,?,?)",
                [(int(doc_id), i, len(blob) // 4, model, blob) for i, blob in enumerate(vectors)],
            )


def delete_embeddings(doc_id: int) -> None:
    with db.write() as c:
        c.execute("DELETE FROM kb_embed WHERE doc_id=?", (int(doc_id),))


def load_embeddings(model: str) -> list[tuple[int, int, int, bytes]]:
    """全部段落向量，**只取 `model` 这一个模型算的**（换模型后旧向量不能混用）。"""
    rows = db.query(
        "SELECT doc_id, idx, dim, vec FROM kb_embed WHERE model=? ORDER BY doc_id, idx",
        (model,),
    )
    return [(int(r["doc_id"]), int(r["idx"]), int(r["dim"]), r["vec"]) for r in rows]


def embedding_count(model: str = "") -> int:
    """已有的向量行数。传 model 时只数那个模型的（用于判断「要不要重建语义索引」）。"""
    if model:
        rows = db.query("SELECT COUNT(*) AS n FROM kb_embed WHERE model=?", (model,))
    else:
        rows = db.query("SELECT COUNT(*) AS n FROM kb_embed")
    return int(rows[0]["n"]) if rows else 0


# ── 搜索历史 ──────────────────────────────────────────────────────────


def add_history(query: str, result_count: int) -> None:
    """记一次搜索。同一个词只留最新一条（含结果数），而不是堆一长串重复。

    重搜时要**删掉旧行再插一行**，靠自增 id 表达先后 ——
    时间戳只到秒，同一秒里连搜两次就分不出谁新谁旧了（`ORDER BY used_at` 会给错顺序）。
    """
    query = query.strip()
    if not query:
        return
    with db.write() as c:
        c.execute("DELETE FROM kb_history WHERE query=?", (query,))
        c.execute("INSERT INTO kb_history(query, result_count) VALUES (?,?)", (query, int(result_count)))
        # 只留最近 200 条，避免无限增长
        c.execute("DELETE FROM kb_history WHERE id NOT IN (SELECT id FROM kb_history ORDER BY id DESC LIMIT 200)")


def list_history(limit: int = 20) -> list[dict[str, Any]]:
    rows = db.query(
        "SELECT query, result_count, used_at FROM kb_history ORDER BY id DESC LIMIT ?",
        (int(limit),),
    )
    return [{"query": r["query"], "result_count": int(r["result_count"]), "used_at": r["used_at"]} for r in rows]


def clear_history() -> None:
    with db.write() as c:
        c.execute("DELETE FROM kb_history")


def existing_file(path: str) -> bool:
    """给「打开原文件」用：路径还在不在。"""
    return pathlib.Path(path).exists()
