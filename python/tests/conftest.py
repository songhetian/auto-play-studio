"""测试公共夹具。

- 每个测试会话使用独立 SQLite 文件，避免污染开发库
- 通过 engine 包的公共模块构造真实 Excel 文件作为接口输入
"""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import time
import uuid

import pytest
from openpyxl import Workbook

PY_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

_DB = PY_ROOT / "test_autoplay.db"
os.environ["AUTOPLAY_DB"] = str(_DB)
# 图像素材写进临时目录，别往仓库里丢文件
_ASSETS = tempfile.mkdtemp(prefix="autoplay_assets_")
os.environ["AUTOPLAY_ASSETS_DIR"] = _ASSETS

from engine import db  # noqa: E402  （必须在设置 AUTOPLAY_DB 之后导入）


@pytest.fixture(scope="session", autouse=True)
def _fresh_db():
    """固定一个测试库，每会话开始时清空表（不删文件，避免每次运行都多出一个 db）。"""
    with db.write() as c:
        # settings 是全局一行（通知配置），漏了它上一个文件留下的值会污染后面所有文件
        for t in ("instances", "runs", "rows", "logs", "waybill_cache", "image_assets", "hit_events", "settings", "plans"):
            c.execute(f"DELETE FROM {t}")
    yield


@pytest.fixture
def xlsx_factory(tmp_path):
    """构造真实 xlsx：headers + rows（第一行之后为数据，Excel 行号从 2 开始）。"""

    def _make(headers: list[str], rows: list[list], name: str = "data.xlsx") -> str:
        wb = Workbook()
        ws = wb.active
        ws.append(headers)
        for r in rows:
            ws.append(r)
        p = tmp_path / name
        wb.save(p)
        return str(p)

    return _make


@pytest.fixture
def order_xlsx(xlsx_factory):
    """订单表：订单编号 / 客户名称 / 话术模板"""
    return xlsx_factory(
        ["订单编号", "客户名称", "话术模板"],
        [
            ["A001", "张三", "您好，新品上架"],
            ["A002", "李四", "您好，老客回访"],
        ],
    )


@pytest.fixture
def ref_xlsx(xlsx_factory):
    """物流对照表（平台导出的那种）"""
    return xlsx_factory(
        ["物流单号", "快递公司", "物流状态", "签收时间", "最新轨迹"],
        [
            ["SF1234567890", "顺丰速运", "已签收", "10-01 15:22", "【深圳市】快件已签收"],
            ["YT9876543210", "圆通速递", "运输中", "", "【杭州市】快件已发出"],
        ],
        name="ref.xlsx",
    )


@pytest.fixture
def rpa_row():
    """传给指令解释器的一行数据（read_rows 的产物）。"""
    return {
        "row_no": 2,
        "key": "张三",
        "existing_status": "",
        "values": {"订单编号": "A001", "客户名称": "张三", "话术模板": "您好，新品上架"},
    }


@pytest.fixture
def add_asset():
    """往图像库塞一张真实 PNG，返回素材记录。"""
    from engine import image_library
    from tests.helpers import png_bytes

    def _add(name: str = "素材", width: int = 4, height: int = 4, **kw):
        return image_library.import_image(name, png_bytes(width, height), **kw)

    return _add


@pytest.fixture
def client():
    """FastAPI TestClient：接口层测试共用。"""
    from fastapi.testclient import TestClient

    from engine.main import app

    with TestClient(app) as c:
        yield c


# ── Excel 对比（compare）用的夹具 ──────────────────────────────
# 数据结构与 compare-excel 一致：
#   table = {id, name, path, sheet, columns, data:[{列名: 值}]}
#   primary_fields = [{name, role:'key'|'compare', type:'text'|'number'}]


@pytest.fixture
def table_factory():
    def _make(name: str, columns: list[str], rows: list[list]) -> dict:
        return {
            "id": name,
            "name": name,
            "path": "",
            "sheet": "Sheet1",
            "columns": list(columns),
            "data": [dict(zip(columns, r)) for r in rows],
        }

    return _make


@pytest.fixture
def front_backend(table_factory):
    """前台(A 基准) / 后台(B) 退差样例 —— 覆盖 一致/不一致/缺失/多余/数据错误 五种结论。

    A001 一致 | A002 退差金额 200.5 vs 250.5 不一致 | A003 一致
    A004 后台没有 → 缺失 | A006 后台写成“文本” → 数据错误 | A005 只有后台有 → 多余
    """
    a = table_factory(
        "前台.xlsx",
        ["订单号", "退差金额", "客户"],
        [
            ["A001", 100.00, "张三"],
            ["A002", 200.50, "李四"],
            ["A003", 300.00, "王五"],
            ["A004", 50.00, "赵六"],
            ["A006", 80.00, "孙八"],
        ],
    )
    b = table_factory(
        "后台.xlsx",
        ["订单号", "退差金额", "客户"],
        [
            ["A001", 100.00, "张三"],
            ["A002", 250.50, "李四"],
            ["A003", 300.00, "王五"],
            ["A005", 999.00, "钱七"],
            ["A006", "文本", "孙八"],
        ],
    )
    return a, b


@pytest.fixture
def primary_fields():
    return [
        {"name": "订单号", "role": "key", "type": "text"},
        {"name": "退差金额", "role": "compare", "type": "number"},
    ]


@pytest.fixture
def make_instance():
    """创建实例记录，返回 id。"""

    def _make(tool: str, config: dict, name: str = "测试实例") -> str:
        iid = f"{tool[:1].upper()}{uuid.uuid4().hex[:6]}"
        import json

        with db.write() as c:
            c.execute(
                "INSERT INTO instances(id, tool, name, config_json) VALUES (?,?,?,?)",
                (iid, tool, name, json.dumps(config, ensure_ascii=False)),
            )
        return iid

    return _make


def _wait_status(instance_id: str, targets: set[str], timeout: float = 10.0) -> str:
    """轮询等待实例进入目标状态（runner 在独立线程执行）。"""
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        r = db.query("SELECT status FROM instances WHERE id=?", (instance_id,))
        last = r[0]["status"] if r else ""
        if last in targets:
            return last
        time.sleep(0.05)
    return last


@pytest.fixture
def wait_status():
    return _wait_status
