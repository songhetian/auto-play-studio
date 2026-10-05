"""切片 5：知识库的 HTTP 接口。

两条这里才定得下来的契约：

1. **字段名一律 camelCase**，与前端读的那套一致。上一轮 `/instances/{iid}/rows`
   回了 snake_case、前端读 camelCase，页面不报错、整张明细表全是空白与 NaN ——
   这类失配最难查，所以每个响应形状都有测试钉住字段名。
2. **索引在后台跑，接口不阻塞**。一个几百份文件的知识库要几秒到几十秒，
   让 HTTP 请求干等是不行的；进度由 `/status` 报出。
   同时**防重入**：已经在跑就不再起一个；跑的过程中新登记的文件夹会被记下来，
   这一轮结束后自动补跑（不是排一个越来越长的队）。
"""
from __future__ import annotations

import pathlib
import threading

import pytest

from engine.kb import service, store
from engine.kb.indexer import IndexReport


@pytest.fixture(autouse=True)
def _fresh_kb():
    """每个用例：清空知识库的表 + 丢掉服务层的单例（否则一个用例的索引会漏到下一个）。"""
    from engine import db

    with db.write() as c:
        for t in ("kb_folder", "kb_doc", "kb_para", "kb_history", "kb_embed"):
            c.execute(f"DELETE FROM {t}")
    service.reset()
    yield
    service.reset()


@pytest.fixture
def kb_folder(tmp_path) -> pathlib.Path:
    root = tmp_path / "知识库"
    root.mkdir()
    (root / "退款政策.md").write_text("退款政策：7 天无理由退还\n\n运费由商家承担", encoding="utf-8")
    (root / "物流说明.md").write_text("物流时效：一般 3 天送达", encoding="utf-8")
    return root


def _add_folder(client, path) -> dict:
    r = client.post("/api/kb/folders", json={"path": str(path)})
    assert r.status_code == 200, r.text
    return r.json()


def _wait_indexing(client, timeout: float = 10.0) -> dict:
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get("/api/kb/status").json()
        if not status["indexing"]["running"]:
            return status
        time.sleep(0.02)
    raise AssertionError("索引一直没结束")


# ── 状态 ──────────────────────────────────────────────────────────────


def test_status_of_an_empty_knowledge_base(client):
    body = client.get("/api/kb/status").json()

    assert body["docCount"] == 0
    assert body["fileCount"] == 0
    assert body["folders"] == []
    assert body["indexing"]["running"] is False
    assert body["failed"] == []


def test_status_field_names_match_the_frontend(client):
    """字段名是契约。会一起改就一起改，别一边改一边留。"""
    body = client.get("/api/kb/status").json()

    assert set(body) == {"docCount", "fileCount", "folders", "indexing", "failed", "semanticEnabled"}
    assert set(body["indexing"]) == {"running", "done", "total", "current"}


# ── 登记文件夹 → 后台索引 ─────────────────────────────────────────────


def test_adding_a_folder_registers_it_and_starts_indexing(client, kb_folder):
    body = _add_folder(client, kb_folder)

    assert body["folder"]["path"] == str(kb_folder).replace("\\", "/")
    assert body["folder"]["name"] == "知识库"
    assert body["started"] is True

    status = _wait_indexing(client)
    assert status["docCount"] == 2
    assert status["fileCount"] == 2
    assert status["folders"][0]["docCount"] == 2


def test_a_folder_that_does_not_exist_is_still_registered(client, tmp_path):
    """路径可能只是暂时不在（移动硬盘没插、网络盘没连），不该直接报错。"""
    body = _add_folder(client, tmp_path / "还没插上的盘")

    status = _wait_indexing(client)
    assert body["folder"]["docCount"] == 0
    assert len(status["folders"]) == 1


def test_indexing_a_folder_twice_does_not_duplicate(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)

    client.post("/api/kb/reindex")
    status = _wait_indexing(client)

    assert status["docCount"] == 2


# ── 搜索 ──────────────────────────────────────────────────────────────


def test_search_returns_file_name_and_matched_snippets(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)

    body = client.get("/api/kb/search", params={"q": "退款政策"}).json()

    assert body["query"] == "退款政策"
    assert body["count"] == 1
    hit = body["results"][0]
    assert set(hit) == {
        "path",
        "fileName",
        "fileType",
        "size",
        "mtime",
        "truncated",
        "score",
        "matchMode",
        "matchCount",
        "snippets",
        "matchedBy",
    }
    assert hit["fileName"] == "退款政策.md"
    assert hit["fileType"] == "md"
    assert hit["matchMode"] == "and"
    assert hit["matchCount"] == 1
    assert hit["snippets"] == [{"line": 1, "text": "退款政策：7 天无理由退还"}]


