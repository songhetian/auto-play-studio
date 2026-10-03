"""know 知识库测试夹具：**手搓的最小文件**。

为什么不用被测库来生成夹具：docx / xlsx / pptx 本质是 ZIP + XML，如果夹具用
python-docx 写出、再用 python-docx 读回，那测试断言的是「同一套代码的自洽」，
而不是「真实文件能被正确抽取」。所以这里用 `zipfile` 手写最小合法 OOXML，
PDF 手写最小字节流 —— 夹具的字节内容由我们完全掌握，期望值就是写进去的字面量。

`pptx` 是唯一例外（最少需要 6 个互相引用的 XML 部件，手搓性价比太低）：
用 python-pptx 生成，但测试里会**独立于 python-pptx** 解压校验原始 XML 确实含该文本。
"""
from __future__ import annotations

import pathlib
import zipfile

# ── 字面量：所有夹具共用，测试断言的就是这些串 ──────────────────────────────

REFUND = "退款政策：7 天无理由退还"
SECOND = "第二段：运费由商家承担"
SHEET_A = ["订单号", "客户", "问题"]
SHEET_ROWS = [["A001", "张三", "退款"], ["A002", "李四", "物流"]]
PPT_LINES = ["客服话术第一页", "第二页：先安抚情绪"]
PLAIN = "纯文本第一块\n\n纯文本第二块"


# ── docx ──────────────────────────────────────────────────────────────


def write_docx(path: pathlib.Path, paragraphs: list[str]) -> pathlib.Path:
    return write_docx_body(path, [("p", t) for t in paragraphs])


def write_docx_body(path: pathlib.Path, blocks: list[tuple]) -> pathlib.Path:
    """`blocks` 按文档顺序混排正文与表格：`("p", 文本)` / `("tbl", [[单元格, ...], ...])`。

    客户 SOP 里大量内容是表格（话术对照、升级条件），只读段落会整块漏掉。
    """
    parts = []
    for kind, payload in blocks:
        if kind == "p":
            parts.append(f"<w:p><w:r><w:t>{payload}</w:t></w:r></w:p>")
        else:
            rows = "".join(
                "<w:tr>"
                + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row)
                + "</w:tr>"
                for row in payload
            )
            parts.append(f"<w:tbl><w:tblPr/><w:tblGrid/>{rows}</w:tbl>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{''.join(parts)}</w:body></w:document>",
        )
    return path


# ── xlsx ──────────────────────────────────────────────────────────────


def _sheet_xml(rows: list[list[str]]) -> str:
    out = []
    for r, row in enumerate(rows, start=1):
        cells = "".join(
            f'<c r="{chr(65 + c)}{r}" t="inlineStr"><is><t>{v}</t></is></c>'
            for c, v in enumerate(row)
            if v != ""
        )
        if cells:
            out.append(f'<row r="{r}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(out)}</sheetData></worksheet>"
    )


def write_xlsx(path: pathlib.Path, rows: list[list[str]], sheet_name: str = "Sheet1") -> pathlib.Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.'
            'openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        z.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            "</Relationships>",
        )
        z.writestr("xl/worksheets/sheet1.xml", _sheet_xml(rows))
    return path


# ── pptx ──────────────────────────────────────────────────────────────


def write_pptx(path: pathlib.Path, lines: list[str]) -> pathlib.Path:
    """用 python-pptx 生成（手搓 pptx 要 6 个互相引用的 XML 部件，不值当）。

    测试侧会独立解压校验 `ppt/slides/slide1.xml` 的原始 XML 含这些字面量，
    所以「夹具里到底有什么」不依赖生成库的自述。
    """
    from pptx import Presentation
    from pptx.util import Inches

    prs = Presentation()
    blank = prs.slide_layouts[6]
    for line in lines:
        slide = prs.slides.add_slide(blank)
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
        box.text_frame.text = line
    prs.save(str(path))
    return path


# ── pdf ───────────────────────────────────────────────────────────────


def write_pdf(path: pathlib.Path, lines: list[str]) -> pathlib.Path:
    """手写最小 PDF（ASCII 文本，Helvetica，无嵌入字体）。

    中文 PDF 需要嵌入 CID 字体，手搓不现实 —— 中文那份由 `write_pdf_cjk` 用
    **另一个库**生成，保证跨库而非同库读写。
    """
    content = "BT /F1 18 Tf 72 720 Td 24 TL\n" + "".join(f"({line}) Tj T*\n" for line in lines) + "ET"
    stream = content.encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    ).encode()
    path.write_bytes(bytes(out))
    return path


def write_pdf_cjk(path: pathlib.Path, text: str) -> pathlib.Path:
    """中文 PDF：用 reportlab 生成（与读取用的 pypdf 不同源，避免同库读写）。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    c = canvas.Canvas(str(path))
    c.setFont("STSong-Light", 14)
    c.drawString(72, 720, text)
    c.save()
    return path
