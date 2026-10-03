# 20 · `know/` 内容搜索集成

Status: done
Priority: P0.5
Type: task
Blocked by: —

## 背景

仓库根下有一个独立的桌面检索工具 `know/`（KnowAssist，Listary 风格的浮动搜索）。
用户要求把它集成进平台，并顺带做项目优化。裁定（用户选定推荐项）：

- 知识库挂在控制台**「资源」**组（与「图像素材库」并列），**不做成可多开的工具**。
  理由：知识库是全局唯一的一份索引，多开只会让每个窗口各建一份内存索引；
  且将来 P1 #14 话术片段库要共用同一台引擎。
- 搜索算法**移植到 Python 引擎**（`python/engine/kb/`），符合「引擎是数据真源」的既有约定。
- 本轮**后端 + 页面一次做完**。

## 侦察结论（决定了工作量分布）

| 件 | 体量 | 状态 | 去向 |
| --- | --- | --- | --- |
| `app/src/engine/search.ts`（n-gram 倒排 + BM25 + 近邻加权 + AND→OR + type 过滤） | 1013 行 | 完好 | 移植 |
| `app/src/engine/search.test.ts` | 1544 行 / 70 项 | 完好 | **移植的真相源** |
| `app/src/engine/pinyin.ts` | 55 行 | 完好 | 移植（pinyin-pro → pypinyin） |
| `app/src/engine/parsers.ts` 的 `chunkText` | 89 行 | 完好 | 取件（须逐字对齐） |
| `app/src/engine/library.ts`（归并去重 / 计数 / 公共前缀推断文件夹） | 160 行 | 完好 | 取件 |
| **`app/electron/`（主进程）** | — | **源码已丢** | **重写** |
| `know/src/`（更早的 PySide6 版） | — | 不存在，`run.py` 是死链 | 不涉及 |

两条硬事实：

1. **抽取层不是「搬过来」而是「重写」。** 真正解析 PDF/Word/Excel/PPT 的代码在主进程，
   `app/electron/` 整个目录不在仓库里（只有 `release/win-unpacked/resources/app.asar` 这个
   96MB 二进制），`package.json` 的 `main` 还指着 `electron/main.js`。同目录的 chokidar 监听、
   剪贴板监听、全局快捷键、开机自启也一并丢了。
   好消息：`know/requirements.txt`（PySide6 时代的依赖清单）已经把 Python 侧该用的库列好了 ——
   PyPDF2 / python-docx / python-pptx / openpyxl。
2. **`search.test.ts` 全是行为用例**（构造文档 → `search(query)` → 断言结果），
   而不是实现耦合的白盒测试 —— 所以它是移植的**独立真相源**，可以逐项翻译成 pytest。

## 分层与归属

```
1 抽取文本    PDF/Word/Excel/PPT/纯文本          重写（原地为主进程，源码已丢）
2 段落切分    空行分块 · 超 80 字按句切 · 行号递增   取件（chunkText，逐字对齐）
3 建索引      2–3 字 n-gram 倒排 + BM25 + 拼音    移植（70 项行为用例当真相源）
4 检索 API    /api/kb/*（引擎边界）               新建
5 资源页      搜索框/结果/打开原文件/历史           新建（控制台「资源」组）
```

## Seam（已与用户确认）

| 切片 | Seam | 真相源 |
| --- | --- | --- |
| 1 | `engine.kb.extract.extract_text(path) -> str`<br>`engine.kb.extract.read_raw_file(path) -> RawFile` | **手搓的最小文件**：docx/xlsx/pptx 本是 ZIP+XML，用 `zipfile` 手工写最小 OOXML；PDF 手写最小字节流。**不走被测库的写入路径**，避免「自己写自己读」的重言式 |
| 2 | `engine.kb.chunk.chunk_text(text) -> list[Paragraph]` | **手算样例**（不照抄 JS 测试） |
| 3 | `engine.kb.engine.SearchEngine.search(query) -> list[SearchResult]` | `know/app/src/engine/search.test.ts` 的 70 项行为用例，按 describe 分组翻译 |
| 4 | `engine.kb.store`（四张表 + CRUD）<br>`engine.kb.indexer.reindex(folders, progress)` | 临时目录里的真实文件树（复用切片 1 的夹具） |
| 5 | `/api/kb/status`、`search`、`folders`、`reindex`、`history` | `TestClient`（沿用 `test_api.py` 写法） |
| 6 | `modules/kb/KbPage.tsx` + `lib/kbApi.ts` | 组件测试断言「输入查询 → 出现文件名与命中片段」；**打开原文件走 IPC，不进自动化测试** |

