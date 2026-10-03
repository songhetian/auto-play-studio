"""规则的严重级、执行顺序，以及每条问题给用户看的那句话。

**顺序即契约。** 体检把「第 5 行重复」报出来，整理就必须删第 5 行；
体检说「第 7 行主键重复」，整理就不能顺手把第 5 行也算进来。
所以顺序只在这里写一次，体检与整理都从这里取。

    header_whitespace → blank_header → duplicate_header → leading_blank_rows
                      → blank_row → key_whitespace → blank_key → duplicate_row
                      → duplicate_key → unparsable_value

前三条是表头自身的毛病，排在最前：列名没定下来，后面按列名跑的一切都没意义。
`leading_blank_rows` / `blank_row` 必须在主键相关规则之前：不先去掉空白行，
它们会以「主键为空」的身份再报一次，用户在原表里找不到对应行。
`key_whitespace` 必须在后三条之前：不先去掉两端空白，「   」不算空、
「 123 」和「123」也不算同一个键。
`unparsable_value` 排在最后：它只看值本身能不能被模板层解析，
与被删掉哪一行无关，所以对**全部**数据行生效。
"""
from __future__ import annotations

#: 只报不改 —— 靠程序猜不出用户想要哪个值，猜错比不猜更坏
REPORT_ONLY = "info"
#: 去掉它不会改变数据含义，整理时自动应用
AUTO_FIX = "fix"
#: 改动有业务代价（同一条工单做两遍 = 重复退款），默认不应用，要用户显式勾选
NEEDS_CONSENT = "risk"

SEVERITY: dict[str, str] = {
    "header_whitespace": AUTO_FIX,
    #: 默认按「整列为空就删掉」处理；下面有数据时由 `blank_header_severity` 降级成只报
    "blank_header": AUTO_FIX,
    "duplicate_header": REPORT_ONLY,
    "leading_blank_rows": AUTO_FIX,
    "blank_row": AUTO_FIX,
    "key_whitespace": AUTO_FIX,
    "blank_key": AUTO_FIX,
    "duplicate_row": AUTO_FIX,
    "duplicate_key": NEEDS_CONSENT,
    "unparsable_value": REPORT_ONLY,
}

EXECUTION_ORDER: tuple[str, ...] = (
    "header_whitespace",
    "blank_header",
    "duplicate_header",
    "leading_blank_rows",
    "blank_row",
    "key_whitespace",
    "blank_key",
    "duplicate_row",
    "duplicate_key",
    "unparsable_value",
)


def severity(kind: str) -> str:
    """未知 kind 直接 KeyError —— 拼错名字时静默按「只报不改」处理，问题会被吞掉。"""
    return SEVERITY[kind]


def blank_header_severity(column_is_empty: bool) -> str:
    """没有列名的那一列，整列都没内容 → 删掉它；下面有数据 → 只报。

    只报的那半是真话：列名是用户起的名，工具编不出正确的名字，
    编一个「未命名1」等于让用户对着一个不存在的列名去写模板。
    """
    return AUTO_FIX if column_is_empty else REPORT_ONLY


# ── 给别人看的一句话 ──────────────────────────────────────────────────
# 每条都要说清「哪里、什么毛病、代价是什么」。只说 kind 等于没说：
# 客服看到「duplicate_key」不知道要干嘛，看到「主键「A002」在第 3 行已经出现过」才知道去核对。


def header_whitespace_detail(columns: list[str]) -> str:
    names = "、".join(f"「{c}」" for c in columns)
    return f"列名 {names} 两端有多余空白，按列名取值的指令会认不出这一列"


def blank_header_detail(column: int, column_is_empty: bool) -> str:
    if column_is_empty:
        return f"第 {column} 列没有列名，整列也没有任何内容，整理时会被删掉"
    return f"第 {column} 列没有列名，按列名取值的指令拿不到这一列的内容"


def duplicate_header_detail(column: int, first_column: int, name: str) -> str:
    return f"第 {column} 列与第 {first_column} 列都叫「{name}」，按列名取只会取到第 {first_column} 列"


def leading_blank_rows_detail(count: int) -> str:
    return f"表头之前有 {count} 行空白，按第 1 行读表头会得到空列名"


def blank_row_detail() -> str:
    return "整行没有任何内容，会被当成一行没有数据的行跑掉"


def key_whitespace_detail(raw: str, cleaned: str) -> str:
    return f"主键「{raw}」两端有多余空白，去掉之后与「{cleaned}」是同一个键"


def blank_key_detail(column: str) -> str:
    return f"主键列「{column}」是空的，这一行没有可以用来核对的编号"


def duplicate_row_detail(first_row: int) -> str:
    return f"这一行与第 {first_row} 行逐格相同，是同一份数据被导了两遍"


def duplicate_key_detail(key: str, first_row: int) -> str:
    return f"主键「{key}」在第 {first_row} 行已经出现过，两行都执行等于做两遍"


def unparsable_value_detail(what: str, rows: tuple[int, ...], sample: str) -> str:
    """`what` 是「日期」或「金额」—— 文案里照原样用，所以两个名字都读得通。

    举一个例子就够：`rows` 里已经把所有行号都给出来了，把几十行都抄进一句话
    只会让这句话没法看。
    """
    tail = f"（这一列还有 {len(rows) - 1} 处一样的问题）" if len(rows) > 1 else ""
    return f"这一列看着是{what}，但第 {rows[0]} 行的「{sample}」不是{what}，按{what}格式化会让这一行整行失败{tail}"
