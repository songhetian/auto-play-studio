"""切片 3：检索引擎（n-gram 倒排 + BM25）。

**这是一次移植，不是重新设计。** 真相源是 know 的 `app/src/engine/search.test.ts`
（1544 行 / 70 项，在 JS 侧当前是绿的）。这里逐组翻译，**期望值原样保留** ——
包括那些看起来奇怪的断言。例：`zs` 那条只断言「结果 ≥ 1 且首个是『知识库管理系统.md』」，
因为「无关文档.md」的内容「这是一个完全无关的文档」的拼音首字母
（`zsygwqwgdwd`）里**也有** `zs`：两篇都是拼音命中、IDF 相同因而分数相同，
靠 docId 顺序的稳定排序分先后。原作者知道这件事，所以没写成 `toBe(1)`。

刻意**不**翻译的部分（理由写在这里，别让后人以为是漏了）：

- **Web Worker 相关**（`searchAsync` / `exportIndexData` / `fromIndexData` / `search.worker`）——
  它们是为「JS 单线程 + 万级文档」存在的：在 Worker 里建索引，再把索引转移回主线程。
  Python 的引擎是服务进程，没有对应需求，搬过来只是死代码。
- **分阶段索引**（`buildFileNameIndex` / `indexDocumentContent` / `getIndexingProgress`）——
  它维护「已索引文件名 / 已索引内容」两套计数和「只索引了文件名」的中间态，
  是为了边建边搜。索引器（切片 4）逐份 `add_document` 就能得到同样的效果，
  进度由它自己的循环报出，不需要引擎里再多一套状态。
- **LRU 缓存** —— 用户每次敲键都是新查询，命中率接近 0；而它的失效点有 4 处
  （增、删、重建、换存储）。在 Python 里把同一个 list 对象返回给多个调用方
  还是共享可变状态。不挣这份复杂度。
"""
from __future__ import annotations

import pytest

from engine.kb.chunk import Paragraph
from engine.kb.engine import IndexedDocument, MapParagraphStore, SearchEngine
from engine.kb.paths import normalize_path
from engine.kb.pinyin import to_full_pinyin, to_pinyin_initials


def doc(doc_id: int, name: str, *texts: str, path: str | None = None) -> IndexedDocument:
    """构造一个已索引文档。段落行号从 1 递增（引擎不关心行号，前端关心）。"""
    return IndexedDocument(
        id=doc_id,
        file_name=name,
        file_type=name.rsplit(".", 1)[-1].lower(),
        path=path if path is not None else f"/{name}",
        paragraphs=[Paragraph(line=i + 1, text=t) for i, t in enumerate(texts)],
    )


@pytest.fixture
def sample_docs() -> list[IndexedDocument]:
    return [
        doc(
            1,
            "人力精算报告.pdf",
            "全司人均薪酬较去年同期增长8.2%，其中技术序列增幅最高达12.5%。",
            "研发部人均产出环比提升15%，但招聘成本同步上升22%。",
            path="knowledge_file/人力精算报告.pdf",
        ),
        doc(
            2,
            "客服运营中台开发文档.md",
            "系统采用微服务架构，基于 Spring Cloud Alibaba 构建。客服运营中台涵盖智能路由、会话分配、质检评分、数据看板四大核心模块。",
            "智能路由模块支持三种会话分配策略：按技能组分配、负载均衡、VIP优先。平均响应时间控制在200ms以内。",
            path="knowledge_file/客服运营中台.md",
        ),
    ]


@pytest.fixture
def bm25_docs() -> list[IndexedDocument]:
    """「系统」出现在 3 篇（常见词），「金丝雀」只出现在 2 篇（罕见词）。"""
    return [
        doc(1, "文档A.md", "系统架构设计文档"),
        doc(2, "文档B.md", "系统部署方案说明"),
        doc(3, "文档C.md", "系统运维手册"),
        doc(4, "文档D.md", "金丝雀发布策略"),
        doc(5, "文档E.md", "蓝绿部署与金丝雀"),
    ]


# ── 基础匹配 ──────────────────────────────────────────────────────────


