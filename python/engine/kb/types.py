"""知识库的数据形状（与 know 的 `types.ts` 对应）。

`Paragraph` 不在这里 —— 它是切分器的产物，家在 `chunk.py`。
"""
from __future__ import annotations

import dataclasses

from .chunk import Paragraph


@dataclasses.dataclass
class IndexedDocument:
    """一个已入库的文档。

    `paragraphs` 允许为空：段落可以只在 `ParagraphStore` 里（懒加载），
    这样引擎常驻内存的只有倒排索引与各段落的小写副本，不带原文。
    """

    id: int
    file_name: str
    file_type: str
    path: str
    paragraphs: list[Paragraph] = dataclasses.field(default_factory=list)
    #: 文件字节数（展示用）
    size: int = 0
    #: 修改时间 epoch 秒（展示用）
    mtime: float = 0.0
    #: 文本是否被截断（见 `extract.MAX_CHARS`）
    truncated: bool = False


@dataclasses.dataclass
class SearchResult:
    """一条命中。

    `matched_paragraphs` 可能是空的（只命中文件名），也可能是**预览段落**
    （只命中拼音）—— 前端要能区分「这是命中片段」和「这是给你看看这是不是那份文件」。
    """

    document: IndexedDocument
    matched_paragraphs: list[Paragraph]
    score: float
    #: 'and' | 'or'；`or` 表示 AND 没结果、放宽后的兜底结果
    match_mode: str
