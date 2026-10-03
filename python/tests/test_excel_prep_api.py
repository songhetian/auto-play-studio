"""切片 4：`/api/excel/*` 的 HTTP 契约。

两件事只有在这一层才定得下来：

1. **字段名 camelCase。** 引擎内部是 snake_case，前端读 camelCase —— 一次写错，
   页面不报错、整块面板空白，排查起来要翻两边。所以这里把返回体的**键集合**钉死。
2. **下载/打开只认自己产出的文件。** 这是个本机进程，`?path=` 由前端拼；
   「能读任意路径」就等于给任何字符串配了一个读文件的动作。
"""
from __future__ import annotations

import os
import pathlib

import pytest

from engine.excel_prep import service
from tests import excel_prep_fixtures as F

REPORT_KEYS = {"path", "sheet", "headerRow", "columns", "dataRows", "keyCol", "issues"}
ISSUE_KEYS = {"kind", "severity", "rows", "cols", "detail"}
CLEAN_KEYS = {"output", "fileName", "sheet", "rowsKept", "colsKept", "changes"}
CHANGE_KEYS = {"kind", "detail", "row", "col", "before", "after"}


@pytest.fixture(autouse=True)
def _fresh_registry():
    """产出的文件是进程级的，测试之间必须互不影响。"""
    service.reset()
    yield
    service.reset()


def inspect(client, path: str, key_col: str = F.MESSY_KEY_COL):
    return client.get("/api/excel/inspect", params={"path": path, "keyCol": key_col})


def clean(client, path: str, key_col: str = F.MESSY_KEY_COL, accept_risk: bool = False):
    return client.post("/api/excel/clean", json={"path": path, "keyCol": key_col, "acceptRisk": accept_risk})


# ── 体检 ──────────────────────────────────────────────────────────────


def test_inspect_returns_the_report(client, tmp_path):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    resp = inspect(client, src)

    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == src
    assert body["sheet"] == "导出"
    assert body["headerRow"] == F.M_HEADER
    assert body["dataRows"] == F.MESSY_DATA_ROWS
    assert body["columns"] == ["订单编号", "客户名称 ", "处理备注"]
    assert body["keyCol"] == F.MESSY_KEY_COL
    assert {i["kind"] for i in body["issues"]} == {
        "header_whitespace",
        "blank_row",
        "duplicate_row",
        "key_whitespace",
        "blank_key",
        "duplicate_key",
    }


def test_the_report_payload_keys_are_pinned(client, tmp_path):
    """键拼错一个字母，页面上就是一块空白 —— 不报错，只是没内容。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    body = inspect(client, src).json()

    assert set(body) == REPORT_KEYS
    assert set(body["issues"][0]) == ISSUE_KEYS


def test_inspect_says_which_rows_and_columns_an_issue_touches(client, tmp_path):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    body = inspect(client, src).json()

    blank = next(i for i in body["issues"] if i["kind"] == "blank_key")
    assert blank["rows"] == [F.M_NO_KEY]
    assert blank["cols"] == []
    assert blank["severity"] == "fix"
    assert isinstance(blank["detail"], str) and blank["detail"]


def test_inspect_works_before_a_key_column_is_chosen(client, tmp_path):
    """刚选中文件、还没选主键列时不能报错 —— 页面这时候就要显示列名给用户挑。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    resp = inspect(client, src, key_col="")

    assert resp.status_code == 200
    assert resp.json()["columns"] == ["订单编号", "客户名称 ", "处理备注"]


def test_inspect_a_missing_file_is_a_404(client, tmp_path):
    resp = inspect(client, str(tmp_path / "没有这个文件.xlsx"))

    assert resp.status_code == 404


def test_inspect_a_file_that_is_not_a_workbook_is_a_400(client, tmp_path):
    """csv 在这条链路上读不了（openpyxl 不认），要让用户看到一句人话，不是 500。"""
    path = tmp_path / "report.csv"
    path.write_text("订单编号,客户名称\nA001,张三\n", encoding="utf-8")

    resp = inspect(client, str(path))

    assert resp.status_code == 400
    assert "xlsx" in resp.json()["detail"]


def test_inspect_with_a_wrong_key_column_is_a_400_not_a_500(client, tmp_path):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    resp = inspect(client, src, key_col="不存在的列")

    assert resp.status_code == 400
    assert "不存在的列" in resp.json()["detail"]


# ── 整理 ──────────────────────────────────────────────────────────────


def test_clean_writes_the_file_and_returns_the_log(client, tmp_path):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    resp = clean(client, src)

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == CLEAN_KEYS
    assert body["fileName"] == "messy_已整理.xlsx"
    assert body["output"] == str(tmp_path / "messy_已整理.xlsx")
    assert pathlib.Path(body["output"]).exists()
    assert body["rowsKept"] == list(F.MESSY_KEPT_ROWS)
    assert body["colsKept"] == [1, 2, 3]
    assert set(body["changes"][0]) == CHANGE_KEYS


