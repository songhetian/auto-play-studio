"""切片 4：落库与索引器。

真相源是**临时目录里的真实文件树**，文件用切片 1 的手搓夹具造
（docx / xlsx / PDF 的字节由我们掌握，期望值就是写进去的字面量）。

这一片要回答的核心问题是「重启引擎以后还要不要重新抽一遍文本」：
段落落 SQLite，索引从库里重建 —— 抽取是慢的那一步（PDF/Word 解析），
它必须只做一次。
"""
from __future__ import annotations

import os
import pathlib

import pytest

from engine.kb import extract, indexer, store
from engine.kb.engine import SearchEngine
from engine.kb.indexer import reindex, scan_files
from tests import kb_fixtures as F


@pytest.fixture(autouse=True)
def _clean_kb_tables():
    """每个用例前清空知识库的四张表（与 conftest 的固定测试库同一套做法）。"""
    from engine import db

    with db.write() as c:
        for t in ("kb_folder", "kb_doc", "kb_para", "kb_history"):
            c.execute(f"DELETE FROM {t}")
    yield


@pytest.fixture
def kb_root(tmp_path) -> pathlib.Path:
    """一棵有代表性的真实文件树。"""
    root = tmp_path / "知识库"
    (root / "话术").mkdir(parents=True)
    (root / "工单").mkdir()

    (root / "话术" / "退款政策.md").write_text("退款政策：7 天无理由退还\n\n运费由商家承担", encoding="utf-8")
    F.write_docx(root / "话术" / "升级条件.docx", [F.REFUND, "超过 100 元升级主管"])
    F.write_xlsx(root / "工单" / "工单样例.xlsx", [F.SHEET_A, *F.SHEET_ROWS])

    # 下面这些都不该进库
    (root / "~$退款政策.md").write_text("Office 锁文件")
    (root / "安装包.exe").write_bytes(b"MZ\x90\x00")
    (root / "坏掉.pdf").write_bytes(b"%PDF-1.4\n" + "这不是 PDF".encode())
    (root / "没有扩展名").write_text("无扩展名")
    return root


@pytest.fixture
def engine() -> SearchEngine:
    """段落走 SQLite 的引擎（懒加载：文档里不带段落）。"""
    return SearchEngine([], paragraph_store=store.SqliteParagraphStore())


# ── 扫描：哪些文件该进库 ──────────────────────────────────────────────


def test_scan_finds_supported_files_recursively(kb_root):
    """遍历找到「该看的」文件。

    注意这里**包含坏掉.pdf**：扫描只按扩展名筛，读不读得懂是下一步的事
    （读不出来的记进 `report.failed`，而不是在扫描阶段就消失 ——
    否则用户永远不会知道自己的知识库里有个打不开的文件）。
    """
    names = sorted(p.name for p in scan_files([str(kb_root)]))
    assert names == ["升级条件.docx", "坏掉.pdf", "工单样例.xlsx", "退款政策.md"]


def test_scan_skips_office_lock_files_and_system_files(kb_root):
    """`~$xxx.docx` 是 Office 编辑中的锁文件，正文是垃圾；`.DS_Store` 是系统文件。"""
    (kb_root / ".DS_Store").write_bytes(b"\x00\x01")
    names = [p.name for p in scan_files([str(kb_root)])]

    assert not any(n.startswith("~$") for n in names)
    assert ".DS_Store" not in names


def test_scan_skips_unsupported_extensions(kb_root):
    names = [p.name for p in scan_files([str(kb_root)])]

    assert "安装包.exe" not in names
    assert "没有扩展名" not in names


def test_scan_of_a_missing_folder_yields_nothing(tmp_path):
    assert scan_files([str(tmp_path / "不存在")]) == []


# ── 索引：入库、可搜、容错 ────────────────────────────────────────────


