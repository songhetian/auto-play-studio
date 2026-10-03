"""Excel 体检/整理的夹具：按**显式行号**写格子，行号常量就是表的布局。

为什么不复用 `conftest.xlsx_factory`：那个夹具把第一行当表头、后面顺序追加，
写不出「表头之上还有空行」「数据区中间夹一个没被碰过的空行」这两种样子 ——
而它们正是体检要处理的对象。

行号用命名常量而不是「第几个元素」：测试断言里出现的是 `M_DUP_OF_1`，
不是 `4`，改表时不会静默错位。
"""
from __future__ import annotations

from datetime import date

from openpyxl import Workbook

# ── 脏表 MESSY：表头在第 1 行，数据区一列毛病都占一点 ──────────────────
#
#   1  订单编号 | 客户名称␠ | 处理备注      ← 「客户名称」带尾空格
#   2  A001     | 张三      | 已联系
#   3  A002     | 李四      | 已联系
#   4  （整行为空，从来没被写过）
#   5  A001     | 张三      | 已联系         ← 与第 2 行完全相同
#   6  A003     | 王五      | 待回访
#   7  A002     | 李四      | 改过的         ← 主键与第 3 行重复，内容不同
#   8  （空）   | 赵六      | 已联系         ← 主键为空
#   9  A004     | 钱七      | 待回访
#  10  ␠A005␠   | 孙八      | 已联系         ← 主键带首尾空格

M_HEADER = 1
M_OK_FIRST = 2
M_OK_SECOND = 3
M_BLANK_ROW = 4
M_SAME_AS_FIRST = 5
M_OK_THIRD = 6
M_KEY_REPEATS_SECOND = 7
M_NO_KEY = 8
M_OK_FOURTH = 9
M_SPACEY_KEY = 10

MESSY_HEADERS: dict[int, str] = {1: "订单编号", 2: "客户名称 ", 3: "处理备注"}
MESSY_ROWS: dict[int, list] = {
    M_OK_FIRST: ["A001", "张三", "已联系"],
    M_OK_SECOND: ["A002", "李四", "已联系"],
    M_SAME_AS_FIRST: ["A001", "张三", "已联系"],
    M_OK_THIRD: ["A003", "王五", "待回访"],
    M_KEY_REPEATS_SECOND: ["A002", "李四", "改过的"],
    M_NO_KEY: [None, "赵六", "已联系"],
    M_OK_FOURTH: ["A004", "钱七", "待回访"],
    M_SPACEY_KEY: ["  A005  ", "孙八", "已联系"],
}
MESSY_KEY_COL = "订单编号"
#: 表头之后的行数（含空行）—— 与 `excel.count_rows` 口径一致，用于验证「99 行里只有 5 行有内容」
MESSY_DATA_ROWS = M_SPACEY_KEY - M_HEADER

# ── 干净表 CLEAN：一行问题都没有 ──────────────────────────────────────
#
#   1  订单编号 | 客户名称 | 处理备注
#   2  B001     | 周九     | 已联系
#   3  B002     | 吴十     | 待回访

C_HEADER = 1
C_OK_FIRST = 2
C_OK_SECOND = 3

CLEAN_HEADERS: dict[int, str] = {1: "订单编号", 2: "客户名称", 3: "处理备注"}
CLEAN_ROWS: dict[int, list] = {
    C_OK_FIRST: ["B001", "周九", "已联系"],
    C_OK_SECOND: ["B002", "吴十", "待回访"],
}
CLEAN_KEY_COL = "订单编号"

# ── 表头不到位 OFFSET：前两行是导出时留下的空行，表头落在第 3 行 ────────
#
#   1  （空）
#   2  （空）
#   3  订单编号 | 客户名称 | 处理备注
#   4  D001     | 郑一     | 已联系

O_HEADER = 3
O_OK_FIRST = 4

