# -*- coding: utf-8 -*-
"""敏感词库的行为测试（对外接口：HTTP）。

从最小的一个行为开始：新建一个违禁词 → 能列出来。
后续切片逐条加：查重、编辑、停用、危级筛选、批量导入。
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def clean_words():
    """每个用例前清空词库。

    sensitive_word 是**用户数据**（跨用例累积），不隔离的话
    第二个用例会读到上一个用例留下的词，断言互相污染。
    """
    from engine import db

    with db.write() as c:
        c.execute("DELETE FROM sensitive_word")
    yield
    with db.write() as c:
        c.execute("DELETE FROM sensitive_word")


@pytest.fixture
def word_client(clean_words):
    from fastapi.testclient import TestClient
    from engine.main import app

    with TestClient(app) as c:
        yield c


def test_新建违禁词能列出来(word_client):
    r = word_client.post("/api/sensitive/words", json={"word": "退款政策", "level": "high"})
    assert r.status_code == 200

    items = word_client.get("/api/sensitive/words").json()
    assert len(items) == 1
    assert items[0]["word"] == "退款政策"
    assert items[0]["level"] == "high"


def test_拼音键自动算出来_用户不必手填(word_client):
    """客服只记得「tkzc」也要能命中「退款政策」。

    手填拼音既麻烦又会填错（t/tk/退 各种写法），所以按词自动算。
    """
    item = word_client.post("/api/sensitive/words", json={"word": "退款政策"}).json()
    assert item["matchKey"] == "tkzc"


def test_英文词保留原样做拼音键(word_client):
    item = word_client.post("/api/sensitive/words", json={"word": "加微信"}).json()
    # 中文取首字母，英文原样 —— "加微信" → jwx，"vip" → vip
    assert item["matchKey"] == "jwx"


def test_同一个词不重复入库(word_client):
    """两条同名规则会让一次问题报两次命中，客服会以为是两次事件。"""
    word_client.post("/api/sensitive/words", json={"word": "退款政策", "level": "high"})
    r = word_client.post("/api/sensitive/words", json={"word": "退款政策", "level": "low"})
    # 重复即视为更新（保住已有的危级设置），而不是报错或再加一条
    assert r.status_code == 200
    items = word_client.get("/api/sensitive/words").json()
    assert len(items) == 1


def test_批量导入_一行一个词可带危级(word_client):
    r = word_client.post(
        "/api/sensitive/words/import",
        json={"text": "退款政策,high\n最,low\n# 这是注释\n\n加微信"},
    )
    assert r.status_code == 200
    body = r.json()
    assert sorted(body["added"]) == sorted(["退款政策", "最", "加微信"])

    words = {w["word"]: w["level"] for w in word_client.get("/api/sensitive/words").json()}
    assert words["退款政策"] == "high"
    assert words["最"] == "low"
    assert words["加微信"] == "mid"  # 不写危级时用中危


def test_批量导入要逐条报告失败的行(word_client):
    """只说「成功 3 条」用户不知道哪几条没进去 —— 还得自己肉眼对。"""
    r = word_client.post("/api/sensitive/words/import", json={"text": "正常词\n危险词,超高危\n"})
    body = r.json()
    assert body["added"] == ["正常词"]
    assert len(body["skipped"]) == 1
    assert body["skipped"][0]["word"] == "危险词"
    assert "危级" in body["skipped"][0]["reason"]


def test_停用后不再参与匹配但词还在(word_client):
    """停用是"临时不生效"而不是删除 —— 词库通常一次配好长期用。"""
    wid = word_client.post("/api/sensitive/words", json={"word": "退款政策"}).json()["id"]
    word_client.post(f"/api/sensitive/words/{wid}/enabled?enabled=false")

    items = word_client.get("/api/sensitive/words").json()
    assert len(items) == 1
    assert items[0]["enabled"] is False


def test_改词之后拼音键跟着重算(word_client):
    """改了词还留着旧词的拼音键 = 静默失配：规则看着配好了，永远不命中。"""
    wid = word_client.post("/api/sensitive/words", json={"word": "退款政策"}).json()["id"]
    got = word_client.patch(f"/api/sensitive/words/{wid}", json={"word": "投诉升级"}).json()
    assert got["word"] == "投诉升级"
    assert got["matchKey"] == "tssj"

def test_导入JSON_兼容两种常见结构(word_client):
    """真实世界的词库来源太杂：有的导出是纯字符串数组，有的是带字段的对象数组。

    只认一种格式的话，用户导出后第一件事就是"导入失败" —— 而他并不知道自己该改成哪种。
    """
    # 形式一：["加微信", "私下交易"]
    r = word_client.post("/api/sensitive/words/import-json", json={
        "words": ["加微信", "私下交易"],
    })
    assert r.status_code == 200
    assert sorted(r.json()["added"]) == ["加微信", "私下交易"]

    # 形式二：[{"word": "退款政策", "level": "mid"}]
    r2 = word_client.post("/api/sensitive/words/import-json", json={
        "words": [
            {"word": "全额退", "level": "high"},
            {"word": "包退", "match_key": "bt", "level": "mid", "note": "常见话术"},
        ],
    })
    body = r2.json()
    assert sorted(body["added"]) == ["全额退", "包退"]

    words = {w["word"]: w for w in word_client.get("/api/sensitive/words").json()}
    assert words["全额退"]["level"] == "high"
    assert words["包退"]["note"] == "常见话术"


def test_导入JSON要逐条报告坏数据(word_client):
    """坏数据必须点名到是哪一条 —— 只说成功几条等于让用户自己肉眼对。"""
    r = word_client.post("/api/sensitive/words/import-json", json={
        "words": ["正常", {"word": ""}, {"word": "x", "level": "超高"}],
    })
    body = r.json()
    assert body["added"] == ["正常"]
    assert len(body["skipped"]) == 2
    # 要能指出是哪一条：只给行号用户还得自己数
    assert any(s.get("word") == "" or "空" in s.get("reason", "") for s in body["skipped"])


def test_导入studio_wordlib_json整包envelope(word_client):
    """studio 导出的词库是 {schemaVersion, updatedAt, categories, words:[...]} 整包。

    只认裸数组的话，用户拿 studio 导出的 wordlib.json 来导入会直接失败，
    而他不知道自己该拆出 words 段。所以整包 envelope 也要直接收。
    """
    r = word_client.post("/api/sensitive/words/import-json", json={
        "words": {
            "schemaVersion": 1,
            "updatedAt": "2026-10-05T00:00:00Z",
            "categories": [{"name": "诱导", "description": ""}],
            "words": [
                {"id": "abc", "text": "私下交易", "severity": "high", "category": "诱导", "enabled": True},
                {"id": "def", "text": "加微", "severity": "medium", "category": "诱导", "enabled": True},
                {"text": "包邮", "severity": "low"},
            ],
        },
    })
    assert r.status_code == 200
    body = r.json()
    assert set(body["added"]) == {"私下交易", "加微", "包邮"}
    words = {w["word"]: w for w in word_client.get("/api/sensitive/words").json()}
    assert words["私下交易"]["level"] == "high"
    assert words["加微"]["level"] == "mid"  # studio 的 medium 必须落进 app 的 mid
    assert words["包邮"]["level"] == "low"


def test_导入studio词时尊重severity与enabled(word_client):
    """studio 用 severity（high/medium/low）而非 level，且区分启用/停用。

    medium 没映射好会变成 mid 之外的非法值 → 整条被跳过；
    enabled=false 没接住 → 导入后其实是启用状态，与源文件不一致。
    """
    r = word_client.post("/api/sensitive/words/import-json", json={
        "words": [
            {"text": "诱导关注", "severity": "high", "enabled": True},
            {"text": "已停用词", "severity": "low", "enabled": False},
        ],
    })
    body = r.json()
    assert set(body["added"]) == {"诱导关注", "已停用词"}
    assert body["skipped"] == []
    words = {w["word"]: w for w in word_client.get("/api/sensitive/words").json()}
    assert words["诱导关注"]["enabled"] is True
    assert words["已停用词"]["enabled"] is False


def test_导出wordlib_json可被studio识别且能回灌(word_client):
    """导出必须长成 studio 的 wordlib.json：schemaVersion/updatedAt/words[text,severity,...]。

    否则别人在 Studio 里打开会失败（studio 用 severity、id 必须是合法 Guid）；
    而且导出物应当能原样再导入，形成"客户端导出 → 别人 studio 改 → 回灌"的闭环。
    """
    import uuid

    word_client.post("/api/sensitive/words", json={"word": "退款政策", "level": "high"})
    word_client.post("/api/sensitive/words", json={"word": "私下交易", "level": "mid"})
    r = word_client.get("/api/sensitive/export")
    assert r.status_code == 200
    body = r.json()
    assert body["schemaVersion"] == 1
    assert "updatedAt" in body

    words = {w["text"]: w for w in body["words"]}
    assert "退款政策" in words and "私下交易" in words
    assert words["退款政策"]["severity"] == "high"
    assert words["私下交易"]["severity"] == "medium"  # app 的 mid 必须落回 studio 的 medium
    # id 必须是合法 Guid，否则 studio 的 JsonSerializer 反序列化直接抛异常退化为空词库
    for w in body["words"]:
        uuid.UUID(w["id"])

    # 导出的词库能原样再导入（整包 envelope 也要直接收）
    r2 = word_client.post("/api/sensitive/words/import-json", json={"words": body})
    assert r2.status_code == 200
    assert set(r2.json()["added"]) == {"退款政策", "私下交易"}


def test_JSON导入的字符串项也支持逗号带危级(word_client):
    """纯文本导入支持「词,危级」，JSON 的字符串项必须一致。

    否则用户从纯文本切到 JSON 后，同样内容反而进不去 ——
    而且「退款政策,high」会整条当成词，拼音键算成 ffzc，规则静默失配。
    """
    r = word_client.post("/api/sensitive/words/import-json", json={"words": ["退款政策,high", "暗中交易"]})
    body = r.json()
    assert set(body["added"]) == {"退款政策", "暗中交易"}
    words = {w["word"]: w for w in word_client.get("/api/sensitive/words").json()}
    assert words["退款政策"]["level"] == "high"
    assert words["退款政策"]["matchKey"] == "tkzc"


def test_拼音键填中文要被拒绝(word_client):
    """str.isalpha() 对中文也为真 —— 曾经中文拼音键被放行，
    随后编译成永不命中的正则，正是「配了但不生效」。
    """
    r = word_client.post("/api/sensitive/words", json={"word": "退款政策", "match_key": "退款"})
    assert r.status_code == 400


def test_搜索里的百分号按字面匹配(word_client):
    """LIKE 的 % / _ 是通配符：用户搜「100%」时不该被当成「包含 100」。"""
    word_client.post("/api/sensitive/words", json={"word": "折上折", "level": "mid"})
    word_client.post("/api/sensitive/words", json={"word": "100%优惠", "level": "mid"})

    # 字面 "%折%" 不存在 → 不该命中「折上折」
    assert word_client.get("/api/sensitive/words", params={"q": "%折%"}).json() == []
    # 字面 "100%" 要能命中
    got = word_client.get("/api/sensitive/words", params={"q": "100%"}).json()
    assert [w["word"] for w in got] == ["100%优惠"]
