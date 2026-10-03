"""模板渲染：把 `{列名}` / `{列名|格式化器}` 换成当前行的值。

设计要点
--------
* **取不到就抛 `TemplateError`**，绝不把占位符原样透传 —— 继续执行会把
  `{客户名}` 这种字面量直接发给客户，那是真实事故。格式化器同理：`money`
  拿到「待定」要报错，静默输出等于把脏数据拼进给客户的话里。
* 纯函数、零 IO。解析只做一次（`_lookup`），渲染与「列出引用了哪些列」
  （`template_refs`）共用它，所以两者不可能对「什么是合法占位符」有分歧。
* 前端 `src/lib/template.ts` 是同一份语义的第二实现，两侧跑同一组黄金用例
  （`tests/fixtures/template_cases.json`）。

格式化器约定
------------
签名统一 `fn(value, arg) -> str`，`arg` 是 `:` 后面那一段（没写就是空串）。
**空值不统一拦截，由格式化器自己决定** —— 空不是错，`money` 对空值返回空串；
而 `default:x` 的存在意义就是接管空值，统一拦在前面会把它挡掉。
"""
from __future__ import annotations

import datetime as _dt
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Callable

#: {任意内容}，中文列名也能匹配
_PLACEHOLDER = re.compile(r"\{([^{}]*)\}")

#: 金额清洗：逗号、各种空白、半角 ¥(U+00A5)、全角 ￥(U+FFE5)
_AMOUNT_NOISE = re.compile(r"[,\s\u00a5\uffe5]")

#: 取不到值的哨兵。不能用 None —— None 是 Excel 空单元格的合法值。
_MISSING = object()

#: 人民币大写用字
_CN_DIGIT = "零壹贰叁肆伍陆柒捌玖"
_CN_UNIT = ("", "拾", "佰", "仟")
_CN_GROUP = ("", "万", "亿", "万亿")


class TemplateError(Exception):
    """模板渲染不出来，附带给人看的原因。"""


# ── 格式化器 ──────────────────────────────────────────────
def _amount_cents(value: Any, formatter: str) -> int | None:
    """单元格金额 -> 「分」的整数。空值返回 None，脏数据抛错。

    `money` 与 `rmb` 都从这里出发，所以两者对「什么算金额、怎么进位」不可能有分歧。
    先落 Decimal 再 ROUND_HALF_UP、不走 float：金额上一个二进制舍入误差就是真的对不上账。
    """
    text = "" if value is None else str(value)
    cleaned = _AMOUNT_NOISE.sub("", text)
    if not cleaned:
        return None  # 空不是错，只是没有金额

    try:
        amount = Decimal(cleaned)
    except InvalidOperation as exc:
        raise TemplateError(f"格式化器 {formatter} 处理不了「{text}」，它需要一个金额") from exc

    if not amount.is_finite():
        raise TemplateError(f"格式化器 {formatter} 处理不了「{text}」，它需要一个金额")

    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _money(value: Any, arg: str) -> str:
    """千分位 + 两位小数，能吃掉 `1,234.56` / `¥99` 这类脏输入。"""
    cents = _amount_cents(value, "money")
    if cents is None:
        return ""

    sign = "-" if cents < 0 else ""  # -0 也要归零，否则会输出「-0.00」
    cents = abs(cents)
    return f"{sign}{cents // 100:,}.{cents % 100:02d}"


def _four(n: int) -> str:
    """一个 4 位组（0-9999）的大写，组内连续的零合并成一个「零」。"""
    digits = f"{n:04d}"
    out = ""
    pending_zero = False

    for i, ch in enumerate(digits):
        d = int(ch)
        if d == 0:
            # 组尾的零不读（壹仟 而不是 壹仟零）；组中的零留到下一个非零数字前补
            pending_zero = pending_zero or bool(out)
            continue
        if pending_zero:
            out += _CN_DIGIT[0]
            pending_zero = False
        out += _CN_DIGIT[d] + _CN_UNIT[3 - i]

    return out