def test_empty_query_returns_nothing(sample_docs):
    engine = SearchEngine(sample_docs)
    assert engine.search("") == []
    assert engine.search("   ") == []


def test_finds_documents_by_keyword(sample_docs):
    engine = SearchEngine(sample_docs)
    results = engine.search("薪酬")

    assert len(results) == 1
    assert results[0].document.id == 1
    assert results[0].document.file_name == "人力精算报告.pdf"
    assert len(results[0].matched_paragraphs) == 1
    assert "薪酬" in results[0].matched_paragraphs[0].text
    assert results[0].score > 0


def test_matched_paragraphs_come_from_the_same_document(sample_docs):
    """「模块」在 doc 2 的两段里都出现 → 两段都算命中。"""
    engine = SearchEngine(sample_docs)
    results = engine.search("模块")

    assert len(results) == 1
    assert results[0].document.id == 2
    assert len(results[0].matched_paragraphs) == 2
    assert results[0].score > 0


@pytest.mark.parametrize("query", ["SPRING", "spring", "Spring"])
def test_search_is_case_insensitive(sample_docs, query):
    assert len(SearchEngine(sample_docs).search(query)) == 1


def test_returns_nothing_when_no_document_matches(sample_docs):
    assert SearchEngine(sample_docs).search("不存在的关键词xyz123") == []


def test_single_character_query_does_not_crash(sample_docs):
    results = SearchEngine(sample_docs).search("人")

    assert len(results) >= 1
    hit_texts = [p.text for r in results for p in r.matched_paragraphs]
    assert any("人" in t for t in hit_texts)


def test_single_character_query_without_matches_returns_nothing(sample_docs):
    """`9` 既不在原文里，也不会出现在拼音里。"""
    assert SearchEngine(sample_docs).search("9") == []


# ── BM25 权重 ─────────────────────────────────────────────────────────


def test_rare_term_scores_higher_than_common_term(bm25_docs):
    """IDF：罕见词应当压过常见词。"""
    engine = SearchEngine(bm25_docs)

    common = [r.score for r in engine.search("系统")]
    rare = [r.score for r in engine.search("金丝雀")]

    assert len(common) == 3
    assert len(rare) == 2
    assert max(rare) > max(common)


def test_term_frequency_saturation_prevents_linear_boosting():
    """BM25 饱和：出现 10 次的文档不该比出现 1 次的高 10 倍。"""
    docs = [doc(1, "高频文档.md", "部署" * 10), doc(2, "低频文档.md", "部署")]
    results = SearchEngine(docs).search("部署")

    assert len(results) == 2
    high = next(r for r in results if r.document.id == 1).score
    low = next(r for r in results if r.document.id == 2).score

    assert high > low
    assert high / low < 5


def test_filename_match_boosts_score():
    docs = [doc(1, "部署手册.md", "部署"), doc(2, "其他文档.md", "部署")]
    results = SearchEngine(docs).search("部署")

    assert len(results) == 2
    named = next(r for r in results if r.document.id == 1)
    plain = next(r for r in results if r.document.id == 2)

    assert named.score > plain.score


def test_filename_only_match_is_still_returned(sample_docs):
    """「人力精算」只在文件名里出现，正文没有 —— 仍要能搜到（否则按文件名找文件这条路断了）。"""
    results = SearchEngine(sample_docs).search("人力精算")

    assert len(results) == 1
    assert results[0].document.id == 1
    assert results[0].matched_paragraphs == []  # 正文里没有，所以没有命中片段
    assert results[0].score > 0


# ── 多关键词 AND ──────────────────────────────────────────────────────


def test_multi_keyword_splits_on_space_and_intersects():
    docs = [
        doc(1, "匹配文档.md", "系统架构设计文档，涉及微服务部署方案"),
        doc(2, "部分匹配.md", "系统监控告警配置"),
        doc(3, "另一部分匹配.md", "部署运维手册"),
    ]
    results = SearchEngine(docs).search("系统 部署")

    assert len(results) == 1
    assert results[0].document.id == 1
    assert results[0].match_mode == "and"


