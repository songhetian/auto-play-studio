"""检索引擎：n-gram 倒排索引 + BM25 排序 + 拼音匹配。

移植自 know 的 `know/app/src/engine/search.ts`（1013 行）。算法本身没改，
所以这里只写“为什么是这样”，实现细节看代码。

## 三步

1. **索引**：每段文本（含文件名、拼音首字母、全拼）抽出 2-gram 与 3-gram，
   建 `gram → [doc_id]` 的倒排表。倒排表进内存，原文段落留在 `ParagraphStore`。
2. **取候选**：查询词按长度取 2-gram 或 3-gram，求**交集**得到候选文档。
   单字查询没有 gram 可切，退化成「扫所有以该字开头的 gram 求并集」，
   所以有 `MAX_CANDIDATES` 这道闸。
3. **验真 + 排序**：候选只是「可能包含」，必须在原文/文件名/拼音里**真的**包含才算命中；
   然后按 BM25 打分。AND 优先，一条都没有时降级为 OR（`match_mode` 会标出来）。

## 几个刻意的取舍

- **全拼只索引 3-gram**（`_extract_trigrams`）。全拼的 2-gram（`zh`/`sh`/`ao`…）
  几乎每篇中文文档都含，会把候选集撑爆，反而拖垮搜索。
- **文件名命中 ×1.5**；只命中文件名而正文没有时，分数被压到 `idf * 0.3 * 1.5`
  ——要能按文件名找到文件，但不该压过正文命中。
- **只命中拼音时**（`zs` → 知识）塞前 3 段当预览：正文里没有可高亮的字，
  不给点上下文用户没法判断是不是这份文件。
- **候选上限 200**（`MAX_CANDIDATES`）。取的是前 200 个 doc_id，而不是「最相关的 200 个」——
  这是原实现的行为：这里只是防卡死的闸门，真正的排序在后面。

## 性能（实测，本机）

| 文档数 | 建索引 | 拼音搜索 | 双词搜索 |
| --- | --- | --- | --- |
| 400 | 0.5s | 1.3ms | 1.7ms |
| 1000 | 1.3s | 1.2ms | 2.5ms |
| 2000 | 2.5s | 1.2ms | 3.0ms |

建索引是线性的、搜索是常数级的（候选集有 `MAX_CANDIDATES` 闸门）。
所以量级假设是**几百到几千份**（客服知识库：话术 / FAQ / SOP 的真实量级）——
启动时从库重建一次索引是零点几秒，可以接受。

know 的测试里有一档「10000 份」，**那一档这里不照搬**：万级要靠增量
（索引器逐份 `add_document`，边索引边可搜）而不是一次性重建。
真要常驻万级，得把倒排表也落 SQLite、按需回表 —— 那是另一件事。
"""
from __future__ import annotations

import dataclasses
import math
import re
from typing import Protocol

from .chunk import Paragraph
from .paths import normalize_path
from .pinyin import to_full_pinyin, to_pinyin_initials
from .types import IndexedDocument, SearchResult

#: BM25 参数（词频饱和系数 / 长度归一化系数）
K1 = 1.5
B = 0.75

#: 相邻两词距离 ≤ 3 字时的额外乘数；≤ 10 字时给 1.1
PROXIMITY_BOOST = 1.3
PROXIMITY_NEAR = 10

#: 合法的 `type:` 过滤值
VALID_FILE_TYPES = frozenset({"pdf", "xlsx", "docx", "md", "pptx", "txt"})

#: 只命中文件名 / 只命中拼音时的分数折扣
NAME_ONLY_FACTOR = 0.3
PINYIN_ONLY_FACTOR = 0.2

#: 文件名命中加权
NAME_MATCH_BOOST = 1.5

#: 拼音命中时给几段预览（正文里没有可高亮的字，得有上下文）
PREVIEW_PARAGRAPHS = 3

_TYPE_PREFIX = re.compile(r"^type:(.+)$", re.IGNORECASE)


