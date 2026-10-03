"""接口层：模板校验与预览样例。

业务逻辑在 `engine.template` 里测过了，而且还和前端共用同一组黄金用例。
这一层要证明的只有两件事：

1. 校验走的是**真实表头**而不是前端缓存 —— 用户换过 Excel 之后缓存就不作数了；
2. 上传时回传的样例行，恰好就是配置页实时预览要用的那一行。
"""
from __future__ import annotations

from tests.helpers import rpa_cfg


def check(client, path: str, templates: list[str]):
    return client.post("/api/template/check", json={"excelPath": path, "templates": templates})


def test_check_passes_when_every_column_exists(client, xlsx_factory):
    path = xlsx_factory(["订单编号", "金额"], [["A001", 100]])

    r = check(client, path, ["单号 {订单编号}", "金额 {金额|money}"])

    assert r.status_code == 200
    assert r.json() == {"columns": ["订单编号", "金额"], "issues": []}


def test_check_points_at_the_offending_template(client, xlsx_factory):
    """前端要能定位到是哪一条指令坏了，所以 issues 里带下标。"""
    path = xlsx_factory(["订单编号"], [["A001"]])

    r = check(client, path, ["单号 {订单编号}", "客户 {客户名}"])

    assert r.status_code == 200
    assert r.json()["issues"] == [
        {
            "index": 1,
            "template": "客户 {客户名}",
            "message": "当前行没有「客户名」这一列，占位符 {客户名} 无法替换",
        }
    ]


def test_check_reports_every_broken_template_at_once(client, xlsx_factory):
    """一次把话说完 —— 不要用户改一条、跑一次、再发现下一条。"""
    path = xlsx_factory(["订单编号"], [["A001"]])

    r = check(client, path, ["{客户名}", "{金额|meney}", "单号 {订单编号}"])

    assert [i["index"] for i in r.json()["issues"]] == [0, 1]


def test_check_reads_the_file_not_a_cached_header_list(client, xlsx_factory):
    path = xlsx_factory(["旧列"], [["x"]])

    r = check(client, path, ["{新列}"])

    assert r.json()["columns"] == ["旧列"], "必须现读文件，探测缓存里的列形同虚设"
    assert r.json()["issues"], "按旧表头看，{新列} 就是缺列"


def test_check_on_an_unreadable_file_is_a_400(client, tmp_path):
    r = check(client, str(tmp_path / "根本没有.xlsx"), [])

    assert r.status_code == 400


def test_upload_returns_the_sample_row_the_preview_needs(client, make_instance, xlsx_factory):
    path = xlsx_factory(
        ["客户名称", "订单编号", "金额"],
        [["张三", "A001", 1234.5], ["李四", "A002", 8]],
    )
    iid = make_instance("rpa", rpa_cfg(path))

    with open(path, "rb") as f:
        r = client.post(f"/api/instances/{iid}/excel", files={"file": ("订单.xlsx", f, "application/vnd.ms-excel")})

    assert r.status_code == 200
    sample = r.json()["sample"]
    assert sample["row_no"] == 2
    assert sample["values"]["订单编号"] == "A001"
    assert sample["values"]["金额"] == 1234.5, "样例行要给真值，配置页才看得到 money 的真实效果"


def test_upload_sample_skips_leading_blank_rows(client, make_instance, xlsx_factory):
    """第一行数据是空的就往下找 —— 否则预览是空的，等于没预览。"""
    path = xlsx_factory(["客户名称", "订单编号"], [[None, None], ["李四", "A002"]])
    iid = make_instance("rpa", rpa_cfg(path))

    with open(path, "rb") as f:
        r = client.post(f"/api/instances/{iid}/excel", files={"file": ("订单.xlsx", f, "application/vnd.ms-excel")})

    sample = r.json()["sample"]
    assert sample["row_no"] == 3
    assert sample["values"]["订单编号"] == "A002"
