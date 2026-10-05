# -*- coding: utf-8 -*-
"""物流查询的连通性自检。

用户说"一定要保证能查询到"。光有代码保证不了 —— 密钥没配、单号输错、官网改版、
验证码拦住，都会让查询失败。真正能提高确定性的是：**在跑大批量任务之前，
先花两秒告诉用户"这条路通不通、不通的话卡在哪一步"**。
"""
import json

import pytest


class FakeResp:
    def __init__(self, status=200, body=""):
        self.status = status
        self.text = body

    def read(self):
        return self.text.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def no_http(monkeypatch):
    """把所有出网请求打成假的：自检绝不能真的去请求快递100。"""
    def _boom(*a, **k):
        raise AssertionError("自检不应该真的发网络请求")
    monkeypatch.setattr("urllib.request.urlopen", _boom)


@pytest.fixture
def logi_instance(client):
    iid = client.post("/api/instances", json={"name": "物流查询", "tool": "logi"}).json()["id"]
    return iid


def _cfg(client, iid, **logi):
    base = {
        "file": "C:/tmp/a.xlsx",
        "colWaybill": "物流单号",
        "provider": "api",
        "apiKey": "K",
        "customer": "C",
    }
    base.update(logi)
    r = client.put(f"/api/instances/{iid}/config", json={"tool": "logi", "logi": base})
    assert r.status_code == 200, r.text


# ── 页面只读的配置态 ──────────────────────────────────────────

def test_自检端点存在(client, logi_instance, no_http):
    _cfg(client, logi_instance, apiKey="")
    r = client.post(f"/api/instances/{logi_instance}/logi-probe")
    assert r.status_code == 200
    body = r.json()
    # 没配密钥 → 不发请求，直接告诉用户缺什么
    assert body["ok"] is False
    assert body["stage"] == "config"
    assert "密钥" in body["message"]


def test_网页方式没配站点也报配置问题(client, logi_instance, no_http):
    _cfg(client, logi_instance, provider="web", site={})
    body = client.post(f"/api/instances/{logi_instance}/logi-probe").json()
    assert body["ok"] is False
    assert body["stage"] == "config"


def test_网页方式缺少关键选择器要逐项列出(client, logi_instance, no_http):
    """选择器不全就别去开浏览器 —— 跑一遍只会得到一句"无轨迹"，看不出是哪一步错了。"""
    _cfg(client, logi_instance, provider="web",
         site={"name": "顺丰", "url": "https://x", "input": "#a", "button": "#b",
               "result": "", "status": "", "trace": ""})
    body = client.post(f"/api/instances/{logi_instance}/logi-probe").json()
    assert body["ok"] is False
    assert body["stage"] == "config"
    # 缺哪几项要说出来
    assert set(body.get("missing", [])) == {"result", "status", "trace"}


def test_配置齐全且不联网时不该报配置错(client, logi_instance, monkeypatch):
    _cfg(client, logi_instance)
    captured = {}

    def _fake(req, timeout=None):
        captured["url"] = getattr(req, "full_url", "")
        body = getattr(req, "data", b"") or b""
        captured["body"] = body.decode("utf-8") if isinstance(body, bytes) else body
        return FakeResp(200, json.dumps({
            "status": "200",
            "data": [{"context": "已到网点", "status": "派送中", "ftime": "2026-10-04 12:00:00"}],
        }))

    monkeypatch.setattr("urllib.request.urlopen", _fake)
    body = client.post(f"/api/instances/{logi_instance}/logi-probe").json()
    # 测试单号本该查不到；返回"派送中"说明返回与常规不一致 → 如实报出来
    assert body["ok"] is False
    assert body["stage"] == "query"
    assert "派送中" in body["message"]
    # 但它确实证明密钥有效、网络可达
    assert "密钥有效" in body["message"]
    assert "tempVal=0000000000000000000000" in captured["body"]


def test_密钥被拒时明确说密钥问题(client, logi_instance, monkeypatch):
    _cfg(client, logi_instance)

    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResp(
        200, json.dumps({"status": "401", "message": "签名验证失败"})))
    body = client.post(f"/api/instances/{logi_instance}/logi-probe").json()
    assert body["ok"] is False
    assert body["stage"] == "query"
    assert "密钥" in body["message"]


def test_限流要提示限流(client, logi_instance, monkeypatch):
    _cfg(client, logi_instance)
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResp(
        200, json.dumps({"status": "500", "message": "接口调用超出频率限制"})))
    body = client.post(f"/api/instances/{logi_instance}/logi-probe").json()
    assert body["ok"] is False
    assert "频率" in body["message"]


def test_自检本身不写缓存_否则会把试跑结果当成真实结果复用(client, logi_instance, monkeypatch):
    from engine import db

    _cfg(client, logi_instance)
    monkeypatch.setattr("urllib.request.urlopen", lambda *a, **k: FakeResp(
        200, json.dumps({"status": "200", "data": [{"context": "在途", "status": "在途"}]})))
    with db.write() as c:
        c.execute("DELETE FROM waybill_cache")
    client.post(f"/api/instances/{logi_instance}/logi-probe")
    rows = db.query("SELECT * FROM waybill_cache")
    assert not rows, "自检只是探路，不该占用正式查询的缓存"


# ── Excel / 网页方式也必须能自检 ────────────────────────────────
# logi_probe 曾无条件 `p.query(no, no_cache=True)`，但 Excel / 网页 provider 的
# query 只收一个单号 —— 于是这两种方式（Excel 还是默认推荐）自检必然抛 TypeError，
# 被兜底吞成「自检时发生未预期的错误」，最该用的方式反而自检不了。

def test_excel方式自检不该报未预期错误(client, logi_instance, no_http, tmp_path):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["物流单号", "物流状态"])
    ws.append(["SF0001", "已签收"])
    ref = tmp_path / "ref.xlsx"
    wb.save(ref)

    _cfg(client, logi_instance, provider="excel", refFile=str(ref))
    body = client.post(f"/api/instances/{logi_instance}/logi-probe").json()

    assert "未预期" not in body["message"], body["message"]
    assert body["stage"] == "query"