class ParagraphStore(Protocol):
    """段落存储：把原文段落从引擎内存里挪出去，按需取。

    `add_document` / `remove_document` 是可选的（用 `callable(getattr(...))` 探），
    和 know 的做法一致 —— 只读的存储不必实现它们。
    """

    def get_paragraphs(self, doc_id: int) -> list[Paragraph]: ...

    def has_paragraphs(self, doc_id: int) -> bool: ...


class MapParagraphStore:
    """全放内存的实现（测试与「文档自带段落」的默认路径）。"""

    def __init__(self, documents: list[IndexedDocument] | None = None) -> None:
        self._map: dict[int, list[Paragraph]] = {d.id: list(d.paragraphs) for d in (documents or ())}

    def get_paragraphs(self, doc_id: int) -> list[Paragraph]:
        return self._map.get(doc_id, [])

    def has_paragraphs(self, doc_id: int) -> bool:
        return doc_id in self._map

    def add_document(self, doc: IndexedDocument) -> None:
        self._map[doc.id] = list(doc.paragraphs)

    def remove_document(self, doc_id: int) -> None:
        self._map.pop(doc_id, None)


@dataclasses.dataclass(frozen=True)
class _TermStat:
    candidates: list[int] | None
    doc_freq: int
    idf: float


class SearchEngine:
    """倒排索引 + BM25。

    用法：
        engine = SearchEngine(documents)
        for r in engine.search("退款 流程"):
            ...
    """

    #: 候选文档上限：防止宽泛查询把全文扫描拖死
    MAX_CANDIDATES = 200

    def __init__(
        self,
        documents: list[IndexedDocument] | None = None,
        paragraph_store: ParagraphStore | None = None,
    ) -> None:
        docs = list(documents or [])
        self._documents: list[IndexedDocument] = []
        self._doc_map: dict[int, IndexedDocument] = {}
        self._index: dict[str, list[int]] = {}
        self._lower_texts: dict[int, list[str]] = {}
        self._lower_full_text: dict[int, str] = {}
        self._lower_file_names: dict[int, str] = {}
        self._lower_pinyin_initials: dict[int, str] = {}
        self._lower_full_pinyin: dict[int, str] = {}
        self._doc_lengths: dict[int, int] = {}
        self._avg_doc_length = 0.0
        self._paragraph_store: ParagraphStore = (
            paragraph_store if paragraph_store is not None else MapParagraphStore(docs)
        )
        self.build(docs)

    # ── 只读信息 ──────────────────────────────────────────────────────

    @property
    def document_count(self) -> int:
        return len(self._documents)

    def document(self, doc_id: int) -> IndexedDocument | None:
        """按 id 取文档。

        语义检索只给得出 doc_id（向量表里没有文件名），补造结果时要用它回表；
        倒排索引本身用不到，所以以前没有这个方法。
        """
        return self._doc_map.get(doc_id)

    def paragraphs(self, doc_id: int) -> list[Paragraph]:
        """按 id 取段落（懒加载存储里的原文）。"""
        return self._paragraph_store.get_paragraphs(doc_id)

    @property
    def file_count(self) -> int:
        """唯一文件数。同一份文件被切成多片（多个 doc）时只算一个。"""
        paths = set()
        for doc in self._documents:
            np = normalize_path(doc.path)
            paths.add(np if np else f"__id_{doc.id}")
        return len(paths)

    # ── 建索引 ────────────────────────────────────────────────────────

    def build(self, documents: list[IndexedDocument]) -> None:
        """全量重建。"""
        self._documents = []
        self._doc_map.clear()
        self._index.clear()
        self._lower_texts.clear()
        self._lower_full_text.clear()
        self._lower_file_names.clear()
        self._lower_pinyin_initials.clear()
        self._lower_full_pinyin.clear()
        self._doc_lengths.clear()
        self._avg_doc_length = 0.0

        self._documents = list(documents)
        total_len = 0
        for doc in self._documents:
            self._index_document(doc)
            total_len += self._doc_lengths[doc.id]
        self._avg_doc_length = total_len / len(self._documents) if self._documents else 0.0

    def add_document(self, doc: IndexedDocument) -> None:
        """增量索引一份文档。同 id 已存在时先撤掉旧版本（相当于更新）。"""
        if doc.id in self._doc_map:
            self.remove_document(doc.id)

        self._documents.append(doc)
        # 先让存储收下这份文档的段落，否则 `_index_document` 从存储里取到的是空的 ——
        # 增量加进来的文档会「搜不到自己的内容」，且不报任何错。
        add_to_store = getattr(self._paragraph_store, "add_document", None)
        if callable(add_to_store):
            add_to_store(doc)
        self._index_document(doc)

        n = len(self._documents)
        if n:
            self._avg_doc_length += (self._doc_lengths[doc.id] - self._avg_doc_length) / n

    def remove_document(self, doc_id: int) -> None:
        """从索引里撤掉一份文档。id 不存在时静默跳过。"""
        doc = self._doc_map.get(doc_id)
        if doc is None:
            return

        # 撤 gram 时必须用**和索引时完全一样**的抽取方式，否则会留下摘不掉的孤儿 gram：
        # 同一个 gram 在文件名与正文里都出现过时，`seen` 保证只摘一次。
        seen: set[str] = set()
        self._remove_ngrams(doc.file_name, doc_id, seen)
        for para in self._paragraph_store.get_paragraphs(doc_id):
            self._remove_ngrams(para.text, doc_id, seen)
        stored_initials = self._lower_pinyin_initials.get(doc_id, "")
        if stored_initials:
            self._remove_ngrams(stored_initials, doc_id, seen)
        stored_full_pinyin = self._lower_full_pinyin.get(doc_id, "")
        if stored_full_pinyin:
            self._remove_trigrams(stored_full_pinyin, doc_id, seen)

        old_len = self._doc_lengths.get(doc_id, 0)
        for book in (
            self._doc_map,
            self._lower_texts,
            self._lower_full_text,
            self._lower_file_names,
            self._lower_pinyin_initials,
            self._lower_full_pinyin,
            self._doc_lengths,
        ):
            book.pop(doc_id, None)

        remove_from_store = getattr(self._paragraph_store, "remove_document", None)
        if callable(remove_from_store):
            remove_from_store(doc_id)

        self._documents = [d for d in self._documents if d.id != doc_id]
        n = len(self._documents)
        self._avg_doc_length = (self._avg_doc_length * (n + 1) - old_len) / n if n else 0.0

    def _index_document(self, doc: IndexedDocument) -> None:
        """把一份文档塞进所有内部表。`build` 与 `add_document` 共用这一条路径。"""
        self._doc_map[doc.id] = doc
        paragraphs = self._paragraph_store.get_paragraphs(doc.id)

        lowers = [p.text.lower() for p in paragraphs]
        self._lower_texts[doc.id] = lowers
        full_text = "\n".join(lowers)
        self._lower_full_text[doc.id] = full_text
        self._lower_file_names[doc.id] = doc.file_name.lower()

        # 拼音只算一次，同时用于建 n-gram 和搜索时的精确匹配
        all_text = doc.file_name + "\n" + "\n".join(p.text for p in paragraphs)
        initials = to_pinyin_initials(all_text).lower()
        full_pinyin = to_full_pinyin(all_text).lower()
        self._lower_pinyin_initials[doc.id] = initials
        self._lower_full_pinyin[doc.id] = full_pinyin

        self._index_grams(doc.id, doc.file_name, paragraphs, initials, full_pinyin)
        self._doc_lengths[doc.id] = len(full_text)

    # ── n-gram ────────────────────────────────────────────────────────

    def _index_grams(
        self,
        doc_id: int,
        file_name: str,
        paragraphs: list[Paragraph],
        initials: str,
        full_pinyin: str,
    ) -> None:
        seen: set[str] = set()
        self._extract_ngrams(file_name, doc_id, seen)
        for para in paragraphs:
            self._extract_ngrams(para.text, doc_id, seen)
        if initials:
            self._extract_ngrams(initials, doc_id, seen)
        if full_pinyin:
            # 全拼只收 3-gram：2-gram 会撑爆倒排表（见模块 docstring）
            self._extract_trigrams(full_pinyin, doc_id, seen)

    def _extract_ngrams(self, text: str, doc_id: int, seen: set[str]) -> None:
        s = text.lower()
        n = len(s)
        for i in range(max(n - 1, 0)):
            bigram = s[i : i + 2]
            if bigram not in seen:
                seen.add(bigram)
                self._add_to_index(bigram, doc_id)
            if i <= n - 3:
                trigram = s[i : i + 3]
                if trigram not in seen:
                    seen.add(trigram)
                    self._add_to_index(trigram, doc_id)

    def _extract_trigrams(self, text: str, doc_id: int, seen: set[str]) -> None:
        s = text.lower()
        for i in range(max(len(s) - 2, 0)):
            trigram = s[i : i + 3]
            if trigram not in seen:
                seen.add(trigram)
                self._add_to_index(trigram, doc_id)

    def _add_to_index(self, gram: str, doc_id: int) -> None:
        bucket = self._index.get(gram)
        if bucket is None:
            bucket = []
            self._index[gram] = bucket
        if not bucket or bucket[-1] != doc_id:
            bucket.append(doc_id)

    def _remove_from_index(self, gram: str, doc_id: int) -> None:
        bucket = self._index.get(gram)
        if not bucket:
            return
        try:
            bucket.remove(doc_id)
        except ValueError:
            return
        if not bucket:
            del self._index[gram]

    def _remove_ngrams(self, text: str, doc_id: int, seen: set[str]) -> None:
        s = text.lower()
        n = len(s)
        for i in range(max(n - 1, 0)):
            bigram = s[i : i + 2]
            if bigram not in seen:
                seen.add(bigram)
                self._remove_from_index(bigram, doc_id)
            if i <= n - 3:
                trigram = s[i : i + 3]
                if trigram not in seen:
                    seen.add(trigram)
                    self._remove_from_index(trigram, doc_id)

    def _remove_trigrams(self, text: str, doc_id: int, seen: set[str]) -> None:
        s = text.lower()
        for i in range(max(len(s) - 2, 0)):
            trigram = s[i : i + 3]
            if trigram not in seen:
                seen.add(trigram)
                self._remove_from_index(trigram, doc_id)

    # ── 搜索 ──────────────────────────────────────────────────────────

    def search(self, query: str) -> list[SearchResult]:
        terms, type_filter = self._parse_query(query)
        if not terms:
            return []

        term_stats = self._compute_term_stats(terms, len(self._documents))

        results = self._search_with_mode(terms, term_stats, "and", type_filter)
        if not results and len(terms) >= 2:
            # AND 一条都没有 → 放宽成 OR。用户敲两个词是想收窄，不是想搜不到。
            results = self._search_with_mode(terms, term_stats, "or", type_filter)

        results.sort(key=lambda r: -r.score)
        return _dedupe_by_path(results)

    @staticmethod
    def _parse_query(raw_query: str) -> tuple[list[str], str | None]:
        terms: list[str] = []
        type_filter: str | None = None
        for part in raw_query.split():  # 任意空白分词，丢掉空段
            m = _TYPE_PREFIX.match(part)
            if m:
                value = m.group(1).lower()
                if value in VALID_FILE_TYPES:
                    type_filter = value
                    continue
                # 非法 type: 值当普通词，别把整条查询静默吃掉
            terms.append(part.lower())
        return terms, type_filter

    def _compute_term_stats(self, terms: list[str], n_docs: int) -> list[_TermStat]:
        stats = []
        for term in terms:
            candidates = self._candidates_for_term(term)
            doc_freq = len(candidates) if candidates else 0
            idf = (
                math.log((n_docs - doc_freq + 0.5) / (doc_freq + 0.5) + 1)
                if n_docs > 0 and doc_freq > 0
                else 0.0
            )
            stats.append(_TermStat(candidates=candidates, doc_freq=doc_freq, idf=idf))
        return stats

    def _candidates_for_term(self, term: str) -> list[int] | None:
        """倒排表里取候选。

        1 字 → 以该字开头的 2-gram 求并集（没有 gram 可切）；
        2 字 → 2-gram 交集；3 字以上 → 3-gram 交集。
        返回 `None` 表示「一定不可能命中」（缺 gram），空列表同理。
        """
        n = 3 if len(term) >= 3 else 2
        grams = [term[i : i + n] for i in range(len(term) - n + 1)]

        if not grams:
            # 单字查询：扫全部 gram。候选超上限就提前退出，否则宽泛查询会卡死。
            candidates: list[int] | None = None
            for gram, doc_ids in self._index.items():
                if gram.startswith(term):
                    candidates = list(doc_ids) if candidates is None else _union(candidates, doc_ids)
                    if len(candidates) > self.MAX_CANDIDATES:
                        break
            return candidates

        candidates = None
        for gram in grams:
            doc_ids = self._index.get(gram)
            if not doc_ids:
                return None
            candidates = list(doc_ids) if candidates is None else _intersect(candidates, doc_ids)
            if not candidates:
                return None
        return candidates

    def _search_with_mode(
        self,
        terms: list[str],
        term_stats: list[_TermStat],
        mode: str,
        type_filter: str | None,
    ) -> list[SearchResult]:
        candidates: list[int] | None = None
        for stat in term_stats:
            bucket = stat.candidates
            if not bucket:
                if mode == "and":
                    return []
                continue
            if candidates is None:
                candidates = list(bucket)
            else:
                candidates = _intersect(candidates, bucket) if mode == "and" else _union(candidates, bucket)
            if mode == "and" and not candidates:
                return []
        if not candidates:
            return []
        if len(candidates) > self.MAX_CANDIDATES:
            candidates = candidates[: self.MAX_CANDIDATES]

        results: list[SearchResult] = []
        for doc_id in candidates:
            doc = self._doc_map.get(doc_id)
            if doc is None:
                continue
            if type_filter and doc.file_type != type_filter:
                continue

            full_text = self._lower_full_text.get(doc_id, "")
            lower_name = self._lower_file_names.get(doc_id, "")
            initials = self._lower_pinyin_initials.get(doc_id, "")
            full_pinyin = self._lower_full_pinyin.get(doc_id, "")
            if not full_text and not lower_name and not initials and not full_pinyin:
                continue

            # 每个词在四个来源里命中与否（原文 / 文件名 / 拼音首字母 / 全拼）
            flags = [
                (
                    term in full_text,
                    bool(lower_name) and term in lower_name,
                    bool(initials) and term in initials,
                    bool(full_pinyin) and term in full_pinyin,
                )
                for term in terms
            ]
            matching_terms = [terms[i] for i, f in enumerate(flags) if any(f)]
            if mode == "and" and len(matching_terms) != len(terms):
                continue
            if mode == "or" and not matching_terms:
                continue

            has_name_match = any(f[1] for f in flags)
            has_pinyin_match = any(f[2] or f[3] for f in flags)

            paragraphs = self._paragraph_store.get_paragraphs(doc_id)
            matched: list[Paragraph] = []
            for i, lower_text in enumerate(self._lower_texts.get(doc_id, [])):
                if any(t in lower_text for t in matching_terms) and i < len(paragraphs):
                    matched.append(paragraphs[i])

            score = self._bm25(
                terms, flags, term_stats, full_text, self._doc_lengths.get(doc_id, 0)
            )
            if len(matching_terms) >= 2:
                boost = _compute_proximity_boost(full_text, matching_terms)
                if boost > 1:
                    score *= boost
            if has_name_match:
                score *= NAME_MATCH_BOOST

            if not matched and has_name_match:
                # 只命中文件名：能搜到，但压过正文命中就不对了
                score = sum(
                    stat.idf * NAME_ONLY_FACTOR * NAME_MATCH_BOOST
                    for stat, f in zip(term_stats, flags)
                    if any(f)
                )

            if not matched and not has_name_match and has_pinyin_match:
                # 只命中拼音：正文里没有可高亮的字，塞前几段当预览
                matched.extend(paragraphs[:PREVIEW_PARAGRAPHS])
                score = sum(stat.idf * PINYIN_ONLY_FACTOR for stat, f in zip(term_stats, flags) if any(f))

            if matched or has_name_match:
                results.append(
                    SearchResult(
                        document=doc,
                        matched_paragraphs=matched,
                        score=score,
                        match_mode=mode,
                    )
                )

        return results

    def _bm25(
        self,
        terms: list[str],
        flags: list[tuple[bool, bool, bool, bool]],
        term_stats: list[_TermStat],
        full_text: str,
        doc_len: int,
    ) -> float:
        """只对真正命中的词累加（只命中拼音/文件名的词，词频是 0，贡献自然是 0）。"""
        score = 0.0
        length_norm = 1 - B + B * (doc_len / max(self._avg_doc_length, 1))
        for term, flag, stat in zip(terms, flags, term_stats):
            if not any(flag):
                continue
            tf = _count_term_frequency(full_text, term)
            numerator = tf * (K1 + 1)
            denominator = tf + K1 * length_norm
            score += stat.idf * (numerator / denominator)
        return score