def test_search_supports_pinyin(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)

    body = client.get("/api/kb/search", params={"q": "tkzc"}).json()

    assert [r["fileName"] for r in body["results"]] == ["退款政策.md"]


def test_search_honours_the_limit(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)

    body = client.get("/api/kb/search", params={"q": "退款", "limit": 1}).json()

    assert body["count"] <= 1


def test_empty_query_returns_an_empty_result_set(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)

    body = client.get("/api/kb/search", params={"q": "   "}).json()

    assert body["results"] == []
    assert body["count"] == 0


def test_search_is_recorded_in_history(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)
    client.get("/api/kb/search", params={"q": "退款"})
    client.get("/api/kb/search", params={"q": "物流"})

    items = client.get("/api/kb/history").json()["items"]

    assert [i["query"] for i in items] == ["物流", "退款"]
    assert all("resultCount" in i for i in items)

    client.delete("/api/kb/history")
    assert client.get("/api/kb/history").json()["items"] == []


def test_search_result_snippets_are_capped_but_counted(tmp_path, client):
    """命中几十处时不能把整份文件塞给前端，但要告诉用户一共几处。"""
    root = tmp_path / "长文"
    root.mkdir()
    (root / "长文.md").write_text("\n\n".join(f"第{i}条：退款规则说明" for i in range(20)), encoding="utf-8")
    _add_folder(client, root)
    _wait_indexing(client)

    hit = client.get("/api/kb/search", params={"q": "退款"}).json()["results"][0]

    assert hit["matchCount"] == 20
    assert len(hit["snippets"]) == service.MAX_SNIPPETS


# ── 混合检索：关键词 + 语义，RRF 融合 ─────────────────────────────────


@pytest.fixture
def semantic_kb(tmp_path, monkeypatch):
    """一个装了假语义索引的知识库（不加载真模型）。

    直接把 `_engine` / `_semantic` 两个单例塞进服务层，绕开真模型探盘 ——
    这样融合逻辑（名次、matchedBy、回表补片段）在没有几十 MB 模型时也能测。
    """
    from engine.kb.engine import SearchEngine
    from engine.kb.indexer import reindex
    from engine.kb.semantic import SemanticIndex
    from tests.test_kb_semantic import FakeEmbedder

    root = tmp_path / "知识库"
    root.mkdir()
    (root / "退款时效说明.md").write_text(
        "退款时效说明：我们会在 24 小时内处理，请先安抚客户", encoding="utf-8"
    )
    (root / "发票抬头.md").write_text("发票抬头与税率填写说明", encoding="utf-8")

    eng = SearchEngine([], paragraph_store=store.SqliteParagraphStore())
    idx = SemanticIndex(FakeEmbedder(), store)
    reindex([str(root)], eng, embeddings=idx)

    monkeypatch.setattr(service, "_engine", eng)
    monkeypatch.setattr(service, "_semantic", idx)
    return root


def test_semantic_path_finds_a_document_with_no_literal_overlap(semantic_kb):
    """核心诉求：问句和文档标题字面不重合，也要能被语义路捞出来。

    字面检索对「客户嫌退款慢怎么回复」一个词都命中不了；
    语义路（假 embedder 的退款轴）把它捞回来，并标成 semantic。
    """
    body = service.search("客户嫌退款慢怎么回复")

    assert body["count"] == 1
    hit = body["results"][0]
    assert hit["fileName"] == "退款时效说明.md"
    assert hit["matchedBy"] == "semantic"
    assert hit["snippets"][0]["text"].startswith("退款时效说明")


def test_a_hit_both_lists_rank_is_marked_both(semantic_kb):
    body = service.search("退款时效")

    hit = next(r for r in body["results"] if r["fileName"] == "退款时效说明.md")
    assert hit["matchedBy"] == "both"


def test_keyword_only_hit_is_marked_keyword(semantic_kb):
    """语义路开着，但这条只有关键词命中时，标注仍是 keyword。

    「备注」不在假 embedder 的任何语义轴上 → 查询向量为零 → 语义路无命中；
    关键词路照常捞出这份文件。
    """
    from engine.kb.indexer import reindex

    (semantic_kb / "备注.md").write_text("内部备注：不走语义", encoding="utf-8")
    reindex([str(semantic_kb)], service.engine(), embeddings=service.semantic())

    body = service.search("内部备注")

    hit = next(r for r in body["results"] if r["fileName"] == "备注.md")
    assert hit["matchedBy"] == "keyword"


