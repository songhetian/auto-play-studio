"""切片 1：知识库抽取层。

真相源是**手搓的最小文件**（见 `kb_fixtures`）—— docx/xlsx 的字节由我们用 `zipfile`
手工拼出来，PDF 是手写字节流，**都不走被测库的写入路径**。所以这些断言回答的是
「真实文件能不能被正确抽出」，而不是「同一个库自己写自己读」。

一处例外：`pptx` 要 6 个互相引用的 XML 部件，手搓性价比太低，夹具由 python-pptx 生成 ——
但 `test_pptx_fixture_really_contains_the_text` 会绕开 python-pptx 直接看 zip 里的原始 XML，
把「夹具里到底有什么」这件事独立钉住。
"""
from __future__ import annotations

import os
import pathlib
import zipfile

import pytest

from engine.kb import extract
from tests import kb_fixtures as F


# ── 各格式的期望文本 ──────────────────────────────────────────────────

DOCX_TEXT = f"{F.REFUND}\n\n{F.SECOND}"
#: 一张表算一块，行与行用单个换行 —— `chunk_text` 把 `\n` 当句子边界，
#: 短表整块保留、长表自动在行边界切开。
XLSX_TEXT = " | ".join(F.SHEET_A) + "\n" + "\n".join(" | ".join(r) for r in F.SHEET_ROWS)
PPTX_TEXT = "\n\n".join(F.PPT_LINES)
PDF_TEXT = "Refund policy: 7 days"
PDF_CJK_TEXT = "退款政策：七天无理由"


@pytest.fixture
def docx_path(tmp_path) -> pathlib.Path:
    return F.write_docx(tmp_path / "退款政策.docx", [F.REFUND, F.SECOND])


@pytest.fixture
def xlsx_path(tmp_path) -> pathlib.Path:
    return F.write_xlsx(tmp_path / "工单样例.xlsx", [F.SHEET_A, *F.SHEET_ROWS])


@pytest.fixture
def pptx_path(tmp_path) -> pathlib.Path:
    return F.write_pptx(tmp_path / "话术.pptx", F.PPT_LINES)


@pytest.fixture
def pdf_path(tmp_path) -> pathlib.Path:
    return F.write_pdf(tmp_path / "policy.pdf", [PDF_TEXT])


# ── 各格式都能抽出写进去的字面量 ────────────────────────────────────────


def test_docx_paragraphs_become_blank_line_separated_blocks(docx_path):
    assert extract.extract_text(docx_path) == DOCX_TEXT


def test_docx_tables_are_read_in_document_order(tmp_path):
    """客服 SOP 大量内容是表格；只读段落会整块漏掉，且顺序不能乱。"""
    p = F.write_docx_body(
        tmp_path / "升级条件.docx",
        [
            ("p", "以下情况升级到主管"),
            ("tbl", [["金额", "动作"], ["100 元以下", "坐席直接处理"]]),
            ("p", "其余按常规流程"),
        ],
    )
    assert extract.extract_text(p) == (
        "以下情况升级到主管\n\n金额 | 动作\n100 元以下 | 坐席直接处理\n\n其余按常规流程"
    )


def test_xlsx_rows_become_blocks_with_piped_cells(xlsx_path):
    assert extract.extract_text(xlsx_path) == XLSX_TEXT


def test_pptx_text_boxes_become_blocks(pptx_path):
    assert extract.extract_text(pptx_path) == PPTX_TEXT


def test_pdf_page_text_is_extracted(pdf_path):
    assert extract.extract_text(pdf_path) == PDF_TEXT


def test_cjk_pdf_text_is_extracted(tmp_path):
    """中文 PDF 由 reportlab 生成、pypdf 读 —— 跨库，不是同库读写。"""
    p = F.write_pdf_cjk(tmp_path / "中文.pdf", PDF_CJK_TEXT)
    assert extract.extract_text(p) == PDF_CJK_TEXT


@pytest.mark.parametrize("name", ["说明.md", "话术.txt"])
def test_plain_text_is_read_as_is(tmp_path, name):
    p = tmp_path / name
    p.write_text(F.PLAIN, encoding="utf-8")
    assert extract.extract_text(p) == F.PLAIN


