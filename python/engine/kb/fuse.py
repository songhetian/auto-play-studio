"""RRF（Reciprocal Rank Fusion）：把多路排名的名次融合成一个名次。

为什么用 RRF 而不是把 BM25 分和余弦相似度加权相加：两路分**不在一个量纲上**
—— BM25 是「词频 × IDF 的累加」（可以是几十上百），余弦是 [-1, 1]。
要相加得先把两边各自归一化，而归一化系数只能靠调，调完还会随语料漂。

RRF 只看**名次**：`Σ 1/(k + rank)`。天然免疫量纲、没有可调的权重，
所以它既好单测，也不会因为换了一批文档就悄悄失准。

`k = 60` 是 RRF 原论文的经验默认值：k 越大，头部几名之间的差距越平缓
（对「谁是第一」不那么自信）；60 在多数检索任务上都是稳的。

实现在这里只有几行，但它是「关键词 + 语义」能合成同一张榜的唯一理由，
所以单独成模块、单独测。
"""
from __future__ import annotations

from typing import Iterable, Sequence

#: RRF 的平滑系数（原论文默认 60）
RRF_K = 60


def rrf_fuse(rankings: Iterable[Sequence[int]], k: int = RRF_K) -> list[tuple[int, float]]:
    """多路排名 → `[(id, 分)]`，按分数降序。

    `rankings` 里每一路是从高到低的 id 列表（第 0 名 rank = 1）。
    同分时按 id 升序兜底 —— 让结果**确定**：同一查询两次给出不同顺序，
    用户会以为搜索在「飘」，而这类不稳定最难归因。
    """
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