def test_multi_keyword_tolerates_extra_whitespace():
    docs = [doc(1, "doc.md", "Spring Boot 微服务架构")]
    assert [r.document.id for r in SearchEngine(docs).search("  Spring   Boot  ")] == [1]


def test_multi_keyword_score_sums_across_terms():
    docs = [doc(1, "双匹配.md", "系统架构 部署方案"), doc(2, "单匹配.md", "系统架构")]
    results = SearchEngine(docs).search("系统 部署")

    assert len(results) == 1
    assert results[0].document.id == 1
    assert results[0].score > 0


def test_four_terms_all_participate_in_and():
    docs = [
        doc(1, "四词全匹配.md", "系统架构设计文档完整版"),
        doc(2, "三词匹配.md", "系统架构设计说明"),
        doc(3, "两词匹配.md", "系统架构"),
    ]
    results = SearchEngine(docs).search("系统 架构 设计 文档")

    assert [r.document.id for r in results] == [1]
    assert len(results[0].matched_paragraphs) > 0


def test_the_fourth_term_is_not_dropped():
    docs = [doc(1, "全匹配.md", "客服运营中台开发"), doc(2, "缺一词.md", "客服运营中台")]
    assert [r.document.id for r in SearchEngine(docs).search("客服 运营 中台 开发")] == [1]


def test_single_char_terms_work_in_a_multi_term_query():
    docs = [doc(1, "doc.md", "A B C 测试")]
    assert len(SearchEngine(docs).search("A B")) == 1


# ── AND 无结果 → OR 回退 ──────────────────────────────────────────────


def test_falls_back_to_or_when_and_has_no_match():
    docs = [doc(1, "只含系统.md", "系统架构设计文档"), doc(2, "只含金丝雀.md", "金丝雀发布策略")]
    results = SearchEngine(docs).search("系统 金丝雀")

    assert len(results) == 2
    assert all(r.match_mode == "or" for r in results)


def test_stays_in_and_mode_when_and_has_results():
    """有一条文档同时含两个词时，不回退 —— 否则「系统 部署」会被噪音淹没。"""
    docs = [doc(1, "都有.md", "系统架构部署方案"), doc(2, "只含系统.md", "系统监控")]
    results = SearchEngine(docs).search("系统 部署")

    assert [r.document.id for r in results] == [1]
    assert results[0].match_mode == "and"


# ── 短语紧邻加权 ──────────────────────────────────────────────────────


def test_adjacent_terms_score_higher_than_scattered_terms():
    """「系统架构」挨着写，应当比「系统…（隔开）…架构」更靠前。"""
    docs = [doc(1, "挨着.md", "系统架构"), doc(2, "隔开.md", "系统设计文档，架构说明")]
    results = SearchEngine(docs).search("系统 架构")

    assert [r.document.id for r in results] == [1, 2]


def test_proximity_boost_applies_across_consecutive_pairs():
    docs = [doc(1, "紧凑.md", "系统架构设计"), doc(2, "松散.md", "系统说明，架构概要，设计方案")]
    results = SearchEngine(docs).search("系统 架构 设计")

    assert results[0].document.id == 1


# ── type: 过滤 ────────────────────────────────────────────────────────


def test_type_filter_only_returns_that_type():
    docs = [doc(1, "文档.md", "系统架构设计"), doc(2, "文档.pdf", "系统架构设计")]
    results = SearchEngine(docs).search("系统 type:md")

    assert len(results) == 1
    assert results[0].document.file_type == "md"


def test_type_filter_works_with_multi_keyword_and():
    docs = [doc(1, "匹配.md", "系统架构设计文档"), doc(2, "非匹配.md", "系统监控告警")]
    assert [r.document.id for r in SearchEngine(docs).search("系统 架构 type:md")] == [1]


