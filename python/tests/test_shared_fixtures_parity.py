"""守卫：**跨语言共用的黄金用例，两份副本必须一致**。

工单 01 起立的约束是「前后端共用同一组用例」。两侧各留一份副本是为了避开跨目录
import —— 生产代码谁都不读它们，只有两侧的测试读。

目前看住两对：
- `template_cases.json`（模板与格式化引擎）
- `key_cases.json`（按键词表与组合键归一化）

守卫的目的：任何一侧单独改了语义，这条测试立刻红，而不是等两侧表现对不上
才回头怀疑「是哪边写错了」。

比的是**解析后的结构**而不是字节：JSON 的键顺序和缩进无关语义，
字节比较只会给出「文件不同」这种没法定位的报错。
"""
from __future__ import annotations

import json
import pathlib

import pytest

_PY_ROOT = pathlib.Path(__file__).parent
_REPO_ROOT = _PY_ROOT.parents[1]

#: (说明, Python 侧, 前端侧)
PAIRS = [
    (
        "模板与格式化引擎",
        _PY_ROOT / "fixtures" / "template_cases.json",
        _REPO_ROOT / "src" / "lib" / "template.cases.json",
    ),
    (
        "按键词表与组合键",
        _PY_ROOT / "fixtures" / "key_cases.json",
        _REPO_ROOT / "src" / "lib" / "key.cases.json",
    ),
]


@pytest.mark.parametrize("label,python_side,web_side", PAIRS, ids=[p[0] for p in PAIRS])
def test_both_copies_exist(label: str, python_side: pathlib.Path, web_side: pathlib.Path):
    assert python_side.exists(), f"[{label}] 缺少 Python 侧黄金用例：{python_side}"
    assert web_side.exists(), f"[{label}] 缺少前端侧黄金用例：{web_side}"


@pytest.mark.parametrize("label,python_side,web_side", PAIRS, ids=[p[0] for p in PAIRS])
def test_copies_are_identical(label: str, python_side: pathlib.Path, web_side: pathlib.Path):
    py = json.loads(python_side.read_text(encoding="utf-8"))
    web = json.loads(web_side.read_text(encoding="utf-8"))

    assert py == web, f"[{label}] 两份副本已漂移，请把改动同步到 {python_side} 与 {web_side}"