def test_a_semantic_failure_does_not_take_down_the_keyword_results(monkeypatch, semantic_kb):
    """语义是增强，不是必需：它挂了，关键词结果必须照样出来。"""
    def boom(query: str):
        raise RuntimeError("模型炸了")

    monkeypatch.setattr(service.semantic(), "search", boom)

    body = service.search("退款时效说明")

    assert body["count"] >= 1
    assert all(r["matchedBy"] == "keyword" for r in body["results"])


# ── 下线文件夹 ────────────────────────────────────────────────────────


def test_removing_a_folder_takes_its_documents_offline(client, kb_folder):
    _add_folder(client, kb_folder)
    _wait_indexing(client)

    body = client.request(
        "DELETE", "/api/kb/folders", params={"path": str(kb_folder).replace("\\", "/")}
    ).json()

    assert body["removed"] == 2
    status = client.get("/api/kb/status").json()
    assert status["docCount"] == 0
    assert status["folders"] == []
    assert client.get("/api/kb/search", params={"q": "退款"}).json()["results"] == []


# ── 防重入与补跑（注入假 reindex，避免靠 sleep 抢时序） ────────────────


def test_a_second_index_does_not_start_while_one_is_running():
    gate = threading.Event()
    runner = service.IndexRunner(engine_getter=service.engine, reindex_fn=_gated(gate))

    assert runner.start(["C:/A"]) is True
    assert runner.start(["C:/B"]) is False
    assert runner.snapshot()["running"] is True

    gate.set()
    runner.wait()


def test_a_folder_registered_during_a_run_is_picked_up_afterwards():
    """跑的过程中新登记了文件夹 → 这一轮结束后补跑一次，而不是丢掉。"""
    first_started = threading.Event()
    gate = threading.Event()
    runs: list[list[str]] = []

    def fake_reindex(folders, engine, on_progress=None):
        runs.append(list(folders))
        if len(runs) == 1:
            first_started.set()
            gate.wait(timeout=5)
        return IndexReport()

    runner = service.IndexRunner(engine_getter=service.engine, reindex_fn=fake_reindex)
    store.add_folder("C:/A")
    assert runner.start(store.folder_paths()) is True

    assert first_started.wait(timeout=5)
    store.add_folder("C:/B")
    runner.request_rerun()
    gate.set()
    runner.wait()

    assert runs[-1] == ["C:/A", "C:/B"], "补跑要带上新登记的那个文件夹"


def test_progress_is_reported_to_the_snapshot():
    def fake_reindex(folders, engine, on_progress=None):
        on_progress(1, 2, "第一个.md")
        on_progress(2, 2, "第二个.md")
        return IndexReport(indexed=2)

    runner = service.IndexRunner(engine_getter=service.engine, reindex_fn=fake_reindex)
    runner.start(["C:/A"])
    runner.wait()

    snap = runner.snapshot()
    assert snap["running"] is False
    assert snap["done"] == 2
    assert snap["total"] == 2
    assert snap["current"] == "第二个.md"


def test_failures_are_surfaced_in_status():
    def fake_reindex(folders, engine, on_progress=None):
        return IndexReport(indexed=1, failed=["坏掉.pdf：读不出来"])

    runner = service.IndexRunner(engine_getter=service.engine, reindex_fn=fake_reindex)
    runner.start(["C:/A"])
    runner.wait()

    assert runner.snapshot()["failed"] == ["坏掉.pdf：读不出来"]


def _gated(gate: threading.Event):
    def fake_reindex(folders, engine, on_progress=None):
        gate.wait(timeout=5)
        return IndexReport()

    return fake_reindex


# ── 设备层：打开原文件（不进自动化测试，只钉住「不许打开没索引的路径」） ────


def test_opening_a_path_that_is_not_indexed_is_refused(client, tmp_path):
    """引擎要能在本机帮用户开文件，但它不是一个「随便开什么路径」的入口。"""
    outsider = tmp_path / "外面的文件.md"
    outsider.write_text("不在知识库里", encoding="utf-8")

    r = client.post("/api/kb/open", json={"path": str(outsider)})

    assert r.status_code == 404


def test_opening_an_indexed_file_calls_the_opener(client, kb_folder, monkeypatch):
    _add_folder(client, kb_folder)
    _wait_indexing(client)
    opened: list[str] = []
    monkeypatch.setattr(service, "_open_with_system", opened.append)

    r = client.post("/api/kb/open", json={"path": str(kb_folder / "退款政策.md")})

    assert r.status_code == 200
    assert opened and opened[0].endswith("退款政策.md")
