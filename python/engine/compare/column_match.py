"""列名智能匹配引擎（纯逻辑，不依赖 GUI）。

背景：基准表 A 的列名和核对表 B/C 的列名常常对不上号，例如
    A「订单号」    ↔  B「订单编号」/「订单ID」/「单号」
    A「退差金额」  ↔  B「退款差额」/「退款金额」/「退差金额（元）」
早先的实现只做「完全相同 / 去空格相同 / 简单子串」三档，覆盖不到这些情况，
导致用户必须手动逐列去选。

做法（三步，逐层收紧）：
  1. 归一化：全角转半角、去掉括号注释「（元）」、去空白与分隔符、转小写。
     所以「订单 号」「订单号（主键）」都能归到「订单号」。
  2. 词级同义词归一：把列名切成"概念 token"，同义词收敛到同一个标准词。
     「订单号」→ {订单, 编号}；「订单编号」→ {订单, 编号}；两者完全相同 → 高分。
     「退差金额」→ {退款, 金额}；「退款差额」→ {退款, 金额} → 同上。
     而「商品金额」→ {商品, 金额} 与「退差金额」只有一半重合 → 低分，不会错配。
  3. 一对一最优分配：所有"字段×列"打分后按分数从高到低贪心配对，
     一列只能被用一次、一个字段只配一列 —— 避免「订单号」和「订单编号」两列
     被同一个基准字段抢走，或反过来一个列被多个字段重复引用。

设计取向：**宁可留空，也不要错配**。没配上的行在界面上会显示琥珀色，用户可以
手动点一下选好；但一旦错配，对比结果会静默出错，代价高得多。因此阈值取得偏严。
"""
from __future__ import annotations

import difflib
import re
import unicodedata

# 低于这个分数就不自动配对（留空给用户手动选）
MATCH_THRESHOLD = 0.68

# --------------------------------------------------------------------------
# 1. 归一化
# --------------------------------------------------------------------------
_PAREN = re.compile(r"[(\[【][^)\]】]*[)\]】]")
_NOISE = re.compile(r"[\s_\-/\\.,·、:：;；'\"“”|]+")


def norm_col(s) -> str:
    """把列名归一化：全角转半角 → 去括号注释 → 去空白与分隔符 → 小写。

    例：「退差金额（元）」→「退差金额」；「订单 号」→「订单号」；「Order_NO」→「orderno」
    """
    if s is None:
        return ""
    t = unicodedata.normalize("NFKC", str(s))
    t = _PAREN.sub("", t)
    t = _NOISE.sub("", t)
    return t.strip().lower()


# --------------------------------------------------------------------------
# 2. 词级同义词归一
# --------------------------------------------------------------------------
# 词 -> 标准概念。同义词收敛到同一个标准词，是"订单号"能对上"订单编号"的关键。
_LEXICON = {
    # ---- 主体词 ----
    "订单": "订单", "单据": "订单", "交易单": "订单", "交易": "订单", "单": "订单",
    "退款": "退款", "退差": "退款", "退费": "退款", "应退": "退款", "实退": "退款",
    "退回": "退款", "退货": "退款", "返款": "退款",
    "商品": "商品", "货品": "商品", "产品": "商品", "货物": "商品",
    "客户": "客户", "用户": "客户", "买家": "客户", "顾客": "客户", "会员": "客户",
    "物流": "物流", "快递": "物流", "运单": "物流", "配送": "物流",
    "支付": "支付", "付款": "支付", "收款": "支付",
    "店铺": "店铺", "门店": "店铺", "商家": "店铺", "供应商": "店铺",
    "员工": "员工", "人员": "员工",
    # ---- 属性词 ----
    "编号": "编号", "编码": "编号", "号码": "编号", "id": "编号", "code": "编号",
    "no": "编号", "num": "编号", "number": "编号", "号": "编号", "码": "编号",
    "金额": "金额", "差额": "金额", "差价": "金额", "款额": "金额", "amount": "金额",
    "amt": "金额", "money": "金额", "price": "金额", "额": "金额",
    "数量": "数量", "件数": "数量", "个数": "数量", "qty": "数量", "quantity": "数量",
    "日期": "日期", "时间": "日期", "date": "日期", "time": "日期",
    "状态": "状态", "status": "状态", "名称": "名称", "姓名": "名称", "name": "名称",
    "备注": "备注", "说明": "备注", "remark": "备注", "memo": "备注", "note": "备注",
    "电话": "电话", "手机": "电话", "联系方式": "电话", "phone": "电话", "mobile": "电话",
    "地址": "地址", "address": "地址", "比例": "比例", "rate": "比例", "税率": "比例",
    # ---- 英文列名（Excel 里导出成英文表头也很常见）----
    # 整词优先，保证 "orderno" 命中而不是被切成 order+no 或字母碎片
    "orderno": "订单", "ordernumber": "订单", "orderid": "订单", "order": "订单",
    "orders": "订单", "trade": "订单",
    "refundamount": "退款", "refund": "退款", "rebate": "退款",
    "amount": "金额", "amt": "金额", "money": "金额", "price": "金额",
    "fee": "金额", "total": "金额",
    "customer": "客户", "user": "客户", "buyer": "客户", "member": "客户",
    "product": "商品", "sku": "商品", "item": "商品", "goods": "商品",
    "shop": "店铺", "store": "店铺", "seller": "店铺",
    "qty": "数量", "quantity": "数量", "count": "数量",
    "status": "状态", "date": "日期", "time": "日期", "datetime": "日期",
    "phone": "电话", "mobile": "电话", "tel": "电话",
    "remark": "备注", "note": "备注", "memo": "备注", "comment": "备注",
    "address": "地址", "name": "名称", "title": "名称",
    "id": "编号", "code": "编号", "num": "编号", "number": "编号", "no": "编号",
}

