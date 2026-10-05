"""语义检索：段落向量 + 暴力余弦 + 文档级聚合。

## 为什么不接向量库

量级是几百~几千份文档（几万段）。一个 `(N, 512)` 的 float32 矩阵在内存里
几十 MB，一次全量点积是毫秒级 —— 暴力算完全够。引一个向量库要多一个依赖、
多一份还得跟 SQLite 同步的存储，换不来任何东西。

## 归一化放在写入时

`pack_vector` 先把向量 L2 归一化再落库。于是检索时**余弦退化成点积**，
一次矩阵乘法搞定；查询向量在检索前也归一化，两边口径一致。
若等到检索时才除，每个查询都要多做 N 次开方。

## 文档级聚合

命中粒度是段落，但结果粒度是**文档**（与关键词检索一致）：同一文档取
相似度最高的那一段作为它的分数，并把那一段的序号带回去当片段。
若这里按段落出结果，融合时两路的名次口径就对不齐 —— 一个按文档排、
一个按段落排，RRF 没有共同的名次。

## 内存矩阵「脏了才重建」

索引器逐份文档写向量（`index_document` / `drop_document`）。每写一份都重排
一次矩阵是 O(N²)；所以这里只改 `_docs`（文档 → 段落矩阵）并打脏标记，
检索时若脏了才一次性 `vstack`。一批改动只付一次重建。
"""
from __future__ import annotations

import math
from typing import Protocol, Sequence

import numpy as np

from .chunk import Paragraph

#: 语义命中的最低余弦相似度。
#: 向量检索**总会**给出「最像的几条」，哪怕它们跟查询毫无关系；不设闸门，
#: 每个查询都会被塞满语义噪声。bge-small-zh 上 0.4 大致是「相关」的下界
#: （不相关的通常落在 0.2~0.4）。
MIN_SCORE = 0.4

#: 一次语义检索最多取回多少条文档
DEFAULT_TOP_K = 50


def normalize(vec: Sequence[float]) -> list[float]:
    """L2 归一化。零向量原样返回 —— 不能除出 NaN，那会污染后续所有点积。"""
    norm = math.sqrt(sum(float(x) * float(x) for x in vec))
    if norm <= 0.0:
        return [0.0] * len(vec)
    return [float(x) / norm for x in vec]


def pack_vector(vec: Sequence[float]) -> bytes:
    """归一化 → float32（小端）字节。把归一化前移到写入路径。"""
    return np.asarray(normalize(vec), dtype="<f4").tobytes()


def unpack_vector(blob: bytes, dim: int) -> np.ndarray:
    """BLOB → float32 一维数组。长度与 `dim` 对不上就返回空数组（当作坏行跳过）。"""
    if dim <= 0:
        return np.zeros(0, dtype=np.float32)
    arr = np.frombuffer(blob, dtype="<f4")
    if int(arr.size) != int(dim):
        return np.zeros(0, dtype=np.float32)
    return arr.astype(np.float32, copy=True)