OFFSET_HEADERS = ["订单编号", "客户名称", "处理备注"]
OFFSET_ROWS: dict[int, list] = {O_OK_FIRST: ["D001", "郑一", "已联系"]}
OFFSET_KEY_COL = "订单编号"

# ── 重复主键 DK：只有去空白之后才看得出来是同一个键 ─────────────────────
#
#   1  订单编号 | 客户名称
#   2  B001     | 周九
#   3  ␠B001␠   | 吴十          ← 整行内容不同（不是完全重复行），但键相同

DK_HEADER = 1
DK_FIRST = 2
DK_SPACEY_SAME_KEY = 3

DK_HEADERS = ["订单编号", "客户名称"]
DK_ROWS: dict[int, list] = {
    DK_FIRST: ["B001", "周九"],
    DK_SPACEY_SAME_KEY: ["  B001  ", "吴十"],
}
DK_KEY_COL = "订单编号"

# ── 空列名 BH：第 2 列没有列名，整列也没有内容（导出时留下的占位列） ────
#
#   1  订单编号 |          | 处理备注
#   2  F001     |          | 已联系
#   3  F002     |          | 待回访
#
# 第 2 列从头到尾一个字都没写过 —— 所以 dimension 仍是 A1:C3。

BH_HEADER = 1
BH_EMPTY_COL = 2
BH_OK_FIRST = 2
BH_OK_SECOND = 3

BH_HEADERS: dict[int, str] = {1: "订单编号", 3: "处理备注"}
BH_ROWS: dict[int, list] = {
    BH_OK_FIRST: ["F001", None, "已联系"],
    BH_OK_SECOND: ["F002", None, "待回访"],
}

# ── 空列名但下面有数据 BHD：不能替用户决定要不要这一列 ─────────────────
#
#   1  订单编号 |          | 处理备注
#   2  G001     | 备注在这  | 已联系

BHD_HEADER = 1
BHD_EMPTY_COL = 2
BHD_OK_FIRST = 2

BHD_HEADERS: dict[int, str] = {1: "订单编号", 3: "处理备注"}
BHD_ROWS: dict[int, list] = {
    BHD_OK_FIRST: ["G001", "客服手写的备注", "已联系"],
}

# ── 列名重复 DH：第 3 列与第 2 列去掉尾部空白后同名 ─────────────────────
#
#   1  订单编号 | 客户名称 | 客户名称␠

DH_HEADER = 1
DH_FIRST_COL = 2
DH_DUPLICATE_COL = 3
DH_OK_FIRST = 2

DH_HEADERS: dict[int, str] = {1: "订单编号", 2: "客户名称", 3: "客户名称 "}
DH_ROWS: dict[int, list] = {
    DH_OK_FIRST: ["H001", "张三", "张三（备用）"],
}

# ── 坏日期 BD：第 2 列确实是日期列，只有最后一格认不出来 ────────────────
#
#   1  订单编号 | 下单日期
#   2  I001     | 2026-10-01   ← 真日期单元格，openpyxl 出来就是 datetime
#   3  I002     | 2026-10-02
#   4  I003     | 2026/10/03
#   5  I004     | 待定          ← 认不出来，跑起来会整行失败

BD_HEADER = 1
BD_REAL_DATE = 2
BD_OK_SECOND = 3
BD_OK_THIRD = 4
BD_BAD_DATE = 5

BD_HEADERS: dict[int, str] = {1: "订单编号", 2: "下单日期"}
BD_ROWS: dict[int, list] = {
    BD_REAL_DATE: ["I001", date(2026, 10, 1)],
    BD_OK_SECOND: ["I002", "2026-10-02"],
    BD_OK_THIRD: ["I003", "2026/10/03"],
    BD_BAD_DATE: ["I004", "待定"],
}

# ── 备注列里偶然出现一个日期串 RM：不能被当成日期列 ─────────────────────
#
#   1  订单编号 | 处理备注
#   2  J001     | 已联系
#   3  J002     | 已回访
#   4  J003     | 2026-10-02   ← 只有这一格像日期
#   5  J004     | 待回访

