# -*- coding: utf-8 -*-
"""物流「快速查单」：给一个或几个单号，立刻返回各自状态。

与整批跑 Excel 的区别：这是**单号驱动**的即时查询，不依赖上传文件，
入口在手边、结果可复制。复用同一套 Provider —— 查什么方式取决于实例已配置的查询方式。
"""
from __future__ import annotations

from engine.providers import CaptchaEncountered, WaybillResult


def _logi_instance(client, **logi) -> str:
    iid = client.post("/api/instances", json={"name": "物流查询", "tool": "logi"}).json()["id"]
    base = {
        "file": "C:/tmp/a.xlsx",
        "colWaybill": "物流单号",
        "provider": "excel",
        "refFile": "",
        "refNo": "物流单号",
        "refStatus": "物流状态",
    }
    base.update(logi)
    r = client.put(f"/api/instances/{iid}/config", json={"tool": "logi", "logi": base})
    assert r.status_code == 200, r.text
    return iid


def test_按单号即时查逐条返回且保持输入顺序(client, ref_xlsx):
    iid = _logi_instance(client, refFile=ref_xlsx)

    r = client.post(f"/api/instances/{iid}/logi-query",
                    json={"numbers": "SF1234567890\nYT9876543210"})

    assert r.status_code == 200, r.text
    body = r.json()
    assert [it["no"] for it in body["items"]] == ["SF1234567890", "YT9876543210"]
    assert body["items"][0]["company"] == "顺丰速运"
    assert body["items"][0]["status"] == "已签收"
    assert body["count"] == 2


def test_单条失败不拖垮整批且给人话(client, monkeypatch):
    """即时查是「人等着看结果」：一条撞验证码/出错，不能把整批都return掉。"""
    iid = _logi_instance(client, refFile="C:/tmp/ref.xlsx")

    class FakeProvider:
        def query(self, no: str) -> WaybillResult:
            if no == "NEEDS-HUMAN":
                raise CaptchaEncountered(no)
            return WaybillResult(no, company="顺丰速运", status="已签收")

    monkeypatch.setattr("engine.main.build_provider", lambda cfg: FakeProvider())

    r = client.post(f"/api/instances/{iid}/logi-query",
                    json={"numbers": "SF0001\nNEEDS-HUMAN\nSF0002"})

    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert [it["no"] for it in items] == ["SF0001", "NEEDS-HUMAN", "SF0002"]
    assert items[0]["ok"] is True
    assert items[1]["ok"] is False
    assert "人工验证" in items[1]["message"]
    assert items[2]["ok"] is True


def test_空输入给人话提示(client):
    iid = _logi_instance(client)

    r = client.post(f"/api/instances/{iid}/logi-query", json={"numbers": "  \n \n"})

    assert r.status_code == 400
    assert "单号" in r.json()["detail"]


def test_超过单次上限要拦下来并说清楚(client):
    iid = _logi_instance(client)
    too_many = "\n".join(f"SF{i:04d}" for i in range(21))

    r = client.post(f"/api/instances/{iid}/logi-query", json={"numbers": too_many})

    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "20" in detail and "21" in detail


def test_查过的单号进本地缓存(client, ref_xlsx):
    """即时查也要落缓存：下次再查同一单号不再重复请求（接口按次计费）。"""
    from engine import db

    with db.write() as c:
        c.execute("DELETE FROM waybill_cache WHERE no=?", ("SF1234567890",))
    iid = _logi_instance(client, refFile=ref_xlsx)

    client.post(f"/api/instances/{iid}/logi-query", json={"numbers": "SF1234567890"})

    rows = db.query("SELECT * FROM waybill_cache WHERE no=?", ("SF1234567890",))
    assert rows and rows[0]["status"] == "已签收"


def test_最近几条按更新时间倒序(client):
    """刷新页面后还能看到刚查过的单号 —— 从本地缓存按最后更新倒序取。"""
    from engine import db

    with db.write() as c:
        c.execute("DELETE FROM waybill_cache")
        for no, ts in [("A1", "2026-10-01 10:00:00"),
                       ("A2", "2026-10-02 10:00:00"),
                       ("A3", "2026-10-03 10:00:00")]:
            c.execute("INSERT INTO waybill_cache(no, status, updated_at) VALUES (?,?,?)", (no, "在途", ts))
    iid = _logi_instance(client)

    r = client.get(f"/api/instances/{iid}/logi-recent", params={"limit": 2})

    assert r.status_code == 200, r.text
    assert [it["no"] for it in r.json()["items"]] == ["A3", "A2"]
