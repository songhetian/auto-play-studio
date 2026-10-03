"""知识库（kb）：把本地文件夹变成可全文检索的索引。

分层与归属（谁在意哪一层）：

```
extract   文件 → 纯文本          本包
chunk     纯文本 → 段落数组       本包
engine    n-gram 倒排 + BM25 检索 本包
store     文档/段落/文件夹/历史    本包（落引擎 SQLite）
routes    /api/kb/*              本包
```

移植自仓库根的 `know/`（KnowAssist）。可取的是渲染层那几个零依赖的纯函数模块；
**抽取层必须重写** —— know 真正的解析代码在 Electron 主进程里，那个目录已经不在
仓库里了（只剩 `app.asar` 二进制）。
"""