RM_HEADER = 1
RM_WITH_DATE = 4

RM_HEADERS: dict[int, str] = {1: "订单编号", 2: "处理备注"}
RM_ROWS: dict[int, list] = {
    2: ["J001", "已联系"],
    3: ["J002", "已回访"],
    RM_WITH_DATE: ["J003", "2026-10-02"],
    5: ["J004", "待回访"],
}

# ── 两格的小列 SC：样本太少，不足以下「这是日期列」的结论 ───────────────
#
#   1  订单编号 | 下单日期
#   2  K001     | 2026-10-01
#   3  K002     | 待定

SC_HEADER = 1
SC_BAD = 3

SC_HEADERS: dict[int, str] = {1: "订单编号", 2: "下单日期"}
SC_ROWS: dict[int, list] = {
    2: ["K001", "2026-10-01"],
    SC_BAD: ["K002", "待定"],
}

# ── 坏金额 AM：前两格带千分位/货币符号也能解析，第三格不能 ──────────────
#
#   1  订单编号 | 退款金额
#   2  L001     | 1,234.5
#   3  L002     | ¥99
#   4  L003     | 待定

AM_HEADER = 1
AM_BAD_AMOUNT = 4

AM_HEADERS: dict[int, str] = {1: "订单编号", 2: "退款金额"}
AM_ROWS: dict[int, list] = {
    2: ["L001", "1,234.5"],
    3: ["L002", "¥99"],
    AM_BAD_AMOUNT: ["L003", "待定"],
}


def _write(path: str, header_row: int, headers: dict[int, str], rows: dict[int, list], sheet: str) -> str:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    for col, name in headers.items():
        ws.cell(row=header_row, column=col, value=name)
    for row_no, values in rows.items():
        for col, value in enumerate(values, start=1):
            if value is not None:
                ws.cell(row=row_no, column=col, value=value)
    wb.save(path)
    wb.close()
    return str(path)


def write_messy(path: str, sheet: str = "导出") -> str:
    return _write(path, M_HEADER, MESSY_HEADERS, MESSY_ROWS, sheet)


def write_clean(path: str, sheet: str = "订单") -> str:
    return _write(path, C_HEADER, CLEAN_HEADERS, CLEAN_ROWS, sheet)


def write_offset_headers(path: str, sheet: str = "导出") -> str:
    """表头在三行表里落在第 3 行（前两行整行为空，从来没被写过）。"""
    return _write(
        path,
        O_HEADER,
        {col: name for col, name in enumerate(OFFSET_HEADERS, start=1)},
        OFFSET_ROWS,
        sheet,
    )


def write_duplicate_key(path: str, sheet: str = "订单") -> str:
    return _write(path, DK_HEADER, {col: name for col, name in enumerate(DK_HEADERS, start=1)}, DK_ROWS, sheet)


def write_blank_header(path: str, sheet: str = "订单") -> str:
    return _write(path, BH_HEADER, BH_HEADERS, BH_ROWS, sheet)


def write_blank_header_with_data(path: str, sheet: str = "订单") -> str:
    return _write(path, BHD_HEADER, BHD_HEADERS, BHD_ROWS, sheet)


def write_duplicate_header(path: str, sheet: str = "订单") -> str:
    return _write(path, DH_HEADER, DH_HEADERS, DH_ROWS, sheet)


def write_bad_dates(path: str, sheet: str = "订单") -> str:
    return _write(path, BD_HEADER, BD_HEADERS, BD_ROWS, sheet)


def write_remarks_with_a_date(path: str, sheet: str = "订单") -> str:
    return _write(path, RM_HEADER, RM_HEADERS, RM_ROWS, sheet)


def write_short_date_column(path: str, sheet: str = "订单") -> str:
    return _write(path, SC_HEADER, SC_HEADERS, SC_ROWS, sheet)


