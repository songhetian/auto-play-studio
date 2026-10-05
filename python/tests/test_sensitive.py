# -*- coding: utf-8 -*-
"""敏感词匹配的策略规格。

对应 WordGuard（desk/）的能力：中文关键词 + 拼音首字母 + 严重级别 + 告警。
这里只验**策略层**（匹配 / 降级 / 摘要）；真正的窗口抓取是设备层，人工验收。
"""
from __future__ import annotations

from engine.sensitive import (
    WordRule,
    match_words,
    pick_capture_mode,
    should_alert,
    summarize,
)


# ── 降级阶梯：京麦这类自绘客户端走不通 UIA ─────────────────────

def test_能读UIA时优先用UIA_最准且只读输入框():
    d = pick_capture_mode(supports_uia=True, clipboard_readable=True)
    assert d.mode == "uia"


def test_UIA读不到时降级剪贴板_这是京麦的情况():
    """京麦是 Chromium 自绘，不暴露标准 UIA 焦点元素。"""
    d = pick_capture_mode(supports_uia=False, clipboard_readable=True)
    assert d.mode == "clipboard"
    assert "剪贴板" in d.hint, "降级了要告诉用户会读剪贴板"


def test_用户不允许读剪贴板时不给降级_读剪贴板是敏感操作():
    d = pick_capture_mode(supports_uia=False, clipboard_readable=True, user_opt_in_clipboard=False)
    assert d.mode == "none"
    assert d.hint


def test_连剪贴板都读不到就放弃_但要给替代方案():
    d = pick_capture_mode(supports_uia=False, clipboard_readable=False)
    assert d.mode == "none"


# ── 匹配：中文关键词 ────────────────────────────────────────

def test_命中违禁词():
    rules = [WordRule(word="最便宜", level="high")]
    hits = match_words("这款是最便宜的了", rules)
    assert len(hits) == 1
    assert hits[0].word == "最便宜"
    assert hits[0].start == 3


def test_没命中就返回空():
    assert match_words("正常的一句话", [WordRule(word="违禁词")]) == []


def test_多处命中都要找出来():
    rules = [WordRule(word="退款")]
    hits = match_words("要退款，另外这个也要退款", rules)
    assert len(hits) == 2


def test_长的词优先_不要把同一处报成两次():
    """"退款政策"含"退款"，只报最长的那个 —— 否则一次问题弹两条，像重复报警。"""
    rules = [WordRule(word="退款"), WordRule(word="退款政策")]
    hits = match_words("详情见退款政策第三条", rules)
    assert [h.word for h in hits] == ["退款政策"]


def test_英文不区分大小写():
    rules = [WordRule(word="vip", level="high")]
    assert match_words("这是VIP待遇", rules)


def test_禁用的词不参与匹配():
    rules = [WordRule(word="退款", enabled=False)]
    assert match_words("我要退款", rules) == []


def test_空文本不报错():
    assert match_words("", [WordRule(word="x")]) == []


def test_空白规则不参与匹配():
    assert match_words("随便什么", [WordRule(word="   ")]) == []


# ── 匹配：拼音首字母（客服只记得缩写）────────────────────────

def test_拼音首字母能命中_tkzc对应退款政策():
    rules = [WordRule(word="退款政策", match_key="tkzc")]
    hits = match_words("tkzc", rules)
    assert len(hits) == 1
    assert hits[0].word == "退款政策"


def test_拼音字母之间可以有空格和横线():
    """客服实际会打成 "tk zc"、"tk-zc"，精确匹配会漏掉大部分。"""
    rules = [WordRule(word="退款政策", match_key="tkzc")]
    for text in ("tk zc", "tk-zc", "tkzc", "TKZC"):
        assert match_words(text, rules), text


def test_拼音太短不匹配_两个字母会误报满屏():
    rules = [WordRule(word="退款", match_key="tk")]
    assert match_words("tk", rules) == []


# ── 告警与摘要 ─────────────────────────────────────────────

def test_命中就告警():
    from engine.sensitive import MatchHit

    assert should_alert([MatchHit("x", 0, 1, "mid")])


def test_没命中不告警():
    assert should_alert([]) is False


def test_只开高危时_中危不弹窗():
    hits = match_words("我要退款", [WordRule(word="退款", level="mid")])
    assert should_alert(hits, enabled_levels=("high",)) is False
    assert should_alert(hits, enabled_levels=("mid",)) is True


def test_摘要说清等级与命中的词():
    rules = [WordRule(word="最便宜", level="high"), WordRule(word="绝对", level="high")]
    s = summarize(match_words("绝对最便宜", rules))
    assert "高危" in s
    assert "最便宜" in s


def test_摘要不重复列同一个词():
    rules = [WordRule(word="退款")]
    s = summarize(match_words("退款、退款", rules))
    assert s.count("退款") == 1, f"同一词出现多次不该重复列：{s}"


def test_命中很多时摘要要截断():
    rules = [WordRule(word="a"), WordRule(word="b"), WordRule(word="c")]
    s = summarize(match_words("abc", rules), max_items=2)
    assert "等" in s


def test_没命中时摘要是空串():
    assert summarize([]) == ""


def test_从真实对话里挖候选词():
    """客服话里最常见的违规形态是「联系方式」与「导流」。

    这不是关键词匹配的问题（用户没给词），而是"从真实文本里提取候选"的问题：
    手机号、微信号、QQ 号这类**有明确形态**的东西可以正则直接抽出来。
    """
    from engine.sensitive import extract_candidates

    text = "亲，加个微信 abc123456 详聊，有问题找我\n电话 13800138000"
    cands = extract_candidates(text)
    words = {c["kind"]: c["value"] for c in cands}
    assert words["phone"] == "13800138000"
    # 微信号 = 字母开头 + 5~20 位字母数字
    assert words["wechat"] == "abc123456"
    # 每个候选都要说明"凭什么判断"，用户才能决定要不要加进词库
    assert all(c["reason"] for c in cands)


def test_候选词按类型分组便于批量入库():
    from engine.sensitive import extract_candidates

    text = "微信 xyz999 或手机 13912345678"
    kinds = {c["kind"] for c in extract_candidates(text)}
    assert "wechat" in kinds
    assert "phone" in kinds


def test_普通文本不硬凑候选词():
    """宁可少给也不能乱给 —— 一堆没用的候选会逼用户逐条删。"""
    from engine.sensitive import extract_candidates

    assert extract_candidates("您好，很高兴为您服务，请问有什么可以帮您？") == []


# ── 区分大小写：英文缩写（VIP / QQ）不该被无声降级成"永远不命中" ──
# 曾经 hay 被无条件小写化，而区分大小写时 needle 保留原样 ——
# 于是大写词永远找不到、这条规则等于被静默关掉。

def test_区分大小写时大写词只命中大写():
    rules = [WordRule(word="VIP", case_sensitive=True)]
    assert [h.word for h in match_words("尊贵的VIP客户", rules)] == ["VIP"]
    # 大小写不同就是不同的词：小写的 vip 不该被算命中
    assert match_words("尊贵的vip客户", rules) == []


def test_区分大小写时小写词不命中大写():
    rules = [WordRule(word="vip", case_sensitive=True)]
    assert [h.word for h in match_words("尊贵的vip客户", rules)] == ["vip"]
    assert match_words("尊贵的VIP客户", rules) == []


def test_默认仍是不区分大小写():
    """默认行为不能被改坏：词库里的英文词就该不分大小写地命中。"""
    assert match_words("尊贵的vip客户", [WordRule(word="VIP")])
    assert match_words("尊贵的VIP客户", [WordRule(word="vip")])