def test_reindex_puts_every_supported_file_in_the_database(kb_root, engine):
    report = reindex([str(kb_root)], engine)

    assert report.indexed == 3  # 坏掉.pdf 在看得到的 4 个里占一格，但入不了库
    assert store.doc_count() == 3


def test_reindex_records_unreadable_files_without_stopping(kb_root, engine):
    """一个坏文件不该让整次索引失败，但也不能悄悄跳过 —— 用户得知道是哪个。"""
    report = reindex([str(kb_root)], engine)

    assert len(report.failed) == 1
    assert "坏掉.pdf" in report.failed[0]


def test_content_is_searchable_after_reindex(kb_root, engine):
    reindex([str(kb_root)], engine)

    hits = engine.search("退款政策")

    assert any(r.document.file_name == "退款政策.md" for r in hits)
    assert all(r.matched_paragraphs for r in hits)


def test_paragraphs_are_readable_through_the_store(kb_root, engine):
    reindex([str(kb_root)], engine)
    doc = next(d for d in store.load_documents() if d.file_name == "退款政策.md")

    paras = store.SqliteParagraphStore().get_paragraphs(doc.id)

    assert [p.text for p in paras] == ["退款政策：7 天无理由退还", "运费由商家承担"]
    assert paras[0].line == 1


def test_document_metadata_is_preserved(kb_root, engine):
    reindex([str(kb_root)], engine)
    doc = next(d for d in store.load_documents() if d.file_name == "工单样例.xlsx")
    raw = extract.read_raw_file(kb_root / "工单" / "工单样例.xlsx")

    assert doc.file_type == "xlsx"
    assert doc.size == raw.size
    assert doc.mtime == pytest.approx(raw.mtime, abs=0.001)
    assert doc.truncated is False


# ── 增量：没变的文件不重新抽 ──────────────────────────────────────────


def test_unchanged_files_are_not_extracted_again(kb_root, engine):
    reindex([str(kb_root)], engine)

    second = reindex([str(kb_root)], engine)

    assert second.indexed == 0
    assert second.skipped_unchanged == 3
    assert store.doc_count() == 3


def test_changed_files_are_reindexed_and_the_old_content_goes_away(kb_root, engine):
    reindex([str(kb_root)], engine)
    target = kb_root / "话术" / "退款政策.md"
    target.write_text("改成：15 天无理由", encoding="utf-8")
    os.utime(target, (1_800_000_000, 1_800_000_000))

    report = reindex([str(kb_root)], engine)

    assert report.indexed == 1
    assert report.skipped_unchanged == 2
    assert store.doc_count() == 3  # 覆盖，不是新增一份
    assert any(r.document.file_name == "退款政策.md" for r in engine.search("15 天无理由"))
    # 旧内容必须搜不到了：撤索引用的是**旧段落**，落库用的是新段落，顺序错了这里就会假通过
    assert all(r.document.file_name != "退款政策.md" for r in engine.search("7 天无理由退还"))


def test_deleted_files_are_dropped_from_the_index(kb_root, engine):
    """磁盘上删掉的文件必须跟着下线，否则搜索结果里会留着一份打不开的文件。"""
    reindex([str(kb_root)], engine)
    (kb_root / "话术" / "退款政策.md").unlink()

    report = reindex([str(kb_root)], engine)

    assert report.dropped == 1
    assert store.doc_count() == 2
    # 用只可能出自这份文件的句子来断言「真的下线了」
    assert engine.search("运费由商家承担") == []


def test_reindexed_document_keeps_working_after_a_cold_start(kb_root):
    """冷启动：进程重启后索引从库里重建，段落不必重新抽取。"""
    reindex([str(kb_root)], SearchEngine([], paragraph_store=store.SqliteParagraphStore()))

    rebuilt = SearchEngine(store.load_documents(), paragraph_store=store.SqliteParagraphStore())

    hits = rebuilt.search("7 天无理由退还")
    assert any(r.document.file_name == "退款政策.md" for r in hits)
    assert hits[0].matched_paragraphs[0].text == "退款政策：7 天无理由退还"


