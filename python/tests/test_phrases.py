# -*- coding: utf-8 -*-
"""话术库的行为规格。

客服每天要重复回同一批问题。把话术沉淀下来、能在会话里一键发出去，
是这个工具对客服场景最有价值的一环。
"""


def test_新建话术后能列出来(phrase_client):
    r = phrase_client.post("/api/phrases", json={"title": "欢迎语", "body": "您好，很高兴为您服务", "category": "开场"})
    assert r.status_code == 200
    pid = r.json()["id"]

    items = phrase_client.get("/api/phrases").json()
    assert any(p["id"] == pid for p in items)


def test_标题不能为空(client):
    assert client.post("/api/phrases", json={"title": "  ", "body": "x"}).status_code == 400


def test_正文不能为空_空话术发出去等于没发(client):
    assert client.post("/api/phrases", json={"title": "欢迎语", "body": ""}).status_code == 400


def test_标题重复时覆盖而不是新增两条(phrase_client):
    """用户改话术是"覆盖"，列表里出现两条同名会让人不知道该用哪条。"""
    first = phrase_client.post("/api/phrases", json={"title": "退款", "body": "请提供订单号"}).json()
    second = phrase_client.post("/api/phrases", json={"title": "退款", "body": "请提供订单号和手机号"}).json()

    items = phrase_client.get("/api/phrases").json()
    same = [p for p in items if p["title"] == "退款"]
    assert len(same) == 1
    assert same[0]["body"] == "请提供订单号和手机号"
    assert same[0]["id"] == first["id"]


def test_按分类筛选(phrase_client):
    phrase_client.post("/api/phrases", json={"title": "A", "body": "a", "category": "售后"})
    phrase_client.post("/api/phrases", json={"title": "B", "body": "b", "category": "物流"})
    got = phrase_client.get("/api/phrases?category=售后").json()
    assert [p["title"] for p in got] == ["A"]


def test_按关键词搜索标题与正文(phrase_client):
    phrase_client.post("/api/phrases", json={"title": "退款流程", "body": "点击订单页申请"})
    phrase_client.post("/api/phrases", json={"title": "物流查询", "body": "单号在右上角"})
    assert len(phrase_client.get("/api/phrases?q=退款").json()) == 1
    assert len(phrase_client.get("/api/phrases?q=订单").json()) == 1  # 命中正文
    assert len(phrase_client.get("/api/phrases?q=不存在的词").json()) == 0


def test_修改话术(phrase_client):
    pid = phrase_client.post("/api/phrases", json={"title": "改我", "body": "旧"}).json()["id"]
    assert phrase_client.patch(f"/api/phrases/{pid}", json={"body": "新"}).status_code == 200
    assert phrase_client.get("/api/phrases").json()[0]["body"] == "新"


def test_删除话术(client):
    pid = client.post("/api/phrases", json={"title": "删我", "body": "x"}).json()["id"]
    assert client.delete(f"/api/phrases/{pid}").status_code == 200
    assert all(p["id"] != pid for p in client.get("/api/phrases").json())


def test_用一次就累加使用次数_常用的自动排前面(phrase_client):
    pid = phrase_client.post("/api/phrases", json={"title": "高频", "body": "x"}).json()["id"]
    phrase_client.post(f"/api/phrases/{pid}/use")
    assert phrase_client.get("/api/phrases").json()[0]["usedCount"] == 1


def test_按使用次数排序_常用话术在前(phrase_client):
    """客服一天用几十次同一句，翻找成本很高；不常用的沉到底部。"""
    phrase_client.post("/api/phrases", json={"title": "低频", "body": "x"})
    hot = phrase_client.post("/api/phrases", json={"title": "高频", "body": "y"}).json()["id"]
    for _ in range(3):
        phrase_client.post(f"/api/phrases/{hot}/use")

    titles = [p["title"] for p in phrase_client.get("/api/phrases").json()]
    assert titles.index("高频") < titles.index("低频")


def test_列出所有分类_给前端做筛选栏(phrase_client):
    phrase_client.post("/api/phrases", json={"title": "A", "body": "a", "category": "售后"})
    phrase_client.post("/api/phrases", json={"title": "B", "body": "b", "category": "物流"})
    cats = phrase_client.get("/api/phrases/categories").json()
    assert set(cats) == {"售后", "物流"}


def test_分类去重且忽略空分类(phrase_client):
    phrase_client.post("/api/phrases", json={"title": "A", "body": "a", "category": "售后"})
    phrase_client.post("/api/phrases", json={"title": "B", "body": "b", "category": "售后"})
    phrase_client.post("/api/phrases", json={"title": "C", "body": "c", "category": ""})
    cats = phrase_client.get("/api/phrases/categories").json()
    assert cats == ["售后"]


def test_变量占位符原样保存_不提前替换(client):
    """替换发生在"发给某个客户"的时刻，知识库里要保留模板本身。"""
    body = "您好 {客户名}，您的订单 {订单号} 已发货"
    r = client.post("/api/phrases", json={"title": "发货通知", "body": body})
    assert r.json()["body"] == body


def test_标题长度超限要拦住(client):
    assert client.post("/api/phrases", json={"title": "长" * 100, "body": "x"}).status_code == 400


def test_修改不存在的话术返回404(client):
    assert client.patch("/api/phrases/99999", json={"body": "x"}).status_code == 404
    assert client.delete("/api/phrases/99999").status_code == 404
