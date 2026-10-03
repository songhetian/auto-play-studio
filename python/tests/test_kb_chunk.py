"""切片 2：段落切分。

取件自 know 的 `chunkText`（`app/src/engine/parsers.ts`），规则是：

- 按**空行**（`\\n\\s*\\n`）分块，块内首尾空白剥掉，空块丢掉；
- 块 ≤ `MAX_CHUNK` 字 → 整块成一段；
- 超了 → 按**句边界**（`。！？!?` 与换行）切开，再**贪心并回去**直到接近上限。
  并的时候是「先判再并」：所以长句永远不会被劈成两半，只是它自己会超过上限。

**行号**是给「打开原文件跳到第 N 行」用的，从 1 开始按已产出的段落累加
（一段占几行就加几行）。前导空行不占行号 —— 这一点在设备上是无害的，
因为抽取层已经剥掉了首尾空白（见 `test_kb_extract`）。

期望值全部是手算的：给定输入，按上面的规则手推每一步 buf 的内容与行号。
"""
from __future__ import annotations

import pytest

from engine.kb import chunk
from engine.kb.chunk import Paragraph


def p(line: int, text: str) -> Paragraph:
    return Paragraph(line=line, text=text)


# ── 分块与行号 ────────────────────────────────────────────────────────


def test_short_blocks_each_become_one_paragraph_and_lines_accumulate():
    text = "第一块\n\n第二块\n还有一行\n\n第三块"
    assert chunk.chunk_text(text) == [
        p(1, "第一块"),
        p(2, "第二块\n还有一行"),  # 占两行 → 下一段从第 4 行开始
        p(4, "第三块"),
    ]


def test_the_blank_line_may_carry_spaces():
    """从 Word 里粘出来的文本，空行上常留着空格。"""
    assert chunk.chunk_text("第一块\n   \n第二块") == [p(1, "第一块"), p(2, "第二块")]


def test_blank_input_yields_nothing():
    assert chunk.chunk_text("") == []
    assert chunk.chunk_text("\n\n  \n\n") == []


def test_blocks_are_trimmed():
    assert chunk.chunk_text("  第一块  \n\n\t第二块\t") == [p(1, "第一块"), p(2, "第二块")]


def test_crlf_is_normalized_inside_a_block():
    """抽取层已经归一化过，但 `chunk_text` 是纯函数，自己也要能吃 CRLF ——
    留着 `\\r` 会让片段显示与高亮偏移都算错。"""
    assert chunk.chunk_text("第一块\r\n第二行\r\n\r\n第二块") == [
        p(1, "第一块\n第二行"),
        p(3, "第二块"),
    ]


# ── 阈值：80 字这道线 ─────────────────────────────────────────────────


def _sentence(ch: str, length: int) -> str:
    """构造长度恰好为 `length` 的一句（以句号结尾）。"""
    return ch * (length - 1) + "。"


#: 阈值两侧的两句：合计 `MAX_CHUNK` 与 `MAX_CHUNK + 1`
_HALF = chunk.MAX_CHUNK // 2
_AT_LIMIT = _sentence("甲", _HALF) + _sentence("乙", chunk.MAX_CHUNK - _HALF)
_OVER_LIMIT = _sentence("甲", _HALF) + _sentence("乙", chunk.MAX_CHUNK - _HALF + 1)


def test_a_block_of_exactly_the_limit_is_kept_whole():
    assert len(_AT_LIMIT) == chunk.MAX_CHUNK
    assert chunk.chunk_text(_AT_LIMIT) == [p(1, _AT_LIMIT)]


def test_one_character_over_the_limit_splits_at_the_sentence_boundary():
    first, second = _sentence("甲", _HALF), _sentence("乙", chunk.MAX_CHUNK - _HALF + 1)
    assert len(first + second) == chunk.MAX_CHUNK + 1
    assert chunk.chunk_text(first + second) == [p(1, first), p(2, second)]


def test_a_long_sentence_keeps_its_short_neighbour_separate():
    """长句自己超上限也整段保留，不会被从中间切开；短句另起一段。"""
    long_sentence = "汉" * (chunk.MAX_CHUNK * 2) + "。"
    assert chunk.chunk_text(long_sentence + "短句。") == [
        p(1, long_sentence),
        p(2, "短句。"),
    ]


def test_a_sentence_without_any_punctuation_is_kept_whole():
    """整篇没有标点的块（比如一段被拍平的长文本）不该被硬切。"""
    text = "汉" * (chunk.MAX_CHUNK * 3)
    assert chunk.chunk_text(text) == [p(1, text)]


def test_short_sentences_are_packed_greedily_up_to_the_limit():
    """三句各 30 字：前两句并成一段（60 字，仍在上限内），第三句另起。"""
    one = "三" * 29 + "。"  # 30 字
    assert chunk.chunk_text(one * 3) == [p(1, one + one), p(2, one)]


# ── 与抽取层的接缝：换行也是句边界 ─────────────────────────────────────


def test_newline_counts_as_a_sentence_boundary_so_rows_are_never_split():
    """抽取层把「一张表」做成一块、行用换行分隔（见 `test_kb_extract`）。
    这里钉住接缝：超长的表会在**行边界**被切开，绝不会从一行中间劈开。"""
    rows = [f"第{i}行" + "字" * 26 for i in range(4)]  # 每行 29 字
    text = "\n".join(rows)  # 119 字，超过上限
    assert chunk.chunk_text(text) == [
        p(1, rows[0] + "\n" + rows[1]),  # 两行一整块（段落不会以换行结尾）
        p(3, rows[2] + "\n" + rows[3]),
    ]


@pytest.mark.parametrize(
    "text",
    ["没有空行的\n单块文本", "第一块\n\n第二块", "只有一块"],
)
def test_chunking_never_invents_or_loses_text(text):
    """不变量：所有段落的正文拼起来，去掉分隔与空白后必须等于原文。"""
    joined = "".join(par.text for par in chunk.chunk_text(text))
    assert "".join(joined.split()) == "".join(text.split())