def write_bad_amounts(path: str, sheet: str = "订单") -> str:
    return _write(path, AM_HEADER, AM_HEADERS, AM_ROWS, sheet)


def sheet_rows(path: str) -> list[list]:
    """把整张表读成「每行的值列表」，用于逐格对比（测试侧的独立读法）。"""
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True)
    try:
        ws = wb[wb.sheetnames[0]]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    finally:
        wb.close()


# ── 整理后的期望样子（手写的 work example，不由规则反算） ────────────────
#
# 行号常量在这里的用处是**说清每一行去哪了**：
# 保留下来的行写进 `*_KEPT_ROWS`，被删掉的行不出现 —— 于是「第 4 行为什么没了」
# 能在测试里一眼看出来。

#: MESSY 整理后留下的原文件行：表头 + 2/3/6/7/9/10。
#: 缺的是第 4 行（整行为空）、第 5 行（与第 2 行逐格相同）、第 8 行（主键为空）。
#: 第 7 行主键与第 3 行重复，但那是 `risk`，默认不删 —— 所以它还在。
MESSY_KEPT_ROWS: tuple[int, ...] = (M_HEADER, M_OK_FIRST, M_OK_SECOND, M_OK_THIRD, M_KEY_REPEATS_SECOND, M_OK_FOURTH, M_SPACEY_KEY)

#: 勾选 risk 之后的保留行：第 7 行也走了
MESSY_KEPT_ROWS_WITH_RISK: tuple[int, ...] = (M_HEADER, M_OK_FIRST, M_OK_SECOND, M_OK_THIRD, M_OK_FOURTH, M_SPACEY_KEY)

MESSY_CLEAN_GRID: list[list] = [
    ["订单编号", "客户名称", "处理备注"],  # 「客户名称 」的尾空格被去掉
    ["A001", "张三", "已联系"],
    ["A002", "李四", "已联系"],
    ["A003", "王五", "待回访"],
    ["A002", "李四", "改过的"],  # ← 第 7 行，主键重复但默认不动
    ["A004", "钱七", "待回访"],
    ["A005", "孙八", "已联系"],  # 「  A005  」两端空白被去掉
]

MESSY_CLEAN_GRID_WITH_RISK: list[list] = [
    ["订单编号", "客户名称", "处理备注"],
    ["A001", "张三", "已联系"],
    ["A002", "李四", "已联系"],
    ["A003", "王五", "待回访"],
    ["A004", "钱七", "待回访"],
    ["A005", "孙八", "已联系"],
]

#: CLEAN 一行毛病都没有 —— 整理的结果就该是原样
CLEAN_GRID: list[list] = [
    ["订单编号", "客户名称", "处理备注"],
    ["B001", "周九", "已联系"],
    ["B002", "吴十", "待回访"],
]

#: OFFSET 表头之前的两行空白被删，表头挪到输出文件的第 1 行
OFFSET_KEPT_ROWS: tuple[int, ...] = (O_HEADER, O_OK_FIRST)
OFFSET_CLEAN_GRID: list[list] = [
    ["订单编号", "客户名称", "处理备注"],
    ["D001", "郑一", "已联系"],
]

#: BH 的第 2 列没有列名、整列也没内容 → 整列被删（列号 1、3 被保留，2 被删掉）
BH_KEPT_COLS: tuple[int, ...] = (1, 3)
BH_CLEAN_GRID: list[list] = [
    ["订单编号", "处理备注"],
    ["F001", "已联系"],
    ["F002", "待回访"],
]

#: BHD 的第 2 列同样没有列名，但下面有数据 → 只报不改，列留着（列名仍是空的）
BHD_KEPT_COLS: tuple[int, ...] = (1, 2, 3)
BHD_CLEAN_GRID: list[list] = [
    ["订单编号", None, "处理备注"],
    ["G001", "客服手写的备注", "已联系"],
]