class Embedder(Protocol):
    """「文本 → 向量」的接口。真实实现在 `embed.py`；测试塞假实现。

    `embed` 编码段落，`embed_query` 编码查询 —— 非对称检索模型
    （BGE 等）对两侧的处理不同，这个差异封在实现里。
    """

    @property
    def name(self) -> str: ...

    def embed(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class EmbeddingStore(Protocol):
    """向量落库要用的那几个方法（`kb.store` 提供）。"""

    def upsert_embeddings(self, doc_id: int, model: str, vectors: list[bytes]) -> None: ...

    def delete_embeddings(self, doc_id: int) -> None: ...

    def load_embeddings(self, model: str) -> list[tuple[int, int, int, bytes]]: ...


class SemanticIndex:
    """内存向量索引 + 落库。一个实例只服务一个模型。"""

    def __init__(self, embedder: Embedder, row_store: EmbeddingStore) -> None:
        self._embedder = embedder
        self._store = row_store
        self._docs: dict[int, np.ndarray] = {}
        self._matrix: np.ndarray | None = None
        self._rows: list[tuple[int, int]] = []
        self._dirty = True
        self._dim = 0

    # ── 只读信息 ──────────────────────────────────────────────────────

    @property
    def model(self) -> str:
        return self._embedder.name

    @property
    def size(self) -> int:
        """已索引的段落数。"""
        return sum(int(b.shape[0]) for b in self._docs.values())

    @property
    def dim(self) -> int:
        return self._dim

    # ── 冷启动 ────────────────────────────────────────────────────────

    def load(self) -> int:
        """从库读回**本模型**的向量，返回加载的段落数。

        换过模型的旧向量不混用：只认 `self.model` 这个模型名，
        维度不一致的行也直接丢。混用不会报错，只会让排序悄悄变差。
        """
        self._docs = {}
        self._matrix = None
        self._rows = []
        self._dirty = True
        self._dim = 0

        buckets: dict[int, list[tuple[int, np.ndarray]]] = {}
        for doc_id, idx, dim, blob in self._store.load_embeddings(self._embedder.name):
            vec = unpack_vector(blob, dim)
            if vec.size == 0:
                continue
            if self._dim and int(vec.size) != self._dim:
                continue
            self._dim = int(vec.size)
            buckets.setdefault(doc_id, []).append((idx, vec))

        for doc_id, items in buckets.items():
            items.sort(key=lambda it: it[0])
            self._docs[doc_id] = np.vstack([vec for _, vec in items])
        return self.size

    # ── 写入 ──────────────────────────────────────────────────────────

    def index_document(self, doc_id: int, paragraphs: list[Paragraph]) -> int:
        """向量化一份文档的全部段落：落库 + 更新内存。返回写入的段落数。

        先 drop 再写：同一 doc 重索引时旧向量必须整体换掉 ——
        留下任何一行，改过的段落都会继续按老内容被语义命中。
        """
        self.drop_document(doc_id)
        texts = [p.text for p in paragraphs]
        if not texts:
            return 0
        vectors = self._embedder.embed(texts)
        packed = [pack_vector(vec) for vec in vectors]
        self._store.upsert_embeddings(doc_id, self._embedder.name, packed)
        self._put(doc_id, packed)
        return len(packed)

    def drop_document(self, doc_id: int) -> None:
        self._store.delete_embeddings(doc_id)
        if self._docs.pop(doc_id, None) is not None:
            self._dirty = True

    def _put(self, doc_id: int, packed: list[bytes]) -> None:
        vecs = [np.frombuffer(blob, dtype="<f4") for blob in packed]
        vecs = [vec for vec in vecs if vec.size]
        if not vecs:
            return
        dim = int(vecs[0].size)
        if self._dim and dim != self._dim:
            # 维度变了（换了模型）：内存里旧的行全部丢掉，别混着当点积算子
            self._docs = {}
            self._matrix = None
            self._rows = []
        self._dim = dim
        self._docs[doc_id] = np.vstack(vecs)
        self._dirty = True

    # ── 检索 ──────────────────────────────────────────────────────────

    def embed_query(self, text: str) -> list[float]:
        return self._embedder.embed_query(text)

    def search(
        self,
        query: str,
        top_k: int = DEFAULT_TOP_K,
        min_score: float = MIN_SCORE,
    ) -> list[tuple[int, float, int]]:
        """查询 → `[(doc_id, 相似度, 最相关段落在该文档内的序号)]`，按相似度降序。

        同一文档多段命中只留最像的那段 —— 输出是文档级的，和关键词检索对齐。
        """
        self._ensure_matrix()
        if self._matrix is None or self._matrix.size == 0:
            return []
        q = np.asarray(normalize(self.embed_query(query)), dtype="<f4")
        if int(q.size) != int(self._matrix.shape[1]):
            return []

        sims = self._matrix @ q
        best: dict[int, tuple[float, int]] = {}
        for i in range(int(sims.shape[0])):
            score = float(sims[i])
            if score < min_score:
                continue
            doc_id, idx = self._rows[i]
            cur = best.get(doc_id)
            if cur is None or score > cur[0]:
                best[doc_id] = (score, idx)

        ranked = sorted(best.items(), key=lambda kv: (-kv[1][0], kv[0]))
        return [(doc_id, score, idx) for doc_id, (score, idx) in ranked[: max(int(top_k), 0)]]

    def _ensure_matrix(self) -> None:
        if not self._dirty:
            return
        if not self._docs:
            self._matrix = None
            self._rows = []
            self._dirty = False
            return
        blocks: list[np.ndarray] = []
        rows: list[tuple[int, int]] = []
        for doc_id in sorted(self._docs):
            block = self._docs[doc_id]
            if block.size == 0:
                continue
            blocks.append(block)
            # 块内第 i 行 = 该文档的第 i 段（`index_document` 按段落顺序写入）
            for i in range(int(block.shape[0])):
                rows.append((doc_id, i))
        self._matrix = np.vstack(blocks) if blocks else None
        self._rows = rows
        self._dirty = False