# 按长度降序，保证"最长匹配优先"（"订单编号" 会切成 订单+编号，而不是 订单+编+号）
_WORDS_BY_LEN = sorted(_LEXICON, key=len, reverse=True)


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or "\u4e00" <= ch <= "\u9fff"


def tokens(name) -> set:
    """把列名切成概念 token 集合（同义词已归一）。"""
    s = norm_col(name)
    out: set = set()
    i = 0
    n = len(s)
    while i < n:
        hit = None
        for w in _WORDS_BY_LEN:
            if s.startswith(w, i):
                hit = w
                break
        if hit:
            out.add(_LEXICON[hit])
            i += len(hit)
        elif s[i].isascii() and s[i].isalnum():
            # 词典外的连续字母/数字整体保留（避免 "orderno" 被切成 o,r,d,e,r 一堆碎片）
            j = i
            while j < n and s[j].isascii() and s[j].isalnum():
                j += 1
            out.add(s[i:j])
            i = j
        else:
            ch = s[i]
            if _is_word_char(ch):
                out.add(ch)      # 词典外的字（如"实际"的"实""际"）按单字保留
            i += 1
    return out


# --------------------------------------------------------------------------
# 3. 打分
# --------------------------------------------------------------------------
def similarity(a, b) -> float:
    """两个列名的相似度，0.0 ~ 1.0。"""
    na, nb = norm_col(a), norm_col(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0

    ta, tb = tokens(na), tokens(nb)
    best = 0.0

    if ta and tb:
        inter = ta & tb
        if inter:
            if ta <= tb or tb <= ta:
                # 一个是另一个的子集：「金额」↔「退差金额」→ 高分（但比"完全相同"略低）
                small, big = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
                best = 0.72 + 0.22 * (len(small) / len(big))
            else:
                # 部分重合：按 Jaccard 折算，重合一半也只到 0.45 —— 不足以配对
                best = 0.9 * (len(inter) / len(ta | tb))

    # 归一化后仍有直接包含关系（词典切分可能失真时的兜底）
    if na in nb or nb in na:
        short, long_ = (na, nb) if len(na) <= len(nb) else (nb, na)
        best = max(best, 0.80 + 0.18 * (len(short) / len(long_)))

    # 纯字符相似度兜底（英文、拼音缩写、无词典覆盖的中文）
    r = difflib.SequenceMatcher(None, na, nb).ratio()
    best = max(best, r * 0.72)

    return min(best, 1.0)


# --------------------------------------------------------------------------
# 4. 一对一最优分配
# --------------------------------------------------------------------------
def auto_map(fields, columns, existing=None, force: bool = False,
             threshold: float = MATCH_THRESHOLD) -> dict:
    """给每个基准字段挑一个目标列。

    fields   : 基准表参与对比的字段名列表（如 ["订单号", "退差金额"]）
    columns  : 目标表的列名列表
    existing : 当前已有的映射 {字段: 列|None}
    force    : True = 忽略已有映射全部重算（用户点「智能匹配」按钮时用）；
               False = 保留已有的有效映射，只给空槽位补配（上传/换列时用）

    返回 {字段: 列名 | None}，键与 fields 一一对应。
    """
    existing = existing or {}
    cols = list(columns)
    result: dict = {f: None for f in fields}
    used: set = set()

    # 1) 非强制模式下，先锁定用户（或上次）已经配好的映射
    if not force:
        for f in fields:
            c = existing.get(f)
            if c and c in cols and c not in used:
                result[f] = c
                used.add(c)

    # 2) 剩余字段：按分数从高到低贪心配对，一列只用一次
    order = {f: i for i, f in enumerate(fields)}
    corder = {c: i for i, c in enumerate(cols)}
    pairs = []
    for f in fields:
        if result[f]:
            continue
        for c in cols:
            if c in used:
                continue
            s = similarity(f, c)
            if s >= threshold:
                pairs.append((s, f, c))
    pairs.sort(key=lambda t: (-t[0], order[t[1]], corder[t[2]]))

    for _s, f, c in pairs:
        if result[f] or c in used:
            continue
        result[f] = c
        used.add(c)

    return result