# ── 文件夹登记与下线 ──────────────────────────────────────────────────


def test_adding_a_folder_twice_is_a_no_op():
    store.add_folder("C:/docs")
    store.add_folder("C:\\docs\\")  # 同一个文件夹的另一种写法

    assert [f["path"] for f in store.list_folders()] == ["C:/docs"]


def test_folder_of_finds_the_deepest_registered_folder(kb_root, engine):
    store.add_folder(str(kb_root))
    store.add_folder(str(kb_root / "话术"))
    reindex([str(kb_root)], engine)

    deep = store.folder_of(str(kb_root / "话术" / "退款政策.md"))
    shallow = store.folder_of(str(kb_root / "工单" / "工单样例.xlsx"))

    assert pathlib.PurePath(deep).name == "话术"
    assert pathlib.PurePath(shallow).name == "知识库"


def test_folder_reports_its_document_count(kb_root, engine):
    store.add_folder(str(kb_root))
    reindex([str(kb_root)], engine)

    assert store.list_folders()[0]["doc_count"] == 3


def test_removing_a_folder_drops_its_documents(kb_root, engine):
    store.add_folder(str(kb_root))
    reindex([str(kb_root)], engine)

    dropped = indexer.remove_folder(str(kb_root), engine)

    assert dropped == 3
    assert store.doc_count() == 0
    assert engine.search("退款政策") == []
    assert store.list_folders() == []


def test_removing_a_folder_leaves_other_folders_alone(tmp_path, engine):
    a, b = tmp_path / "A", tmp_path / "B"
    for d in (a, b):
        d.mkdir()
        (d / "内容.md").write_text("退款政策第一条", encoding="utf-8")
    store.add_folder(str(a))
    store.add_folder(str(b))
    reindex([str(a), str(b)], engine)

    indexer.remove_folder(str(a), engine)

    assert store.doc_count() == 1
    assert [d.file_name for d in store.load_documents()] == ["内容.md"]


def test_reindex_only_reconciles_the_folders_it_was_given(tmp_path, engine):
    """换一个文件夹重扫，不该把别的文件夹的文档当成「磁盘上已删除」清掉。"""
    a, b = tmp_path / "A", tmp_path / "B"
    for d in (a, b):
        d.mkdir()
        (d / "内容.md").write_text("退款政策第一条", encoding="utf-8")
    store.add_folder(str(a))
    store.add_folder(str(b))
    reindex([str(a), str(b)], engine)

    reindex([str(a)], engine)

    assert store.doc_count() == 2


# ── 进度回调 ──────────────────────────────────────────────────────────


def test_progress_is_reported_while_indexing(kb_root, engine):
    seen: list[tuple[int, int, str]] = []
    reindex([str(kb_root)], engine, on_progress=lambda done, total, name: seen.append((done, total, name)))

    assert seen, "至少要报一次进度，否则前端只能转圈"
    # 总数是「该看的文件数」（4，含那个读不出来的）—— 否则进度条会永远停在 3/4
    assert seen[-1][0] == seen[-1][1] == 4
    assert all(total == 4 for _, total, _ in seen)
    assert [done for done, _, _ in seen] == sorted(done for done, _, _ in seen)
    assert all(name for _, _, name in seen)


# ── 搜索历史 ──────────────────────────────────────────────────────────


def test_history_keeps_the_latest_usage_of_a_query():
    store.add_history("退款", 3)
    store.add_history("物流", 1)
    store.add_history("退款", 5)

    rows = store.list_history()
    assert [r["query"] for r in rows] == ["退款", "物流"]  # 最近的在前，同一个词不重复
    assert rows[0]["result_count"] == 5


def test_history_can_be_limited_and_cleared():
    for i in range(30):
        store.add_history(f"查询{i}", i)

    assert len(store.list_history(limit=10)) == 10
    store.clear_history()
    assert store.list_history() == []
