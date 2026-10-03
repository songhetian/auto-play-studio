"""Excel 多表对比：以 A 表为基准，找出与 B/C… 表的差异。

按职责拆成独立模块，任何一块都能单独替换或测试：
    excel_io.py     读表 / 表头规整
    column_match.py 列名智能匹配（A「订单号」↔ B「订单编号」）
    compare_core.py 对比引擎（纯逻辑，不碰 IO）
    report.py       结果写出（汇总 + 对比结果，带配色）
    config_io.py    方案存取（按文件名复用映射）
    service.py      门面：读文件 → 对比 → 写报告

移植自 compare-excel/src（PyQt 版），UI 由前端 React 重写。
"""
