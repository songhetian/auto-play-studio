"""真实模型推理的契约测试：模型资产在场才跑，否则整文件 skip。

这里验的是「模型接线对了」——维度、归一化、查询/段落两侧的口径，
以及最要紧的一条：**语义相关的文本余弦更高**。
至于检索/融合逻辑对不对，由假 embedder 的用例守（不依赖这 24MB 资产）。

模型不在场时 skip 而不是 fail：模型是可选资产，CI / 新机器上没下载
不该让测试变红。
"""
from __future__ import annotations

import pytest

from engine.kb import embed

pytestmark = pytest.mark.skipif(
    not any(embed._looks_like_model(d) for d in embed._candidate_dirs()),  # noqa: SLF001
    reason="本机没有 bge-small-zh-v1.5 模型资产（见 python/scripts/fetch_kb_model.py）",
)


@pytest.fixture(autouse=True)
def _real_model(monkeypatch):
    """绕开 conftest 设的 `AUTOPLAY_KB_DISABLE_SEMANTIC`，强制走真实模型。"""
    monkeypatch.delenv("AUTOPLAY_KB_DISABLE_SEMANTIC", raising=False)
    embed.reset_embedder()
    yield
    embed.reset_embedder()


def _cos(a: list[float], b: list[float]) -> float:
    return sum(float(x) * float(y) for x, y in zip(a, b))


def test_model_loads_and_embeds_to_512_dims():
    e = embed.get_embedder()

    assert e is not None
    vectors = e.embed(["退款时效说明"])
    assert len(vectors) == 1
    assert len(vectors[0]) == 512


def test_embeddings_are_l2_normalized():
    e = embed.get_embedder()
    vec = e.embed(["退款时效说明：我们会在 24 小时内处理"])[0]

    assert sum(x * x for x in vec) == pytest.approx(1.0, abs=1e-3)


def test_semantically_related_text_scores_higher_than_unrelated():
    """P0 的立身之本：问句和「退款时效说明」字面不重合，语义上要更近。"""
    e = embed.get_embedder()
    query = e.embed_query("客户嫌退款慢怎么回复")

    related = e.embed(["退款时效说明：我们会在 24 小时内处理，请先安抚客户"])[0]
    unrelated = e.embed(["今天天气不错，适合出门散步"])[0]

    assert _cos(query, related) > _cos(query, unrelated)
