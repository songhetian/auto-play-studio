# -*- coding: utf-8 -*-
"""快递100 接口查询的行为规格。

为什么先写这个：③ 接口方式是**唯一不依赖网页 DOM** 的路 —— 官网页面改版、
加验证码，它都不受影响。用户说"一定要保证能查询到"，能真正提高确定性的
就是这一条（前提是配了密钥）。

同时要保证「不配置密钥时**说人话**」，而不是抛一个 500 或一句 stacktrace。
"""
import json

import pytest

from engine.providers import ApiProvider, build_provider


class FakeResponse:
    """最小 HTTP 响应替身：只给 ApiProvider 用到的那几个属性。

    实现 `__enter__/__exit__` 是因为真实代码用 `with urlopen(...) as resp`。
    """

    def __init__(self, status=200, body=""):
        self.status = status
        self.text = body

    def read(self):
        return self.text.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def _clean_waybill_cache():
    """每个用例前清空单号缓存。

    waybill_cache 是**用户数据**（跨用例累积），而查询会先读它 ——
    不清的话第二个用例直接命中上一个用例的缓存，请求根本没发出去。
    """
    from engine import db

    with db.write() as c:
        c.execute("DELETE FROM waybill_cache")
    yield
    with db.write() as c:
        c.execute("DELETE FROM waybill_cache")


@pytest.fixture
def fake_http(monkeypatch):
    """把 urlopen 换成可断言的假实现。"""
    calls = []

    def _install(handler):
        def _fake(req, timeout=None):
            # 真实调用传的是 Request 对象：URL 在 .full_url，表单体在 .data
            url = getattr(req, "full_url", str(req))
            data = getattr(req, "data", None)
            body = data.decode("utf-8") if isinstance(data, bytes) else data
            calls.append({"url": url, "data": body})
            return handler(url, body)

        monkeypatch.setattr("urllib.request.urlopen", _fake)
        return calls

    return _install


# ── 配置校验：没配密钥必须立刻说清，而不是等到发请求 ──────────────

def test_没配密钥直接报错_说清要去哪拿():
    with pytest.raises(ValueError) as e:
        ApiProvider(api_key="")
    assert "密钥" in str(e.value) or "key" in str(e.value).lower()


def test_密钥去空白后为空也算没配():
    with pytest.raises(ValueError):
        ApiProvider(api_key="   ")


# ── 正常查询 ──────────────────────────────────────────────────

def test_查询成功_返回状态与轨迹(fake_http):
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200",
        "message": "ok",
        "data": [{
            "time": "2026-10-04 10:20:31",
            "context": "【浙江省杭州市】快件已发出，下一站【杭州转运中心】",
            "ftime": "2026-10-04 10:20:31",
            "status": "在途",
        }],
    })))

    r = ApiProvider(api_key="K").query("771234567890")

    assert r.status == "在途"
    assert "快件已发出" in r.trace
    # 最后一条轨迹就是最新的，时间要带出来
    assert "2026-10-04 10:20" in r.trace


def test_查询请求带上了单号和密钥(fake_http):
    calls = fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200", "data": [{"context": "x", "status": "在途"}],
    })))

    ApiProvider(api_key="SECRET", customer="CUST1").query("771234567890")

    assert len(calls) == 1
    # 客户号与单号在请求体里
    assert "771234567890" in calls[0]["data"]
    assert "CUST1" in calls[0]["data"]
    # 密钥**不能**出现在 URL（会进网关/代理日志）；它只参与 md5 签名，明文不外传
    assert "SECRET" not in calls[0]["url"]
    assert "SECRET" not in calls[0]["data"]
    assert "sign=" in calls[0]["data"]


def test_签收状态要能识别出签收时间(fake_http):
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200",
        "data": [{
            "context": "您的快件已签收，签收人：本人",
            "status": "已签收",
            "ftime": "2026-10-04 09:00:00",
        }],
    })))

    r = ApiProvider(api_key="K").query("771234567890")

    assert r.status == "已签收"
    # 签收时间是这类查询最值钱的字段之一，不能丢
    assert r.signed_at


def test_多条轨迹时第一条是最新的一条(fake_http):
    """快递100 的 data 是**倒序**的（最新在前）。顺序搞反就会把三天前的状态当现状。"""
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200",
        "data": [
            {"context": "最新：已到网点", "status": "派送中", "ftime": "2026-10-04 12:00:00"},
            {"context": "较早：运输中", "status": "运输中", "ftime": "2026-10-03 08:00:00"},
        ],
    })))

    r = ApiProvider(api_key="K").query("771234567890")

    assert "最新" in r.trace
    assert r.status == "派送中"