def test_unknown_type_filter_degrades_to_a_plain_term():
    """`type:exe` 不是合法类型 → 当成普通词去搜。

    它谁都匹配不上，于是 AND 落空、走 OR 兜底，返回「只命中另一个词」的文档，
    并用 `match_mode='or'` 标出来 —— 这不是静默丢掉整条查询：
    界面可以据此提示「没有完全匹配的，以下是部分匹配」。
    """
    docs = [doc(1, "文档.md", "系统架构设计"), doc(2, "文档.pdf", "系统架构设计")]
    results = SearchEngine(docs).search("系统 type:exe")

    assert len(results) == 2
    assert all(r.match_mode == "or" for r in results)


def test_type_filter_alone_returns_nothing():
    """只有 type: 没有搜索词 → 空结果（不是「列出全部 md」）。"""
    docs = [doc(1, "文档.md", "系统架构设计")]
    assert SearchEngine(docs).search("type:md") == []


# ── 段落存储（懒加载） ────────────────────────────────────────────────


def test_map_store_returns_paragraphs(sample_docs):
    store = MapParagraphStore(sample_docs)

    paras = store.get_paragraphs(1)
    assert len(paras) == 2
    assert "人均薪酬" in paras[0].text


def test_map_store_knows_which_docs_it_has(sample_docs):
    store = MapParagraphStore(sample_docs)

    assert store.has_paragraphs(1) is True
    assert store.has_paragraphs(999) is False


def test_engine_accepts_a_custom_paragraph_store(sample_docs):
    engine = SearchEngine(sample_docs, paragraph_store=MapParagraphStore(sample_docs))
    results = engine.search("薪酬")

    assert len(results) == 1
    assert len(results[0].matched_paragraphs) > 0


def test_engine_can_work_without_paragraphs_in_the_documents(sample_docs):
    """懒加载：文档里不带段落（省内存），命中片段从存储里取。

    这正是 know 把 `ParagraphStore` 抽出来的原因，也是切片 4 把段落落 SQLite 的前提。
    """
    bare = [
        IndexedDocument(id=d.id, file_name=d.file_name, file_type=d.file_type, path=d.path)
        for d in sample_docs
    ]
    engine = SearchEngine(bare, paragraph_store=MapParagraphStore(sample_docs))
    results = engine.search("薪酬")

    assert len(results) == 1
    assert len(results[0].matched_paragraphs) > 0
    assert results[0].document.paragraphs == []


# ── 增量增删 ──────────────────────────────────────────────────────────


def test_add_document_indexes_its_content(sample_docs):
    engine = SearchEngine([sample_docs[0]])
    assert engine.search("微服务") == []

    engine.add_document(sample_docs[1])

    results = engine.search("微服务")
    assert [r.document.id for r in results] == [2]


def test_add_document_keeps_existing_docs(sample_docs):
    engine = SearchEngine([sample_docs[0]])
    engine.add_document(sample_docs[1])

    assert len(engine.search("薪酬")) == 1
    assert len(engine.search("微服务")) == 1
    assert engine.document_count == 2


def test_remove_document_drops_it_from_the_index(sample_docs):
    engine = SearchEngine(sample_docs)
    assert len(engine.search("微服务")) == 1

    engine.remove_document(2)

    assert engine.search("微服务") == []
    assert len(engine.search("薪酬")) == 1


def test_removing_an_unknown_document_is_a_no_op(sample_docs):
    engine = SearchEngine(sample_docs)
    engine.remove_document(9999)  # 不该抛
    assert len(engine.search("薪酬")) == 1


def test_adding_with_an_existing_id_replaces_the_old_version(sample_docs):
    engine = SearchEngine([sample_docs[0]])
    engine.add_document(doc(1, "人力精算报告.pdf", "全新内容", path="knowledge_file/人力精算报告.pdf"))

    assert engine.search("薪酬") == []
    assert len(engine.search("全新内容")) == 1


def test_document_count_tracks_both_directions():
    engine = SearchEngine([doc(1, "a.md", "文档A"), doc(2, "b.md", "文档B")])
    assert engine.document_count == 2

    engine.add_document(doc(3, "c.md", "文档C"))
    assert engine.document_count == 3

    engine.remove_document(1)
    assert engine.document_count == 2


# ── 拼音（首字母） ────────────────────────────────────────────────────