# ── 中文环境里真实存在的两种编码 ──────────────────────────────────────


def test_gbk_encoded_text_is_readable(tmp_path):
    """Windows 上大量老 txt 是 GBK，按 UTF-8 硬读会整篇乱码或直接抛异常。"""
    p = tmp_path / "gbk.txt"
    p.write_bytes("客服退款话术\n\n七天内无理由".encode("gbk"))
    assert extract.extract_text(p) == "客服退款话术\n\n七天内无理由"


def test_utf8_bom_is_stripped(tmp_path):
    """记事本存 UTF-8 会带 BOM；BOM 混进正文会让「第一个词搜不到」。"""
    p = tmp_path / "bom.txt"
    p.write_bytes("客服话术".encode("utf-8-sig"))
    assert extract.extract_text(p) == "客服话术"


def test_surrounding_whitespace_is_stripped(tmp_path):
    """同一份内容从 md 与 docx 抽出来应当一致，首尾空行没有信息量。"""
    p = tmp_path / "blank.txt"
    p.write_text("\n\n内容\n\n\n", encoding="utf-8")
    assert extract.extract_text(p) == "内容"


def test_crlf_line_endings_are_normalized(tmp_path):
    """Windows 上的 txt 普遍是 CRLF。留着 `\\r` 会让片段显示多出看不见的字符、
    也会让高亮偏移算错，所以抽取层统一成 LF。"""
    p = tmp_path / "crlf.txt"
    p.write_bytes("第一段\r\n\r\n第二段\r\n".encode("utf-8"))
    assert extract.extract_text(p) == "第一段\n\n第二段"


# ── 坏输入不能把整次索引带崩 ──────────────────────────────────────────


def test_unsupported_extension_is_rejected(tmp_path):
    p = tmp_path / "安装包.exe"
    p.write_bytes(b"MZ\x90\x00")
    with pytest.raises(extract.UnsupportedType):
        extract.extract_text(p)


def test_corrupt_file_fails_with_a_readable_reason(tmp_path):
    """知识库文件夹里有一个坏文件是常态，报错要能指明是谁、为什么。"""
    p = tmp_path / "坏掉.pdf"
    p.write_bytes(b"%PDF-1.4\n" + "这不是一个真的 PDF 结构".encode("utf-8"))
    with pytest.raises(extract.ExtractError) as e:
        extract.extract_text(p)
    assert "坏掉.pdf" in str(e.value)


# ── RawFile：元信息与截断 ─────────────────────────────────────────────


def test_raw_file_carries_metadata(docx_path):
    os.utime(docx_path, (1_700_000_000, 1_700_000_000))
    raw = extract.read_raw_file(docx_path)

    assert raw.name == "退款政策.docx"
    assert raw.path == str(docx_path)
    assert raw.size == docx_path.stat().st_size
    assert raw.mtime == 1_700_000_000
    assert raw.text == DOCX_TEXT
    assert raw.truncated is False


def test_oversized_text_is_truncated(tmp_path):
    """50 万字符封顶：一本几 MB 的手册不该把整个索引拖垮。"""
    p = tmp_path / "巨无霸.txt"
    p.write_text("汉" * (extract.MAX_CHARS + 500), encoding="utf-8")

    raw = extract.read_raw_file(p)

    assert len(raw.text) == extract.MAX_CHARS
    assert raw.truncated is True
    assert raw.size > extract.MAX_CHARS  # size 是文件字节数，不随截断变化


def test_normal_file_is_not_flagged_as_truncated(tmp_path):
    p = tmp_path / "小文件.txt"
    p.write_text("汉" * 100, encoding="utf-8")
    assert extract.read_raw_file(p).truncated is False


# ── 夹具自身的出处（独立于 python-pptx） ────────────────────────────────


@pytest.mark.parametrize("index", [0, 1])
def test_pptx_fixture_really_contains_the_text(pptx_path, index):
    with zipfile.ZipFile(pptx_path) as z:
        xml = z.read(f"ppt/slides/slide{index + 1}.xml").decode("utf-8")
    assert F.PPT_LINES[index] in xml