def test_the_changes_in_the_payload_carry_the_original_coordinates(client, tmp_path):
    """台账给的是**原文件**的行号 —— 输出的行号已经漂了，用户拿着它对不上自己的表。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    body = clean(client, src).json()

    removed = sorted(c["row"] for c in body["changes"] if c["col"] == 0)
    assert removed == [F.M_BLANK_ROW, F.M_SAME_AS_FIRST, F.M_NO_KEY]
    trimmed = next(c for c in body["changes"] if c["kind"] == "key_whitespace")
    assert (trimmed["row"], trimmed["col"]) == (F.M_SPACEY_KEY, 1)
    assert trimmed["before"] == "  A005  "
    assert trimmed["after"] == "A005"


def test_the_risky_rule_is_off_unless_the_caller_asks(client, tmp_path):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    kept = clean(client, src).json()["rowsKept"]
    accepted = clean(client, src, accept_risk=True).json()["rowsKept"]

    assert F.M_KEY_REPEATS_SECOND in kept
    assert F.M_KEY_REPEATS_SECOND not in accepted


def test_clean_can_run_without_a_key_column(client, tmp_path):
    """用户还没选主键列时，「删空行 + 去首尾空白」这两件事照样能做。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))

    body = clean(client, src, key_col="").json()

    assert F.M_BLANK_ROW not in body["rowsKept"]
    assert F.M_NO_KEY in body["rowsKept"]  # 没有主键列，就没法判「主键为空」


def test_clean_a_missing_file_is_a_404(client, tmp_path):
    resp = clean(client, str(tmp_path / "没有这个文件.xlsx"))

    assert resp.status_code == 404


# ── 下载：只认自己产出的文件 ──────────────────────────────────────────


def test_download_serves_a_file_the_engine_produced(client, tmp_path):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    output = clean(client, src).json()["output"]

    resp = client.get("/api/excel/download", params={"path": output})

    assert resp.status_code == 200
    assert resp.content == pathlib.Path(output).read_bytes()
    assert "attachment" in resp.headers["content-disposition"]


def test_download_refuses_a_file_it_did_not_produce(client, tmp_path):
    """原表就在同一个文件夹里 —— 白名单不能按目录放行。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    clean(client, src)

    resp = client.get("/api/excel/download", params={"path": src})

    assert resp.status_code == 404


def test_download_refuses_a_path_that_never_existed(client, tmp_path):
    resp = client.get("/api/excel/download", params={"path": str(tmp_path / "随便.xlsx")})

    assert resp.status_code == 404


def test_download_forgets_files_from_a_previous_session(client, tmp_path):
    """白名单是「这次跑出来的」，不是「历史上出现过的所有路径」。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    output = clean(client, src).json()["output"]
    service.reset()

    resp = client.get("/api/excel/download", params={"path": output})

    assert resp.status_code == 404


# ── 打开：同一条白名单 ────────────────────────────────────────────────


def test_open_hands_the_file_to_the_system(client, tmp_path, monkeypatch):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    output = clean(client, src).json()["output"]
    opened: list[str] = []
    monkeypatch.setattr(service, "_open_with_system", opened.append)

    resp = client.post("/api/excel/open", json={"path": output})

    assert resp.status_code == 200
    assert opened == [output]


def test_open_refuses_a_file_it_did_not_produce(client, tmp_path, monkeypatch):
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    clean(client, src)
    opened: list[str] = []
    monkeypatch.setattr(service, "_open_with_system", opened.append)

    resp = client.post("/api/excel/open", json={"path": src})

    assert resp.status_code == 404
    assert opened == []


def test_open_reports_a_missing_file_instead_of_crashing(client, tmp_path, monkeypatch):
    """整理完用户把文件挪走了 —— 这时候要说人话，不是抛栈。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    output = clean(client, src).json()["output"]

    def boom(_: str) -> None:
        raise OSError("找不到文件")

    monkeypatch.setattr(service, "_open_with_system", boom)

    resp = client.post("/api/excel/open", json={"path": output})

    assert resp.status_code == 400


def test_a_file_removed_after_cleaning_is_reported_as_missing(client, tmp_path, monkeypatch):
    """白名单记的是路径，不是存在性 —— 文件被挪走之后要给出 404，不能当成「没产出过」。"""
    src = F.write_messy(str(tmp_path / "messy.xlsx"))
    output = clean(client, src).json()["output"]
    os.remove(output)

    resp = client.get("/api/excel/download", params={"path": output})

    assert resp.status_code == 404


def test_an_empty_path_is_rejected_with_a_readable_message(client):
    resp = client.post("/api/excel/clean", json={"path": "", "keyCol": ""})

    assert resp.status_code == 400
    assert resp.json()["detail"]