def _rmb_integer(n: int) -> str:
    """整数部分按 4 位一组进位。0 返回空串，由调用方补「零元整」。"""
    if n == 0:
        return ""

    groups: list[int] = []
    while n > 0:
        groups.append(n % 10000)
        n //= 10000

    out = ""
    need_zero = False
    for i in range(len(groups) - 1, -1, -1):
        g = groups[i]
        if g == 0:
            need_zero = need_zero or bool(out)
            continue
        if need_zero:
            out += _CN_DIGIT[0]
            need_zero = False
        out += _four(g) + _CN_GROUP[i]
        # 低一组不足千位时必须补零：壹万零壹，而不是 壹万壹
        if i > 0 and 0 < groups[i - 1] < 1000:
            need_zero = True

    return out


def _rmb(value: Any, arg: str) -> str:
    """人民币大写。

    分组进位是这块最容易写错的地方：第一版把 `10000` 输出成「壹零万元」，
    因为「零」是在错误的层级上插入的。所以 `_four` / `_rmb_integer` 分成两层，
    各自显式管理「待补零」标志 —— 这类函数靠肉眼看不出来，只能拿边界值打表。
    """
    amount = _amount_cents(value, "rmb")
    if amount is None:
        return ""

    negative = amount < 0
    cents = abs(amount)

    jiao = cents // 10 % 10
    fen = cents % 10
    integer = _rmb_integer(cents // 100)

    if jiao == 0 and fen == 0:
        body = (integer or _CN_DIGIT[0]) + "元整"
    else:
        body = integer + "元" if integer else ""
        if jiao:
            body += _CN_DIGIT[jiao] + "角"
        elif fen and integer:
            # 有元有分、中间没有角：壹佰元零伍分
            body += _CN_DIGIT[0]
        if fen:
            body += _CN_DIGIT[fen] + "分"

    return ("负" if negative else "") + body


#: mask 支持的脱敏类型
_MASK_KINDS = ("id", "phone", "name")


def _guess_mask_kind(text: str) -> str:
    """认不出类型时按姓名处理 —— 宁可多打几个星号，也别把身份证原样发出去。"""
    if text.isdigit() and len(text) in (15, 18):
        return "id"  # 15 位是老身份证
    if text.isdigit() and len(text) == 11:
        return "phone"
    return "name"


def _mask(value: Any, arg: str) -> str:
    """手机号 / 身份证 / 姓名自动识别脱敏，也可 `mask:phone` 强制指定类型。

    强制指定时不猜，但仍保留首尾可读 —— 客服要能跟客户核对后四位。
    """
    text = str(value).strip()
    if not text:
        return ""

    kind = arg or _guess_mask_kind(text)
    if kind not in _MASK_KINDS:
        raise TemplateError(f"格式化器 mask 不认识「{kind}」，可用：id / phone / name")

    if kind == "id" and len(text) >= 8:
        return text[:4] + "*" * (len(text) - 8) + text[-4:]
    if kind == "phone" and len(text) >= 7:
        return text[:3] + "*" * (len(text) - 7) + text[-4:]

    # 姓名，以及位数不够、按 id/phone 脱不出东西的情况：只留首尾
    if len(text) <= 1:
        return text
    if len(text) == 2:
        return text[0] + "*"
    return text[0] + "*" * (len(text) - 2) + text[-1]


def _width_arg(arg: str, formatter: str) -> int:
    """`cut` / `pad` 的位数参数。写错就报错 —— 当成 0 位处理会把内容整段抹掉。"""
    try:
        width = int(arg)
    except ValueError as exc:
        raise TemplateError(
            f"格式化器 {formatter} 需要一个位数（例如 {formatter}:8），收到「{arg}」"
        ) from exc
    if width < 0:
        raise TemplateError(f"格式化器 {formatter} 的位数不能是负数，收到「{arg}」")
    return width


def _cut(value: Any, arg: str) -> str:
    """按长度截断，**只有真的截断了才加省略号**。"""
    text = str(value)
    width = _width_arg(arg, "cut")
    return text if len(text) <= width else text[:width] + "…"


def _pad(value: Any, arg: str) -> str:
    """左补零到 n 位。空值不补 —— 补出 `0000` 会真的发到客户那边去。"""
    # 位数先校验：空值也不该放过写错的参数，否则保存时的 dry-run 会漏掉它
    width = _width_arg(arg, "pad")
    text = str(value)
    return text.rjust(width, "0") if text else ""


def _upper(value: Any, arg: str) -> str:
    return str(value).upper()


def _lower(value: Any, arg: str) -> str:
    return str(value).lower()


def _trim(value: Any, arg: str) -> str:
    return str(value).strip()


def _default(value: Any, arg: str) -> str:
    """空值兜底。**纯空白也算空** —— 发出去在客户那边就是一片空白。"""
    text = str(value)
    return arg if not text.strip() else text


#: 接受的日期输入格式，**长的排前面**（否则 `%Y-%m-%d` 会先吃掉带时分秒的串）
_DATE_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y/%m/%d",
    "%Y年%m月%d日 %H:%M:%S",
    "%Y年%m月%d日 %H:%M",
    "%Y年%m月%d日",
    "%Y-%m-%dT%H:%M:%S",
)

