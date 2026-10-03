"""段落切分：把抽取出来的纯文本切成可检索的段落。

取件自 know 的 `chunkText`（`know/app/src/engine/parsers.ts`），规则不变：

1. 按**空行**分块（`\\n\\s*\\n`，空行上的空格不算内容），块首尾剥白，空块丢掉；
2. 块 ≤ `MAX_CHUNK` 字 → 整块成一段；
3. 超了 → 按**句边界**（`。！？!?` 与换行）切开，再**贪心并回去**。
   并的时候先判再并，所以**长句永远不会被劈成两半** —— 它自己单独超过上限，
   而不是被切成两句读不通的话。没有标点的块同理整块保留。

段落粒度决定命中片段的粒度，所以这里的阈值是个**手感参数**，不是性能参数：
太小则片段读不出上下文，太大则一屏塞不下。
"""
from __future__ import annotations

import dataclasses
import re

#: 单段字数上限（超过就在句边界切）
MAX_CHUNK = 80

#: 块分隔：一个空行，允许空行上有空白
_BLOCK_SEP = re.compile(r"\n\s*\n")

#: 句边界。**换行也算** —— 抽取层把「一张表」做成一块、行用换行分隔，
#: 于是超长的表会在行边界被切开，绝不会从一行中间劈开。
_SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?\n])")


@dataclasses.dataclass(frozen=True)
class Paragraph:
    """一个可检索的段落。

    只有 `line` 与 `text`：know 的 `Paragraph` 还有 `page`，但它的 `chunkText`
    **永远写 0**（UI 里「第 N 页」的分支因此是死的，测试夹具里的页码是手填的）——
    不把假字段搬进来。真页码的机会记在工单 `20-know-search.md` 的后续里。
    """

    #: 在抽取出来的文本里的起始行号（从 1 开始），用于「打开原文件跳到这一行」
    line: int
    text: str


def chunk_text(text: str) -> list[Paragraph]:
    """切分纯文本。纯函数。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")

    paras: list[Paragraph] = []
    line_no = 1

    def push(chunk: str) -> None:
        nonlocal line_no
        trimmed = chunk.strip()
        if not trimmed:
            return
        paras.append(Paragraph(line=line_no, text=trimmed))
        line_no += trimmed.count("\n") + 1

    for block in (b.strip() for b in _BLOCK_SEP.split(normalized)):
        if not block:
            continue
        if len(block) <= MAX_CHUNK:
            push(block)
            continue
        buf = ""
        for sentence in _SENTENCE_BOUNDARY.split(block):
            if not sentence.strip():
                continue
            if buf and len(buf) + len(sentence) > MAX_CHUNK:
                push(buf)
                buf = ""
            buf += sentence
        push(buf)

    return paras
