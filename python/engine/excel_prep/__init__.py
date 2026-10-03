"""Excel 跑前预处理：只读体检 + 出新文件的整理。

分层与归属（工单 21）：

```
values.py    单元格值归一化 · 空值判定 · 行签名    纯函数，不碰文件
rules.py     kind → severity / 一句人话 / 执行顺序   体检与整理共用的口径
inspector.py 只读体检：扫一张表 → Report           不动任何文件
clean.py     应用规则 → 新文件 + ChangeLog         原文件只读
routes.py    /api/excel/*                          引擎边界
```

**为什么把「相等」「为空」收进一个 `values` 模块**：体检说「第 5 行重复」，
整理却删了第 7 行 —— 这类事故的成因就是两处各写了一套判定。
"""

from . import clean, inspector, rules, service, values

__all__ = ["clean", "inspector", "rules", "service", "values"]