#: ISO 串里的毫秒：`...T13:20:00.123Z` 先剥掉小数位再按上面的清单解析
_ISO_FRACTION = re.compile(r"(T\d{2}:\d{2}:\d{2})\.\d+")

#: 输出用的占位符。注意 `MM` 是月、`mm` 是分，靠大小写区分。
_DATE_TOKENS = re.compile(r"YYYY|MM|DD|HH|mm|ss")


def _to_datetime(value: Any) -> _dt.datetime | None:
    """把单元格里的时间变成 datetime；空值返回 None，认不出来抛错。

    Excel 的日期单元格经 openpyxl 出来本来就是 datetime，不走字符串解析。
    字符串只认固定的那一小撮格式 —— **不接受 `02/10/2026` 这种有歧义的写法**，
    猜错的日期会直接变成客户投诉，不如让它整行失败。
    """
    if isinstance(value, _dt.datetime):
        return value
    if isinstance(value, _dt.date):  # datetime 是 date 的子类，所以这句必须排在上面
        return _dt.datetime(value.year, value.month, value.day)

    text = str(value).strip()
    if not text:
        return None

    text = _ISO_FRACTION.sub(r"\1", text).removesuffix("Z")
    for fmt in _DATE_FORMATS:
        try:
            return _dt.datetime.strptime(text, fmt)
        except ValueError:
            continue

    raise TemplateError(f"格式化器 date 认不出「{value}」，它需要一个日期")


def _date(value: Any, arg: str) -> str:
    """按 `YYYY MM DD HH mm ss` 任意组合输出。不做时区换算，原样读。"""
    if not arg:
        raise TemplateError("格式化器 date 需要一个格式，例如 date:YYYY-MM-DD")

    moment = _to_datetime(value)
    if moment is None:
        return ""

    parts = {
        "YYYY": f"{moment.year:04d}",
        "MM": f"{moment.month:02d}",
        "DD": f"{moment.day:02d}",
        "HH": f"{moment.hour:02d}",
        "mm": f"{moment.minute:02d}",
        "ss": f"{moment.second:02d}",
    }
    return _DATE_TOKENS.sub(lambda m: parts[m.group(0)], arg)


def is_amount(value: Any) -> bool:
    """这一格能不能当金额用 —— 与 `money` / `rmb` 走同一套 `_amount_cents`。

    空值算「能」：空不是错，`money` 对空值返回空串，本来就不会失败。
    判定不另起一套「看起来像不像金额」的猜测 —— 猜测与真实渲染对不上时，
    体检说没问题、跑起来整行失败，比没有体检更坏。
    """
    try:
        _amount_cents(value, "money")
    except TemplateError:
        return False
    return True


def is_date(value: Any) -> bool:
    """这一格能不能当日期用 —— 与 `date` 走同一套 `_to_datetime`（含它刻意拒收的歧义写法）。"""
    try:
        _to_datetime(value)
    except TemplateError:
        return False
    return True