# ── 纯函数工具 ────────────────────────────────────────────────────────


def _dedupe_by_path(results: list[SearchResult]) -> list[SearchResult]:
    """同一文件的多个分片只留最高分那条（调用方已按分数降序排好）。

    空路径不参与去重 —— 那是「拖进来的散文件」，各自独立。
    """
    seen: set[str] = set()
    out: list[SearchResult] = []
    for r in results:
        key = normalize_path(r.document.path)
        if not key:
            out.append(r)
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _intersect(a: list[int], b: list[int]) -> list[int]:
    if len(a) > len(b):
        a, b = b, a
    set_b = set(b)
    return sorted(x for x in a if x in set_b)


def _union(a: list[int], b: list[int]) -> list[int]:
    return sorted(set(a) | set(b))


def _occurrence_positions(text: str, term: str) -> list[int]:
    """term 在 text 里的所有**不重叠**出现位置（与 know 的 indexOf 步进一致）。"""
    if not term:
        return []
    positions = []
    pos = text.find(term)
    while pos != -1:
        positions.append(pos)
        pos = text.find(term, pos + len(term))
    return positions


def _count_term_frequency(text: str, term: str) -> int:
    return len(_occurrence_positions(text, term))


def _compute_proximity_boost(full_text: str, terms: list[str]) -> float:
    """短语紧邻加权：相邻两词离得近就加分。

    距离 ≤ 3 字 → ×1.3，≤ 10 字 → ×1.1，再远不加分。
    「系统架构」和「系统……（隔一段）……架构」对用户不是一回事。
    """
    boost = 1.0
    contributed = False

    for a, b in zip(terms, terms[1:]):
        a_positions = _occurrence_positions(full_text, a)
        b_positions = _occurrence_positions(full_text, b)
        if not a_positions or not b_positions:
            continue

        min_distance = None
        ai = bi = 0
        while ai < len(a_positions) and bi < len(b_positions):
            a_pos = a_positions[ai]
            b_pos = b_positions[bi]
            distance = abs(b_pos - (a_pos + len(a)))
            if min_distance is None or distance < min_distance:
                min_distance = distance
            if a_pos + len(a) <= b_pos:
                ai += 1
            else:
                bi += 1
        if min_distance is None:
            continue

        if min_distance <= 3:
            boost *= PROXIMITY_BOOST
            contributed = True
        elif min_distance <= PROXIMITY_NEAR:
            boost *= 1.1
            contributed = True

    return boost if contributed else 1.0
