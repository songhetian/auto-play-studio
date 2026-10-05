"""向量落库：读写、按模型过滤、以及「文档没了向量也要跟着没」的级联。

级联是这一片最容易漏、后果又最隐蔽的部分：向量表和文档表没有任何外键约束，
漏删一行不会报错 —— 现象是「删掉的文档还能被语义搜出来，点开却发现文件不在了」。
"""
from __future__ import annotations

import pytest

from engine.kb import store
from engine.kb.chunk import Paragraph
from engine.kb.extract import RawFile
from engine.kb.semantic import pack_vector


@pytest.fixture(autouse=True)
def _clean_kb_tables():
    from engine import db

    with db.write() as c:
        for t in ("kb_folder", "kb_doc", "kb_para", "kb_embed", "kb_history"):
            c.execute(f"DELETE FROM {t}")
    yield


def _raw(path: str, name: str = "退款政策.md") -> RawFile:
    return RawFile(name=name, path=path, size=10, mtime=1.0, text="退款政策", truncated=False)


def _paras(*texts: str) -> list[Paragraph]:
    return [Paragraph(line=i + 1, text=t) for i, t in enumerate(texts)]


def test_embeddings_roundtrip_and_model_filter():
    doc_id = store.upsert_document(_raw("C:/kb/a.md"), _paras("退款时效"))
    store.upsert_embeddings(doc_id, "model-a", [pack_vector([1.0, 0.0])])

    rows = store.load_embeddings("model-a")
    assert [(r[0], r[1], r[2]) for r in rows] == [(doc_id, 0, 2)]
    # 换模型后旧向量不算数：不能混用（维度/语义空间都不同）
    assert store.load_embeddings("model-b") == []
    assert store.embedding_count("model-a") == 1


def test_upsert_embeddings_replaces_the_whole_document():
    doc_id = store.upsert_document(_raw("C:/kb/a.md"), _paras("第一段", "第二段"))
    store.upsert_embeddings(doc_id, "m", [pack_vector([1.0]), pack_vector([0.0])])

    # 段落数变少：整份覆盖，不能留下第 2 段的旧行（那段会指不到任何正文）
    store.upsert_embeddings(doc_id, "m", [pack_vector([1.0])])

    assert store.embedding_count("m") == 1


def test_reupserting_a_document_drops_its_embeddings():
    doc_id = store.upsert_document(_raw("C:/kb/a.md"), _paras("退款时效"))
    store.upsert_embeddings(doc_id, "m", [pack_vector([1.0])])

    # 段落被覆盖了，旧向量必须作废（新向量由索引器随后写入）
    same_id = store.upsert_document(_raw("C:/kb/a.md"), _paras("改过的内容"))

    assert same_id == doc_id  # 同一路径复用同一 id
    assert store.embedding_count() == 0


def test_deleting_documents_drops_their_embeddings():
    doc_id = store.upsert_document(_raw("C:/kb/a.md"), _paras("退款时效"))
    store.upsert_embeddings(doc_id, "m", [pack_vector([1.0])])

    store.delete_documents(["C:/kb/a.md"])

    assert store.embedding_count() == 0


def test_delete_embeddings_only_touches_one_document():
    a = store.upsert_document(_raw("C:/kb/a.md"), _paras("A"))
    b = store.upsert_document(_raw("C:/kb/b.md", "物流.md"), _paras("B"))
    store.upsert_embeddings(a, "m", [pack_vector([1.0])])
    store.upsert_embeddings(b, "m", [pack_vector([0.0])])

    store.delete_embeddings(a)

    assert store.embedding_count("m") == 1
    assert store.load_embeddings("m")[0][0] == b