# ── 各种失败都要说人话 ────────────────────────────────────────

def test_单号查不到要明确说没查到_不能当成无轨迹糊弄过去(fake_http):
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "201", "message": "查询无结果",
    })))

    r = ApiProvider(api_key="K").query("771234567890")

    assert r.status == "查无结果"


def test_密钥无效要报错_不能返回空数据让用户以为没物流(fake_http):
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "401", "message": "签名验证失败",
    })))

    with pytest.raises(ValueError) as e:
        ApiProvider(api_key="BAD").query("771234567890")
    assert "密钥" in str(e.value)


def test_频率超限要提示限流_而不是让用户干等(fake_http):
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "500", "message": "接口调用超出频率限制",
    })))

    with pytest.raises(ValueError) as e:
        ApiProvider(api_key="K").query("771234567890")
    assert "频率" in str(e.value) or "限" in str(e.value)


def test_网络不通要说网络问题_不能暴露原始异常(fake_http):
    def _boom(url, data):
        raise OSError("connection refused")

    fake_http(_boom)

    with pytest.raises(ValueError) as e:
        ApiProvider(api_key="K").query("771234567890")
    assert "网络" in str(e.value)


def test_返回格式不对要报格式问题(fake_http):
    fake_http(lambda url, data: FakeResponse(200, "{ 不是 json"))

    with pytest.raises(ValueError) as e:
        ApiProvider(api_key="K").query("771234567890")
    assert "返回" in str(e.value) or "格式" in str(e.value)


# ── 缓存：接口按次数计费，同一个单号不该反复花钱 ────────────────

def test_查过的单号走缓存_不再发第二次请求(fake_http):
    calls = fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200",
        "data": [{"context": "在途", "status": "在途", "ftime": "2026-10-04 10:00:00"}],
    })))

    p = ApiProvider(api_key="K")
    p.query("771234567890")
    p.query("771234567890")

    assert len(calls) == 1, "接口按次计费，重复查同一单号等于白花钱"


def test_缓存要归一化单号_带不带空格算同一个(fake_http):
    calls = fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200", "data": [{"context": "在途", "status": "在途"}],
    })))

    p = ApiProvider(api_key="K")
    p.query("771234567890")
    p.query("  771234567890  ")

    assert len(calls) == 1


# ── 接入 build_provider ───────────────────────────────────────

def test_build_provider_能构建接口方式_并带上密钥():
    p = build_provider({"provider": "api", "apiKey": "K", "customer": "C"})
    assert isinstance(p, ApiProvider)
    assert p.customer == "C"


def test_错误签名返回的参数错误必须报密钥问题_不能当成查无结果(fake_http):
    """实测快递100 对错误签名的真实响应。

    早先没处理这个形状：拿假密钥去请求，它回 `status=400 + message="参数错误"`，
    既不含"密钥"也不含"签名"，于是被一律当成"查无结果"——
    **自检会报"接口通了"，用户以为配好了，跑整批却全查不到。**
    """
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "message": "参数错误", "nu": "", "ischeck": "0",
        "condition": "", "com": "", "status": "400", "state": "0", "data": [],
    })))

    with pytest.raises(ValueError) as e:
        ApiProvider(api_key="FAKEKEY", customer="FAKECUST").query("771234567890")
    msg = str(e.value)
    assert "参数错误" in msg
    assert "密钥" in msg, "必须把形状翻译成用户能懂的话"


def test_未知的非200状态不能被当成查无结果(fake_http):
    """只有 201（查无结果）是正常业务结果，其他非 200 都要报错。"""
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "500", "message": "服务器繁忙", "data": [],
    })))

    with pytest.raises(ValueError):
        ApiProvider(api_key="K").query("771234567890")


def test_查询成功要带回快递公司(fake_http):
    """「物流公司」列不能永远是空的。

    快递100 顶层响应里的 `com` 就是（自动识别出的）公司代码；
    曾经这里写成 `(latest.get("ischeck") and "") or ""` —— 无论怎样都是空串。
    """
    fake_http(lambda url, data: FakeResponse(200, json.dumps({
        "status": "200", "com": "yuantong", "nu": "771234567890",
        "data": [{"context": "快件在途", "status": "在途"}],
    })))

    r = ApiProvider(api_key="K").query("771234567890")

    assert r.company == "yuantong"