### 刻意不移植

`searchAsync` / `exportIndexData` / `fromIndexData` / `search.worker` —— 它们是为
「JS 单线程 + 万级文档」存在的（Worker 里建索引、把索引转移回主线程）。Python 服务进程
没有对应需求，搬过来只是死代码。分阶段索引进度保留一个简化版，因为页面要显示。

### 已知风险

- **拼音库不同源**：`pinyin-pro` 与 `pypinyin` 对多音字取音可能不一致。
  处理：拼音用例断言**命中/不命中**，只在无歧义的字上钉死拼音串。
- **PDF 中文**：手写的最小 PDF 只能是 ASCII（中文需嵌入 CID 字体）。
  中文 PDF 另用**跨库**夹具（reportlab 生成、pypdf 读），避免同库读写。

## 验收标准

- [x] 抽取层：五种格式都能抽出文本，且抽出的是夹具里明确写进去的字面量
- [x] 段落切分与 know 原实现逐字对齐（空行分块 / 80 字阈值 / 句边界 / 行号）
- [x] 检索语义与 know 一致：AND 优先、无结果降级 OR、BM25 排序、文件名加权、近邻加权、
      `type:` 过滤、拼音首字母与全拼、同文件多分片去重、增量增删
- [x] 索引落 SQLite：登记文件夹后重启引擎不用重新抽取，段落从库里按需读
- [x] `/api/kb/search` 能返回文件名 + 命中片段 + 分数
- [x] 控制台「资源」组出现「知识库」页；搜索、看片段、打开原文件都能用
- [x] 双端 `typecheck` / `npm test` / `npm run test:py` 全绿；页面肉眼验收（明暗各一套）

## Comments

- 2026-10-02 立项。侦察发现抽取层源码已随主进程丢失（只剩 96MB asar），
  所以「搬 know」实际是「取 3 件 + 重写抽取层」。seam 已与用户逐条确认。
- 2026-10-02 切片 1–4 全绿（19 + 14 + 57 + 22 = 112 项）。移植抓到一个真缺陷：
  `SearchEngine.add_document` 漏把段落交给 store，增量添加的文档搜不到自己的内容且不报错。
- 2026-10-02 切片 5（HTTP API）18 项全绿，后端合计 533。camelCase 契约又抓到两处
  snake_case 泄漏（`docCount` / `resultCount`），都靠「字段名钉死」的测试当场抓住。
- 2026-10-02 切片 6（资源页）完成。**切片 6 的 seam 与工单原计划不同**：
  组件测试没有写（页面没有可提取的纯逻辑，唯一可测的「片段高亮」单独放
  `lib/kbFilter.ts` + 13 项测试），验收改走截图 harness —— 事实证明这条路是对的，
  它抓到了三个组件测试根本抓不到的问题：
  1. **`Progress` 组件丢了 `aria-valuenow`**：`value` 只喂给指示条没给 Root，
     视觉上会动，屏幕阅读器看到的是一个「不确定进度」的空条。修在 `ui/progress.tsx`。
  2. **仪表盘「资源与系统」是写死的一份清单**，加知识库时导航有了、首页没有 ——
     「navModel 是唯一真源」被绕过了。改成从 `NAV_GROUPS` 派生。
  3. **底部动作的反馈滚出视口**：在页面底部点注销，反馈横幅渲染在顶部，
     用户以为没反应。改成横幅出现时 `scrollIntoView({ block: 'nearest' })`。
  另补了两个可机读性缺口：导航条目加 `aria-current`，进度条加 `aria-valuenow`。
- 2026-10-02 验收截图在 `.scratch/verify/7*-*.png`（明暗各一套，含空态 / 结果 / 拼音 /
  无结果 / 索引进度 / 注销确认 / 注销后），脚本 `.scratch/verify/run-kb.sh`（用完即弃）。
  「注销不动磁盘文件」在磁盘上真查了一遍。