def test_pinyin_initials_match_chinese_content():
    """`zs` → 知识。注意「无关文档」的正文首字母里也有 `zs`，所以只断言首个是谁。"""
    docs = [
        doc(1, "知识库管理系统.md", "本系统是知识库管理平台，支持文档索引和全文检索"),
        doc(2, "无关文档.md", "这是一个完全无关的文档"),
    ]
    results = SearchEngine(docs).search("zs")

    assert len(results) >= 1
    assert results[0].document.file_name == "知识库管理系统.md"


def test_pinyin_multi_char_initials():
    docs = [doc(1, "知识库.md", "知识库内容"), doc(2, "其他文档.md", "其他内容")]
    results = SearchEngine(docs).search("zsk")

    assert [r.document.file_name for r in results] == ["知识库.md"]


def test_pinyin_match_returns_preview_paragraphs():
    """拼音命中时正文里没有匹配的字，得给几段预览让用户判断是不是要找的那份。"""
    docs = [
        doc(1, "测试文档.md", "第一段内容", "第二段内容", "第三段内容"),
    ]
    results = SearchEngine(docs).search("cs")

    assert len(results) == 1
    assert len(results[0].matched_paragraphs) > 0


def test_chinese_search_still_works():
    docs = [doc(1, "知识库.md", "知识库内容")]
    results = SearchEngine(docs).search("知识")

    assert [r.document.file_name for r in results] == ["知识库.md"]


def test_mixed_latin_and_chinese_initials():
    docs = [doc(1, "React开发指南.md", "React是一个用于构建用户界面的JavaScript库")]
    assert [r.document.file_name for r in SearchEngine(docs).search("kf")] == ["React开发指南.md"]


def test_pinyin_works_for_incrementally_added_documents():
    engine = SearchEngine([])
    engine.add_document(doc(1, "数据库设计.md", "数据库表结构设计文档"))

    assert [r.document.file_name for r in engine.search("sjk")] == ["数据库设计.md"]


def test_pinyin_match_disappears_after_removal():
    docs = [doc(1, "知识库.md", "知识库内容"), doc(2, "其他.md", "其他内容")]
    engine = SearchEngine(docs)
    assert len(engine.search("zs")) == 1

    engine.remove_document(1)

    assert engine.search("zs") == []


# ── 拼音（全拼） ──────────────────────────────────────────────────────


def test_pinyin_initials_match_the_documented_examples():
    """这几个期望值抄自 know 的 `pinyin.ts` **文档注释**（写于 pinyin-pro 时代），
    不是从 pypinyin 的输出反抄的 —— 所以它能发现「换了拼音库以后取音变了」。

    多音字刻意不在这里：`重庆` pypinyin 给 `cq`、pinyin-pro 给 `zq`，两边本来就会不一样。
    """
    assert to_pinyin_initials("知识库管理") == "zskgl"
    assert to_pinyin_initials("知识库.md") == "zsk.md"
    assert to_pinyin_initials("React开发指南") == "Reactkfzn"
    assert to_pinyin_initials("") == ""


def test_full_pinyin_matches_the_documented_examples():
    assert to_full_pinyin("奥润") == "aorun"
    assert to_full_pinyin("知识库") == "zhishiku"
    assert to_full_pinyin("React开发") == "Reactkaifa"
    assert to_full_pinyin("") == ""


def test_full_pinyin_matches_chinese_content():
    docs = [doc(1, "公司简介.md", "奥润是一家科技公司，专注于智能硬件研发"), doc(2, "无关文档.md", "这是一个完全无关的文档")]
    assert [r.document.file_name for r in SearchEngine(docs).search("aorun")] == ["公司简介.md"]


def test_full_pinyin_matches_the_filename():
    docs = [doc(1, "知识库.md", "内容")]
    assert [r.document.file_name for r in SearchEngine(docs).search("zhishiku")] == ["知识库.md"]


def test_full_pinyin_matches_content():
    docs = [doc(1, "技术文档.md", "本系统的数据库采用MySQL，支持高并发访问")]
    assert [r.document.file_name for r in SearchEngine(docs).search("shujuku")] == ["技术文档.md"]


