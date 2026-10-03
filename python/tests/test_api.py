"""上传 Excel 后必须得到一个「点开始就能跑」的默认配置。"""
from __future__ import annotations

import threading

from engine import db
from engine.runner import InstanceRunner
from tests.helpers import FakeDriver, FakeExecutor, rpa_cfg, run_to_completion


def test_upload_sets_a_usable_row_range(client, make_instance, xlsx_factory):
    path = xlsx_factory(["客户名称", "话术模板"], [["张三", "你好"], ["李四", "在吗"], ["王五", "hi"]])
    iid = make_instance("rpa", rpa_cfg(path, **{"from": 2, "to": 2}))

    with open(path, "rb") as f:
        r = client.post(f"/api/instances/{iid}/excel", files={"file": ("客户.xlsx", f, "application/vnd.ms-excel")})

    assert r.status_code == 200
    assert r.json()["rows"] == 3, "上传后应返回真实行数，而不是 0"

    cfg = db.get_config(iid)
    assert cfg["rpa"]["excelPath"].endswith(".xlsx")
    assert (cfg["rpa"]["from"], cfg["rpa"]["to"]) == (2, 4), "默认区间要正好覆盖全部数据行"


def test_upload_rejects_non_excel(client, make_instance, tmp_path):
    iid = make_instance("rpa", rpa_cfg(""))
    bad = tmp_path / "a.txt"
    bad.write_text("x")

    with open(bad, "rb") as f:
        r = client.post(f"/api/instances/{iid}/excel", files={"file": ("a.txt", f, "text/plain")})

    assert r.status_code == 400


def test_control_endpoint_rejects_illegal_action(client, make_instance, order_xlsx):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    assert client.post(f"/api/instances/{iid}/control/pause").status_code == 409, "空闲实例不能暂停"


def test_start_endpoint_says_who_holds_the_screen(client, make_instance, order_xlsx, xlsx_factory, wait_status):
    """接口层要给「为什么不行」一个能读的答案：报出占着屏幕的那个实例的名字。"""
    i1 = make_instance("rpa", rpa_cfg(order_xlsx), name="先行")
    i2 = make_instance(
        "rpa", rpa_cfg(xlsx_factory(["客户名称"], [["王五"]], name="b.xlsx")), name="后到"
    )

    class Blocking:
        started = threading.Event()
        gate = threading.Event()

        def __call__(self, cfg, row):
            self.started.set()
            self.gate.wait(5)
            return (True, "")

    blocker = Blocking()
    assert InstanceRunner(i1, executor=blocker, driver=FakeDriver()).start()
    assert blocker.started.wait(5)

    r = client.post(f"/api/instances/{i2}/control/start")
    assert r.status_code == 409
    assert "先行" in r.json()["detail"], "报错要说出是谁占着屏幕，而不是一句状态码"
    assert "后到" not in r.json()["detail"]

    blocker.gate.set()
    assert wait_status(i1, {"completed"}, 10) == "completed"


def test_created_instance_appears_in_list(client):
    r = client.post("/api/instances", json={"name": "新建实例", "tool": "logi"})
    assert r.status_code == 200
    iid = r.json()["id"]

    ids = [i["id"] for i in client.get("/api/instances").json()]
    assert iid in ids


def test_rows_endpoint_uses_the_frontend_field_names(client, make_instance, order_xlsx, wait_status):
    """运行明细接口的字段名必须与前端 `Row`（src/schemas/instance.ts）完全一致。

    这一处曾经两边各写各的：引擎回 `row_no / key_value / duration_ms`，
    前端读 `rowNo / keyValue / durationMs`。页面**不会报错**，只是整张
    「执行明细」的步数、关键字、耗时悄悄变成空白和 NaN —— 静默失配里最难查的那种。
    """
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    executor = FakeExecutor()
    run_to_completion(iid, executor, wait_status)

    r = client.get(f"/api/instances/{iid}/rows")
    assert r.status_code == 200
    body = r.json()
    assert body, "跑完一轮之后明细不该是空的"
    for row in body:
        assert set(row) == {"rowNo", "keyValue", "status", "message", "durationMs"}
        assert isinstance(row["rowNo"], int) and row["rowNo"] >= 2
        assert row["status"] in {"ok", "err", "skip", "wait"}


# ── 跑后汇总 ──────────────────────────────────────────────────────────
# 与「执行明细」看的是**同一轮**：两处各挑一轮的话，页面上半部分说跑了 4 行、
# 下半部分列着 6 行明细。


def test_the_summary_of_an_instance_that_never_ran_says_so(client, make_instance):
    iid = make_instance("rpa", rpa_cfg(""))

    body = client.get(f"/api/instances/{iid}/summary").json()

    assert body["headline"] == "本次没有执行任何行"
    assert (body["total"], body["ok"], body["failed"], body["skipped"]) == (0, 0, 0, 0)
    assert body["pending"] == []


