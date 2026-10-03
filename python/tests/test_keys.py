"""Seam：按键词表与组合键归一化（`python/engine/keys.py`）。

`normalize_combo(raw) -> (combo, reason)`：把用户写的 `Ctrl+C` / `ctrl+c` / `Control + C`
整理成 pyautogui 认得的 `['ctrl', 'c']`；认不出来就返回原因，由调用方决定怎么炸。

**为什么必须单独一个模块**：系统里有两套互不相干的键位语汇 ——
`src/lib/hotkey.ts` 走 Electron accelerator（`CommandOrControl` / `Super` / `Return`），
是注册全局快捷键用的；指令层要的是 pyautogui 的词表（`ctrl` / `win` / `enter`）。
指令层以前**根本没有归一化器**，用户写 `Ctr+C` 会原样传到 pyautogui，跑起来才炸 ——
而且 `hotkey('ctrl+c')` 与 `press('ctrl+c')` 都会静默地什么都不做。

词表的检查有独立真相源：**真的 pyautogui.KEYBOARD_KEYS**。
凭印象编一个键名不会「看起来对」，会直接红。
"""
from __future__ import annotations

import json
import pathlib

import pyautogui
import pytest

from engine.keys import normalize_combo

_CASES = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "key_cases.json").read_text(encoding="utf-8")
)

_KNOWN = set(pyautogui.KEYBOARD_KEYS)


def _canonical_names() -> set[str]:
    """词表里所有「会真的传给 pyautogui」的规范名。别名不算 —— 别名只在解析时用。"""
    patterns = _CASES["patterns"]
    return (
        set(_CASES["modifiers"])
        | set(_CASES["table"])
        | set(patterns["letters"])
        | set(patterns["digits"])
        | set(patterns["function"])
    )


# ── 词表本身 ──────────────────────────────────────────────
def test_every_canonical_name_is_a_real_pyautogui_key():
    missing = sorted(n for n in _canonical_names() if n not in _KNOWN)

    assert not missing, f"这些键名 pyautogui 不认识，会静默按键失败：{missing}"


def test_every_alias_maps_to_its_own_canonical_name_first():
    """别名表第一项是规范名自身 —— 否则解析结果和词表对不上。"""
    for canonical, aliases in _CASES["table"].items():
        assert aliases[0] == canonical, f"{canonical} 的别名表第一项应该是它自己"


def test_modifier_aliases_are_declared_in_the_table():
    """修饰键也得有别名表，否则 ctrl 这个规范名找不到来源。"""
    for modifier in _CASES["modifiers"]:
        assert modifier in _CASES["table"], f"{modifier} 缺少别名表"


# ── 归一化 ────────────────────────────────────────────────
@pytest.mark.parametrize("case", _CASES["combos"], ids=lambda c: repr(c["in"]))
def test_combos_normalize(case: dict):
    combo, reason = normalize_combo(case["in"])

    assert reason == "", f"{case['in']!r} 本应被接受，却报了：{reason}"
    assert combo == case["out"]


@pytest.mark.parametrize("case", _CASES["combos_errors"], ids=lambda c: repr(c["in"]))
def test_bad_combos_are_rejected_with_a_reason(case: dict):
    combo, reason = normalize_combo(case["in"])

    assert combo == [], "认不出来就不该给出一串半成品按键"
    assert case["reason_contains"] in reason
