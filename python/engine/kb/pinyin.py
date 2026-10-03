"""拼音转换：给倒排索引喂拼音，让用户敲 `zs` 就能找到「知识库」。

移植自 know 的 `pinyin.ts`（JS 侧用 `pinyin-pro`）。中文取音改用 `pypinyin`，
两边在常见字上一致（`知识库管理` → `zskgl`、`知识库.md` → `zsk.md`、
`奥润` 全拼 → `aorun`、`数据库` → `sjk`）。**多音字不保证一致** ——
比如 `重庆`：pypinyin 给 `cq`（chongqing），pinyin-pro 给的是 `zq`（zhongqing）。
所以测试只在无歧义的字上钉死拼音串，其余断言「命中 / 不命中」。

非汉字原样保留（`React开发指南` → `Reactkfzn`、`知识库.md` → `zsk.md`），
这是拼音搜索能同时匹配英文文件名的前提。
"""
from __future__ import annotations

import re

from pypinyin import Style, lazy_pinyin

_WHITESPACE = re.compile(r"\s+")


def to_pinyin_initials(text: str) -> str:
    """汉字转拼音首字母，非汉字保留，去掉所有空白。

    `'知识库管理'` → `'zskgl'`；`'知识库.md'` → `'zsk.md'`；`'React开发指南'` → `'Reactkfzn'`

    去空白是必要的：`'Spring Boot 微服务'` 里那两处空格如果留着，
    `sbwf` 这种连打就永远匹配不上。
    """
    if not text:
        return ""
    return _WHITESPACE.sub("", "".join(lazy_pinyin(text, style=Style.FIRST_LETTER)))


def to_full_pinyin(text: str) -> str:
    """汉字转全拼（无声调），非汉字保留，空白保留。

    `'奥润'` → `'aorun'`；`'知识库'` → `'zhishiku'`；`'React开发'` → `'Reactkaifa'`
    """
    if not text:
        return ""
    return "".join(lazy_pinyin(text))