def test_the_summary_uses_the_frontend_field_names(client, make_instance, xlsx_factory, wait_status):
    """字段名一次性钉死 —— 少一个字母，运行页的汇总块就是一片空白，且不报错。"""
    path = xlsx_factory(["客户名称", "话术模板"], [["张三", "你好"], ["李四", "在吗"], ["王五", "hi"], ["赵六", "在"]])
    iid = make_instance("rpa", rpa_cfg(path, **{"from": 2, "to": 5}))
    run_to_completion(
        iid,
        FakeExecutor(
            {
                "李四": (False, "等待超时，屏幕上没有找到图片「提交」"),
                "王五": (False, "等待超时，屏幕上没有找到图片「返回」"),
            }
        ),
        wait_status,
    )

    body = client.get(f"/api/instances/{iid}/summary").json()

    assert set(body) == {"total", "ok", "failed", "skipped", "headline", "reasons", "otherReasons", "pending"}
    assert (body["total"], body["ok"], body["failed"], body["skipped"]) == (4, 2, 2, 0)
    assert body["headline"] == "本次共 4 行，成功 2、失败 2"
    assert body["reasons"] == [{"label": "等待超时，屏幕上没有找到图片「…」", "count": 2, "rows": [3, 4]}]
    assert body["otherReasons"] == 0
    assert body["pending"] == [
        {"row": 3, "key": "李四", "reason": "等待超时，屏幕上没有找到图片「提交」"},
        {"row": 4, "key": "王五", "reason": "等待超时，屏幕上没有找到图片「返回」"},
    ]


def test_the_summary_reads_only_the_latest_run(client, make_instance, order_xlsx, wait_status):
    """第二轮才是用户当下要看的那一轮。"""
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    run_to_completion(iid, FakeExecutor(), wait_status)  # 第一轮：两行都成功

    with db.write() as c:
        c.execute("INSERT INTO runs(instance_id, status) VALUES (?, 'completed')", (iid,))
        rid = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        for row_no, key, status, message in [(2, "张三", "err", "第二次跑坏了"), (3, "李四", "ok", "")]:
            c.execute(
                "INSERT INTO rows(run_id, row_no, key_value, status, message, duration_ms) VALUES (?,?,?,?,?,0)",
                (rid, row_no, key, status, message),
            )

    body = client.get(f"/api/instances/{iid}/summary").json()

    assert (body["total"], body["ok"], body["failed"]) == (2, 1, 1)
    assert [p["key"] for p in body["pending"]] == ["张三"]


# ── 跑后汇总 ──────────────────────────────────────────────────────────
# 与「执行明细」看的是**同一轮**：两处各挑一轮的话，页面上半部分说跑了 4 行、
# 下半部分列着 6 行明细。


def test_the_summary_of_an_instance_that_never_ran_says_so(client, make_instance):
    iid = make_instance("rpa", rpa_cfg(""))

    body = client.get(f"/api/instances/{iid}/summary").json()

    assert body["headline"] == "本次没有执行任何行"
    assert (body["total"], body["ok"], body["failed"], body["skipped"]) == (0, 0, 0, 0)
    assert body["pending"] == []


def test_the_summary_uses_the_frontend_field_names(client, make_instance, xlsx_factory, wait_status):
    """字段名一次性钉死 —— 少一个字母，运行页的汇总块就是一片空白，且不报错。"""
    path = xlsx_factory(["客户名称", "话术模板"], [["张三", "你好"], ["李四", "在吗"], ["王五", "hi"], ["赵六", "在"]])
    iid = make_instance("rpa", rpa_cfg(path, **{"from": 2, "to": 5}))
    run_to_completion(
        iid,
        FakeExecutor(
            {
                "李四": (False, "等待超时，屏幕上没有找到图片「提交」"),
                "王五": (False, "等待超时，屏幕上没有找到图片「返回」"),
            }
        ),
        wait_status,
    )

    body = client.get(f"/api/instances/{iid}/summary").json()

    assert set(body) == {"total", "ok", "failed", "skipped", "headline", "reasons", "otherReasons", "pending"}
    assert (body["total"], body["ok"], body["failed"], body["skipped"]) == (4, 2, 2, 0)
    assert body["headline"] == "本次共 4 行，成功 2、失败 2"
    assert body["reasons"] == [{"label": "等待超时，屏幕上没有找到图片「…」", "count": 2, "rows": [3, 4]}]
    assert body["otherReasons"] == 0
    assert body["pending"] == [
        {"row": 3, "key": "李四", "reason": "等待超时，屏幕上没有找到图片「提交」"},
        {"row": 4, "key": "王五", "reason": "等待超时，屏幕上没有找到图片「返回」"},
    ]


def test_the_summary_reads_only_the_latest_run(client, make_instance, order_xlsx, wait_status):
    """第二轮才是用户当下要看的那一轮。"""
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    run_to_completion(iid, FakeExecutor(), wait_status)  # 第一轮：两行都成功

    with db.write() as c:
        c.execute("INSERT INTO runs(instance_id, status) VALUES (?, 'completed')", (iid,))
        rid = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        for row_no, key, status, message in [(2, "张三", "err", "第二次跑坏了"), (3, "李四", "ok", "")]:
            c.execute(
                "INSERT INTO rows(run_id, row_no, key_value, status, message, duration_ms) VALUES (?,?,?,?,?,0)",
                (rid, row_no, key, status, message),
            )

    body = client.get(f"/api/instances/{iid}/summary").json()

    assert (body["total"], body["ok"], body["failed"]) == (2, 1, 1)
    assert [p["key"] for p in body["pending"]] == ["张三"]