#: 格式化器注册表：名字 -> (值, 参数) -> 文本
_FORMATTERS: dict[str, Callable[[Any, str], str]] = {
    "money": _money,
    "rmb": _rmb,
    "mask": _mask,
    "cut": _cut,
    "pad": _pad,
    "upper": _upper,
    "lower": _lower,
    "trim": _trim,
    "default": _default,
    "date": _date,
}

#: 内置占位符 -> row 里的字段名。不要求出现在 values 里。
_BUILTIN = {"行号": "row_no", "主键": "key"}


# ── 解析 ──────────────────────────────────────────────
def _lookup(raw: str, values: dict[str, Any]) -> tuple[Any, str | None]:
    """把占位符原文解析成 (值, 格式化器规格)。取不到值返回 `_MISSING`。

    规格为 None 表示「不套格式化器」。

    兼容退路：先按竖线左边当列名查，查不到再拿整串原文查一次 ——
    于是「列名里真的带竖线」的老配置不会因为新语法而失效。
    """
    key, sep, spec = raw.partition("|")
    if not sep:
        return (values[raw], None) if raw in values else (_MISSING, None)

    key = key.strip()
    if key in values:
        return values[key], spec.strip()
    if raw in values:  # 这压根不是格式化器，是一个含竖线的列名
        return values[raw], None
    return _MISSING, None


def _format(value: Any, spec: str | None, raw: str) -> str:
    """套用格式化器。名字不认识就报错，绝不静默降级成原样输出。"""
    if spec is None:
        return "" if value is None else str(value)

    # None 与 `{列名}` 口径一致，视作空串。**空串仍然会进格式化器** ——
    # `default:x` 的存在意义就是接管空值；也只有这样 `mask` 不会把 None 变成「N***e」。
    if value is None:
        value = ""

    name, _, arg = spec.partition(":")
    name = name.strip()
    formatter = _FORMATTERS.get(name)
    if formatter is None:
        raise TemplateError(f"未知的格式化器「{name}」，占位符 {{{raw}}} 无法替换")

    return formatter(value, arg.strip())


def _render_one(raw: str, row: dict) -> str:
    """渲染一个占位符。**解析的唯一出口** ——

    `render_template` 和 `template_issues` 都走这里，所以「跑起来会失败」与
    「保存时说会失败」不可能对不上：报错文案就是同一句话。
    """
    values: dict[str, Any] = row.get("values") or {}

    value, spec = _lookup(raw, values)
    if value is not _MISSING:
        return _format(value, spec, raw)

    field = _BUILTIN.get(raw)
    if field is not None:
        return str(row.get(field, ""))

    key = raw.partition("|")[0].strip() if "|" in raw else raw
    raise TemplateError(f"当前行没有「{key}」这一列，占位符 {{{raw}}} 无法替换")


def render_template(text: str, row: dict) -> str:
    """把 `{列名}` / `{列名|格式化器}` 换成当前行的值。

    取不到就抛 TemplateError —— 与其把占位符原样发出去，不如让这一行失败。
    """
    return _PLACEHOLDER.sub(lambda m: _render_one(m.group(1).strip(), row), text)


def template_issues(text: str, columns: list[str]) -> list[str]:
    """保存时就查出这条模板的所有问题。没问题返回空列表。

    做法是拿「所有列都在、值都为空」的一行 dry-run 一遍 —— 于是它复用渲染那条路，
    不需要第二套解析器，也不会和运行时给出不同的判断。
    逐条占位符收集而不是遇到第一个就停：一次把话说完，用户才不用改一个跑一次。

    ⚠️ 前提是格式化器的**参数校验与值无关**（`pad` 就是为此把位数校验提到了前面），
    否则 `{订单号|pad:abc}` 会因为「值是空的」而被放过。
    """
    row = {"values": dict.fromkeys(columns, "")}
    issues: list[str] = []

    for m in _PLACEHOLDER.finditer(text):
        try:
            _render_one(m.group(1).strip(), row)
        except TemplateError as exc:
            issues.append(str(exc))

    return issues