# ── 同文件多分片去重 ──────────────────────────────────────────────────


def test_same_file_in_multiple_shards_returns_one_result():
    docs = [
        doc(1, "big.md", "第一分片内容：系统架构设计概述", path="/big.md"),
        doc(2, "big.md", "第二分片内容：系统部署方案说明", path="/big.md"),
        doc(3, "other.md", "系统运维手册", path="/other.md"),
    ]
    results = SearchEngine(docs).search("系统")

    # 两个分片合成一条（哪一片分高留哪一片），另一份文件各自一条。
    # 不钉结果顺序：BM25 的长度归一会让短文档（other.md）排在前面，那是正常的。
    assert sorted(r.document.path for r in results) == ["/big.md", "/other.md"]


def test_dedup_keeps_the_best_scoring_shard():
    """两片都命中，保留分高的那片（片段才是用户真正会读的那句）。"""
    docs = [
        doc(1, "big.md", "系统", path="/big.md"),
        doc(2, "big.md", "系统系统系统系统系统", path="/big.md"),
    ]
    results = SearchEngine(docs).search("系统")

    assert len(results) == 1
    assert results[0].document.id == 2


def test_documents_without_a_path_are_not_deduped():
    """浏览器拖拽进来的文档没有路径，各自独立（不能因为都是空路径就并成一个）。"""
    docs = [doc(1, "a.md", "系统架构", path=""), doc(2, "b.md", "系统架构", path="")]
    assert len(SearchEngine(docs).search("系统")) == 2


def test_windows_and_posix_paths_of_the_same_file_are_deduped():
    docs = [doc(1, "a.md", "系统架构", path="C:\\docs\\a.md"), doc(2, "a.md", "系统架构", path="C:/docs/a.md")]
    assert len(SearchEngine(docs).search("系统")) == 1


def test_normalize_path_converts_separators_and_drops_the_trailing_slash():
    assert normalize_path("") == ""
    assert normalize_path("C:\\docs\\a.md") == "C:/docs/a.md"
    assert normalize_path("/docs/") == "/docs"


# ── fileCount：唯一文件数 ─────────────────────────────────────────────


def test_file_count_dedupes_shards_of_the_same_file():
    docs = [
        doc(1, "big.md", "chunk1", path="/big.md"),
        doc(2, "big.md", "chunk2", path="/big.md"),
        doc(3, "big.md", "chunk3", path="/big.md"),
        doc(4, "other.md", "other", path="/other.md"),
    ]
    assert SearchEngine(docs).file_count == 2
    assert SearchEngine(docs).document_count == 4


def test_file_count_equals_document_count_without_shards():
    docs = [doc(1, "a.md", "a"), doc(2, "b.md", "b")]
    assert SearchEngine(docs).file_count == 2


# ── 性能──只保证「不退化」，不是基准 ──────────────────────────────────

#: 这一档是「客服知识库」的真实量级（话术 / FAQ / SOP 几百份）。
#: **不要**照搬 know 测试里的 10000 份 —— JS 的字符级 n-gram 循环换成 Python 后，
#: 万级文档的建索引耗时不再是「一次性可忽略」的量级。这个上限是刻意的，写在工单里。
PERF_DOCS = 400


def test_search_stays_fast_on_a_realistic_knowledge_base():
    import time

    docs = [
        doc(
            i + 1,
            f"话术_{i}.md",
            f"这是第{i}篇文档，内容包含知识管理和检索功能，涉及退款、物流、发票、催单等场景。",
            f"第二段：第{i}篇的处理流程与升级条件说明。",
        )
        for i in range(PERF_DOCS)
    ]

    started = time.perf_counter()
    engine = SearchEngine(docs)
    index_seconds = time.perf_counter() - started

    started = time.perf_counter()
    results = engine.search("zs")
    search_seconds = time.perf_counter() - started

    assert len(results) > 0
    assert search_seconds < 0.5, f"400 份文档的搜索花了 {search_seconds:.2f}s"
    assert index_seconds < 30, f"400 份文档的建索引花了 {index_seconds:.2f}s"
