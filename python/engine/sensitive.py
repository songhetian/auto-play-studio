# -*- coding: utf-8 -*-
"""敏感词匹配的**策略决策**（纯逻辑，可测）。

为什么单独抽出来：真正的窗口抓取是设备层（UIA / 剪贴板），CI 验不了；
但「拿到一段文本之后该怎么判断、什么时候该放弃、抓不到时怎么办」是纯逻辑，
必须在这里钉死 —— 否则每个平台的实现各写一套降级逻辑，行为会飘。

对应 WordGuard（desk/）里的 UIA 抓取问题：
`UiaWindowProbe` 只认 `AutomationElement.FocusedElement`。京麦/钉钉/飞鸽这类
**Chromium 自绘**客户端不暴露标准 UIA 焦点 → 永远抓不到。
本模块定义降级阶梯，让这些软件也能用上监控。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

#: 降级阶梯：越靠前越可靠
CAPTURE_MODES = ("uia", "clipboard", "none")


@dataclass
class WordRule:
    """一条违禁词规则。

    ``match_key`` 用于拼音首字母匹配（tkzc → 退款政策），与 WordGuard 的
    WordEntry.MatchKey 语义一致 —— 两边都要支持"客服只记得拼音缩写"的情况。
    """

    word: str
    level: str = "mid"  # high / mid / low
    match_key: str = ""
    enabled: bool = True
    #: 忽略大小写（英文缩写常见）
    case_sensitive: bool = False


@dataclass
class MatchHit:
    word: str
    start: int
    end: int
    level: str = "mid"

    @property
    def severity_rank(self) -> int:
        return {"high": 3, "mid": 2, "low": 1}.get(self.level, 0)


@dataclass
class CaptureDecision:
    """一次抓取的降级决策结果。"""

    mode: str
    #: 为什么选这个模式（用于在界面上说清"为什么降级了"）
    reason: str = ""
    #: 建议用户做什么（降级到剪贴板时提示权限）
    hint: str = ""


def pick_capture_mode(
    *,
    supports_uia: bool,
    clipboard_readable: bool,
    user_opt_in_clipboard: bool = True,
) -> CaptureDecision:
    """决定用哪种抓取方式。

    阶梯：能 UIA 就 UIA（最准、只读输入框）→ 不行且允许时降级剪贴板 → 都不行就放弃。

    **剪贴板降级必须显式可选**：读剪贴板是敏感操作（用户会看到剪贴板历史被写入）。
    默认开启会让人不安，所以调用方应当把它暴露成一个可见开关。
    """
    if supports_uia:
        return CaptureDecision(mode="uia", reason="标准 UIA 可读到输入框")
    if user_opt_in_clipboard and clipboard_readable:
        return CaptureDecision(
            mode="clipboard",
            reason="该软件不暴露标准 UIA（自绘控件），已降级为读取剪贴板比对",
            hint="只在客户实际发送内容后才会有记录；首次使用请授权剪贴板访问",
        )
    return CaptureDecision(
        mode="none",
        reason="既读不到 UIA，又未允许读取剪贴板",
        hint="该软件可能是不自绘的老客户端，只能改用「输入框截图」的方式盯屏",
    )


def match_words(text: str, rules: list[WordRule]) -> list[MatchHit]:
    """在文本里找出所有命中的违禁词。

    - 多个词重叠时保留**最长优先**（先匹配 "退款政策" 再匹配 "退款"，
      否则会出现同一段话里报两条，其实是同一个问题）
    - 高危词优先展示（客服要立刻处理的是最严重的）
    """
    if not text:
        return []
    # 原文 + 小写副本：区分大小写的规则在原文里找，其余在小写副本里找。
    # 曾经只留小写副本，于是 case_sensitive=True 的大写词（VIP）永远找不到 ——
    # 这条规则等于被静默关掉，而小写词反而照旧不区分大小写。
    hay = text
    hay_lower = text.lower()
    hits: list[MatchHit] = []
    taken: list[tuple[int, int]] = []

    # 长词先匹配，便于后续短词被"占位"跳过
    ordered = sorted(
        (r for r in rules if r.enabled and r.word.strip()),
        key=lambda r: len(r.word),
        reverse=True,
    )
    for rule in ordered:
        if rule.case_sensitive:
            needle, haystack = rule.word, hay
        else:
            needle, haystack = rule.word.lower(), hay_lower
        if not needle:
            continue
        start = 0
        while True:
            i = haystack.find(needle, start)
            if i < 0:
                break
            j = i + len(needle)
            # 与已命中的区间重叠就跳过
            if not any(not (j <= s or i >= e) for s, e in taken):
                taken.append((i, j))
                hits.append(MatchHit(word=rule.word, start=i, end=j, level=rule.level))
            start = i + 1

    # 拼音首字母：客服只记得缩写时也能命中
    for rule in ordered:
        key = (rule.match_key or "").strip().lower()
        # 少于 3 个字母的拼音键会误报满屏（"tk" 能对上任何两个字母+汉字的组合），
        # 这是"太短不参与"的原因 —— 而不是在下面靠正则碰运气
        if len(key) < 3:
            continue
        pattern = _pinyin_pattern(key)
        # 拼音键已统一小写，文本也用小写副本，保证缩写大小写混打也命中
        for m in re.finditer(pattern, hay_lower):
            i, j = m.start(), m.end()
            if any(not (j <= s or i >= e) for s, e in taken):
                continue
            taken.append((i, j))
            hits.append(MatchHit(word=rule.word, start=i, end=j, level=rule.level))

    hits.sort(key=lambda h: (-h.severity_rank, h.start))
    return hits


def _pinyin_pattern(key: str) -> re.Pattern:
    """把拼音首字母键编译成正则。

    每个字母之间允许出现任意非中文字符 —— 客服实际打的是 "tk zc"、"tkzc"、
    甚至 "tk-zc"，要求逐字精确匹配会漏掉大部分。
    """
    parts = [re.escape(c) for c in key]
    if len(parts) <= 1:
        return re.compile(re.escape(key))
    # 字母之间允许 0~3 个"分隔/中文字符"：客服实际会打成 "tk zc"、"tk-zc"、"tkzc"
    gap = r"[\s\-_、,.，]*[\u4e00-\u9fa5a-z0-9]{0,3}?"
    return re.compile(gap.join(parts))


def should_alert(
    hits: list[MatchHit],
    *,
    enabled_levels: tuple[str, ...] = ("high", "mid", "low"),
) -> bool:
    """是否需要弹窗告警。"""
    return any(h.level in enabled_levels for h in hits)


def summarize(hits: list[MatchHit], max_items: int = 5) -> str:
    """给弹窗/日志用的一句话摘要。"""
    if not hits:
        return ""
    levels = {h.level for h in hits}
    top = "高危" if "high" in levels else ("中危" if "mid" in levels else "低危")
    names = []
    for h in hits[:max_items]:
        if h.word not in names:
            names.append(h.word)
    more = f" 等 {len(hits)} 处" if len(hits) > max_items else ""
    return f"{top}：命中 {'、'.join(names)}{more}"


#: 候选词的形态规则。
#:
#: 只收「**有明确形态**」的东西（联系方式类）—— 它们是客服违规里最高频、
#: 且不靠关键词库就必然漏的那一类。用户不需要预先知道要禁什么，
#: 工具替他找出来，他只负责决定要不要加进词库。
CANDIDATE_PATTERNS: tuple[tuple[str, "re.Pattern[str]", str], ...] = (
    (
        "phone",
        # 中国大陆手机号：1 开头、第二位 3-9、共 11 位
        re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
        "11 位手机号——最常见的私下联系渠道",
    ),
    (
        "wechat",
        # 微信号：以字母开头，5~20 位字母数字。前面允许"微信/vx/威信"这类引导词
        re.compile(r"(?:微信|vx|VX|威信|v信)\s*[:：]?\s*([A-Za-z][A-Za-z0-9_-]{4,19})", re.IGNORECASE),
        "疑似微信号（前面有引导词，且以字母开头）",
    ),
    (
        "qq",
        re.compile(r"(?:qq|QQ|扣扣)\s*[:：]?\s*(\d{5,12})", re.IGNORECASE),
        "疑似 QQ 号",
    ),
    (
        "url",
        re.compile(r"https?://[^\s，。！？、）)]{4,}"),
        "外部链接——引导客户离开平台",
    ),
)


def extract_candidates(text: str) -> list[dict]:
    """从一段真实对话里提取**候选违禁词**，供用户勾选入库。

    为什么需要它：词库靠用户自己想是补不齐的 —— 客服真正会打出来的
    「加个微信 abc123」这类话，没人会在建词库时想到逐条写。
    这里只认形态明确的联系方式类，不做语义猜测：

    - 宁可少给：普通客服用语里凑出来的"候选"会让用户逐条删，比不给更劝退
    - 每个候选都带 `reason`：用户要能一眼判断凭什么被提出来
    """
    if not text:
        return []

    out: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for kind, pattern, reason in CANDIDATE_PATTERNS:
        for m in pattern.finditer(text):
            # 微信/QQ 这类有捕获组，取组 1（真正的号码）；没有组的取整段
            value = (m.group(1) if m.groups() else m.group(0)).strip()
            if not value or (kind, value.lower()) in seen:
                continue
            seen.add((kind, value.lower()))
            out.append({"kind": kind, "value": value, "reason": reason})

    return out
