"""语义检索的纯逻辑：归一化 / 余弦（文档级聚合）/ RRF 融合。

**这些用例都不加载真实模型** —— 全部注入假 embedder（按关键词轴生成向量）。
真模型只在 `test_kb_embed_model.py` 里碰，而且要模型文件在场才跑。

这么切是为了让「核心算法对错」不依赖一个几十 MB 的二进制资产：
换模型、模型没下载、CI 上没网，这里的结论都照样成立。
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from engine.kb.chunk import Paragraph
from engine.kb.fuse import rrf_fuse
from engine.kb.semantic import (
    MIN_SCORE,
    SemanticIndex,
    normalize,
    pack_vector,
    unpack_vector,
)


# ── 假件：按「关键词轴」出向量 ─────────────────────────────────────────


class FakeEmbedder:
    """含某组关键词就在对应维度上加一。够验证余弦与聚合，不需要真语义。"""

    name = "fake-axes"
    AXES = (
        ("退款", "退钱", "退还", "时效", "多久", "几天", "慢"),
        ("物流", "快递", "发货", "配送", "送达"),
        ("发票", "开票", "抬头", "税率"),
    )

    def _vec(self, text: str) -> list[float]:
        vec = [0.0] * len(self.AXES)
        for i, keys in enumerate(self.AXES):
            for key in keys:
                if key in text:
                    vec[i] += 1.0
        return vec

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


class MemoryStore:
    """假的向量表（接口与 `kb.store` 的向量方法一致）。"""

    def __init__(self) -> None:
        self.rows: dict[int, tuple[str, list[bytes]]] = {}

    def upsert_embeddings(self, doc_id: int, model: str, vectors: list[bytes]) -> None:
        self.rows[int(doc_id)] = (model, list(vectors))

    def delete_embeddings(self, doc_id: int) -> None:
        self.rows.pop(int(doc_id), None)

    def load_embeddings(self, model: str) -> list[tuple[int, int, int, bytes]]:
        out: list[tuple[int, int, int, bytes]] = []
        for doc_id, (m, vectors) in sorted(self.rows.items()):
            if m != model:
                continue
            for idx, blob in enumerate(vectors):
                out.append((doc_id, idx, len(blob) // 4, blob))
        return out


def _paras(*texts: str) -> list[Paragraph]:
    return [Paragraph(line=i + 1, text=t) for i, t in enumerate(texts)]


@pytest.fixture
def index() -> SemanticIndex:
    return SemanticIndex(FakeEmbedder(), MemoryStore())


# ── normalize / pack ──────────────────────────────────────────────────


def test_normalize_makes_a_unit_vector():
    vec = normalize([3.0, 4.0])
    assert math.isclose(sum(x * x for x in vec), 1.0, rel_tol=1e-9)
    assert math.isclose(vec[0], 0.6, rel_tol=1e-9)


def test_normalize_of_a_zero_vector_stays_finite():
    # 全零不该除出 NaN（NaN 一旦混进点积，整张榜的分数都会变成 NaN 而无法排序）
    assert normalize([0.0, 0.0, 0.0]) == [0.0, 0.0, 0.0]


def test_pack_vector_roundtrips_as_normalized_float32():
    blob = pack_vector([0.0, 5.0])
    arr = unpack_vector(blob, 2)
    assert arr.dtype == np.float32
    assert math.isclose(float(arr[0]), 0.0, abs_tol=1e-6)
    assert math.isclose(float(arr[1]), 1.0, abs_tol=1e-6)


def test_unpack_rejects_a_length_mismatch():
    # 长度对不上说明这行坏了 —— 返回空数组让调用方跳过，而不是抛异常中断整轮重建
    assert unpack_vector(b"\x00\x00\x00\x00", 3).size == 0


# ── 语义检索 ──────────────────────────────────────────────────────────


def test_finds_related_document_without_literal_overlap(index: SemanticIndex):
    """核心诉求：问「客户嫌退款慢怎么回复」，文档写「退款时效说明」也要能命中。

    字面上一句是问句、一句是标题，没有共同的子串；靠语义轴对上。
    """
    index.index_document(1, _paras("退款时效说明：我们会在 24 小时内处理，请先安抚客户"))
    index.index_document(2, _paras("快递配送范围与运费说明"))

    hits = index.search("客户嫌退款慢怎么回复")

    assert [doc_id for doc_id, _, _ in hits] == [1]
    doc_id, score, para_idx = hits[0]
    assert score > 0.9
    assert para_idx == 0


def test_aggregates_to_document_and_returns_the_best_paragraph(index: SemanticIndex):
    # 同一文档两段命中，只出这一条，且片段指向更相关的那一段
    index.index_document(7, _paras("本店支持快递配送", "退款时效：一般 1~3 个工作日到账"))

    hits = index.search("退款要等几天")

    assert len(hits) == 1
    doc_id, _, para_idx = hits[0]
    assert doc_id == 7
    assert para_idx == 1


def test_unrelated_documents_are_gated_by_min_score(index: SemanticIndex):
    index.index_document(1, _paras("发票抬头与税率填写说明"))

    assert index.search("客户嫌退款慢怎么回复") == []


def test_index_document_replaces_previous_vectors(index: SemanticIndex):
    index.index_document(1, _paras("发票抬头填写说明"))
    assert index.search("退款时效") == []

    # 同一文档重索引：旧向量必须整体换掉，否则改过的段落还会按老内容被命中
    index.index_document(1, _paras("退款时效说明"))

    assert [doc_id for doc_id, _, _ in index.search("退款多久到账")] == [1]


def test_drop_document_removes_from_memory_and_store(index: SemanticIndex):
    store = index._store  # noqa: SLF001 —— 断言落库行为，需要看假存储的原始状态
    index.index_document(1, _paras("退款时效说明"))
    assert store.rows  # type: ignore[attr-defined]

    index.drop_document(1)

    assert index.size == 0
    assert index.search("退款时效") == []
    assert store.rows == {}  # type: ignore[attr-defined]


def test_load_restores_vectors_from_store(index: SemanticIndex):
    index.index_document(1, _paras("退款时效说明"))
    index.index_document(2, _paras("快递配送说明"))

    rebuilt = SemanticIndex(FakeEmbedder(), index._store)  # noqa: SLF001
    assert rebuilt.size == 0

    assert rebuilt.load() == 2
    assert [doc_id for doc_id, _, _ in rebuilt.search("退款多久到账")] == [1]


def test_min_score_constant_is_in_a_sane_range():
    # 闸门太松就灌噪声，太紧就永远搜不到；0.4 是 bge-small-zh 上的经验下界
    assert 0.2 <= MIN_SCORE <= 0.6


# ── RRF ───────────────────────────────────────────────────────────────


def test_rrf_scores_follow_the_reciprocal_rank_formula():
    fused = dict(rrf_fuse([[10, 20, 30]]))

    assert fused[10] == pytest.approx(1 / 61)
    assert fused[20] == pytest.approx(1 / 62)
    assert fused[30] == pytest.approx(1 / 63)


def test_rrf_rewards_documents_that_both_lists_rank():
    # 20 在两张榜里都出现（虽不在榜首），应压过只在单榜排第一的 10 / 30
    fused = dict(rrf_fuse([[10, 20], [30, 20]]))

    assert fused[20] > fused[10]
    assert fused[20] > fused[30]


def test_rrf_ties_break_by_id_so_order_is_deterministic():
    fused = rrf_fuse([[1, 2], [2, 1]])

    # 同分时按 id 升序 —— 同一查询两次给出不同顺序会让用户以为搜索在「飘」
    assert [doc_id for doc_id, _ in fused] == [1, 2]
    assert fused[0][1] == pytest.approx(fused[1][1])


def test_rrf_of_empty_rankings_is_empty():
    assert rrf_fuse([]) == []
    assert rrf_fuse([[], []]) == []
