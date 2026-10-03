# 21 · Excel 快捷操作（跑前预处理 / 跑后汇总）

Status: done
Priority: P0.5
Type: task
Blocked by: —

## 背景

阶段五第 4 件（顺序：组合键 → 按键精灵 → know → Excel）。补上「批量跑之前先把表收拾干净」
与「跑完给一句话结论」两端。**不做逐行 Excel 指令类型** —— 那是 O(n²) 且中间结果不可见。

用户裁定（含一轮追问）：

- 「跑前预处理」做成**控制台「资源」组的独立页**，不绑实例。清一张表不该先建实例；
  引擎 API 仍可被 `rpa` 复用。
- 落地方式：**原文件只读**，出「原名_已整理.xlsx」+ **逐处改动台账**（before/after）。
- 「跑后汇总」：运行页给一句话结论 + 失败原因归类 Top N + 可导出**待人工确认清单**。
- 预处理范围：去空白、删空行、去重（含重复主键）、列名归一 —— **全部做**。
  其中「重复主键只保留第一行」有语义风险，定为 `risk` 级：默认不应用，需显式勾选。
- **类型转换降级为体检**（见下）。

## 为什么「类型转换」从改值降级为体检

原裁定是「含类型转换」。核实后发现它在平台上**没有消费方**：

- 模板层已经吃文本型金额与日期。`src/lib/template.cases.json` 里有
  `money("1,234.5") → "1,234.50"`（`_AMOUNT_NOISE` 剥 `,` / 空格 / `¥` / `￥`）
  和 `date("2026年10月2日") → "2026-10-02"`（`_DATE_FORMATS` 覆盖中文、斜杠、ISO）。
- Excel 对比层也吃：`compare/compare_core._to_float` 会把带逗号/货币符号的字符串转 float。
- 而且 `template._to_datetime` 是**刻意保守**的，docstring 写着：
  「**不接受 `02/10/2026` 这种有歧义的写法**，猜错的日期会直接变成客户投诉，不如让它整行失败」。

所以在预处理里把文本型日期/金额改成真值，等于在两条已覆盖的路径上再写一遍，
并把「认不出来就报错」换成「静默改成另一个值」——净收益 0、净风险 > 0。

改成：**用模板层同一套判定逐格试解析，把「认不出来、会让整行失败」的值连行号报出来**。
信息更有用（用户知道是哪一行的问题），判定复用单一真源（不新造一套「像不像日期」的臆测）。

## 侦察结论

| 件 | 现状 |
| --- | --- |
| `engine/excel.py` | 已有 `detect_columns` / `read_rows` / `sample_row` / `count_rows` / `ensure_status_column` / `write_row_status` / `backup_file`。**只管「跑中」**：跑前不查表，跑后只逐行写「成功/失败」 |
| `normalize_no` | 去空白（含全角）**只用在 logi 链路**（`providers.py` ×3、`write_logistics_result`）。`rpa.read_rows` 直接 `str(value)`，单号带空格就是两个不同的键 |
| `sample_row` | 得专门跳过前导空行 —— 说明「表头下面空一行」真实存在，现在只能靠取数据时绕过去 |
| `read_rows` 列匹配 | `if key_col not in headers` 精确匹配。表头带尾部空格时报「未找到列「客户名称」」，用户看不出差在哪 |
| 运行页统计 | 「结果分布 / 每行耗时 / 明细」在**前端** `RunPage` 的 `useMemo` 里算。P1 #13「定时日报汇总」需要后端也能算同一份结论 |

## 分层与归属

```
1 值归一化    首尾空白（含全角）· 空值判定 · 类型探测      engine/excel_prep/values.py
2 规则表      kind → severity / 适用性 / 如何应用           engine/excel_prep/rules.py
3 体检（只读） 扫描表 → Report（列 + 行数 + issues[]）      engine/excel_prep/inspect.py
4 整理（出新文件）应用规则 → 新文件 + ChangeLog             engine/excel_prep/clean.py
5 HTTP API    /api/excel/inspect · /clean · 下载           engine/excel_prep/routes.py
6 跑后汇总    行台账 → 一句话结论 + 原因归类 + 确认清单      engine/summary.py
7 前端        资源组「Excel 体检」页 + 运行页汇总块          modules/excel/
```

## 规则与执行顺序（顺序本身是契约）

顺序不能乱，每一步以前一步的结果为输入：

```
1 trim_header      列名去首尾空白（含全角）
2 drop_blank_rows  删掉整行为空的行（含表头之上的前导空行）
3 trim_key         主键值去首尾空白
4 drop_blank_key   删掉主键为空的行     ← 必须在 3 之后，否则「   」不算空
5 drop_dupe_rows   删掉完全重复的行     ← 必须在 3 之后，否则「 123 」与「123」不算重复
6 drop_dupe_keys   主键重复只留第一行   ← risk，默认不应用
```

`severity` 三个取值各有真实消费方，不是标签：

- `info` —— 只报不改（类型探测结果、列名重复）
- `fix` —— 整理时自动应用
- `risk` —— 整理时会改，但**默认不应用**，要在页面上显式勾选

| kind | severity | 说明 |
| --- | --- | --- |
| `header_whitespace` | fix | 列名带首尾空白 |
| `blank_header` | fix | 表头单元格为空（占位列） |
| `duplicate_header` | info | 列名重复 —— 取列只会取到第一个，自动改名更糟 |
| `leading_blank_rows` | fix | 表头之上的空行。留着会让「第一行有内容的数据」定位不到 |
| `blank_row` | fix | 数据区整行为空 |
| `blank_key` | fix | 主键列为空 |
| `key_whitespace` | fix | 主键值带首尾空白 |
| `duplicate_row` | fix | 整行完全相同 |
| `duplicate_key` | **risk** | 主键重复（只留第一行）。同一条工单做两遍 = 重复退款 |
| `unparsable_value` | info | 疑似日期/金额列里模板认不出来的值 |

**行号一律用原文件的行号。** 删除行会让行号漂移，用户是对着原文件去核对的。

## Seam（已与用户确认）

| 切片 | Seam | 真相源 | 状态 |
| --- | --- | --- | --- |
| 1 | `engine.excel_prep.values.normalize_text(v) / is_blank(v)`<br>`engine.excel_prep.inspector.inspect(path, key_col) -> Report` 的最小形态（列名 + 空行 + 空主键 + 去重类） | `openpyxl` 手搓最小表 + **手算期望**（行号自己数，不靠代码算） | ✅ 35 项 |
| 2 | `inspect` 补齐空列名 / 列名重复 / 类型体检 | 同上 | ✅ +16 项 |
| 3 | `engine.excel_prep.clean.clean(path, options) -> (out_path, ChangeLog)` | 手写 work example + **一条硬不变量**：逐格对比输入与输出，实际差异集合必须**恰好等于** ChangeLog（对账器不认识任何规则） | ✅ 17 项 |
| 4 | `/api/excel/inspect`、`/clean`、`/download`、`/open` | `TestClient`（沿用 `test_api.py` 写法），字段名 camelCase 钉死 | ✅ 21 项 |
| 5 | `engine.summary.summarize(rows, top) -> Summary` | **手算样例**（N 成功 / M 失败 / K 跳过 / 原因归类条数） | ✅ 19 项 |
| 6 | `modules/excel/ExcelPrepPage.tsx` + 运行页汇总块 + `/instances/{iid}/summary` | 截图 harness（同 20 的做法）；下载/打开文件走设备层，不进自动化 | ✅ 16 镜头 ×2 主题 |

### 切片 2 的两处裁定（用户选）

- **空列名**：整列都没有内容才删（`fix`）；下面有数据就只报（`info`）。
  列名是用户起的名，工具编不出正确的名字，编个「未命名1」等于让用户对着一个不存在的列名写模板。
  所以 `blank_header` 的 severity 是**按列算的**，不是 kind 上写死的。
- **类型体检**：保守判定 —— 非空格 ≥3、能解析的 ≥2、且**严格多数**能解析，才认这一列是日期/金额列。
  判定放到「一半一半」，备注列里偶然出现的一个日期串就会把整列打成日期列，
  报告全是误报之后用户就不看体检了。

### 刻意不做

- **逐行 Excel 指令**（`{列名}` 写回中间结果）—— O(n²)、中间结果不可见，用户已明确排除。
- **类型改值**（见上）。
- **自动改原文件** —— 一律出新文件；原文件只读。
- **多工作表** —— 只处理第一个工作表。`excel.py` 与 `compare/excel_io.py` 都是这个口径，
  单独在这一处支持多表会让「同一个工具对同一张表有两种理解」。

## 已知风险

- **规则顺序敏感**：`drop_blank_key` 依赖 `trim_key` 先跑。测试要钉住「顺序反了会怎样」。
- **删除行 + 行号**：台账记原行号，输出文件里行号会变。要在 docstring 与页面上都说清用户去哪张表核对。
- **重复主键的「第一行」**：按原文件的行序，不按时间列（表里未必有）。
- **主键中间空白**：`normalize_no` 会去掉**中间**空白。对单号对，对「客户名称」错
  （「张 三」→「张三」）。所以主键只去**首尾**空白；中间空白另有开关，默认关。

## 验收标准

- [x] 体检：六类结构问题 + 类型问题都能检出，行号与原文件一致
- [x] 整理：输出新文件、原文件逐字节不变；台账与实际差异一一对应（对账器反证过五类漏记）
- [x] 规则顺序：`trim_key` 先于 `drop_blank_key` / `drop_dupe_rows`
- [x] `risk` 类默认不应用，勾选后才应用
- [x] `/api/excel/*` 字段名 camelCase；下载端点只允许下载自己产出的文件
- [x] 跑后汇总：一句话结论 + 原因归类 + 待人工确认清单可导出（后端 ✅ 19 项，清单导出在前端）
- [x] 双端 `typecheck` / `npm test` / `npm run test:py` 全绿；页面截图验收（明暗各一套）
      （后端 644 / 前端 445 / `.scratch/verify/run-excel.sh` 16 张全过）

## Comments

- 2026-10-02 立项。seam 先与用户确认；过程中用证据推翻了一个已拍板的选项（类型转换），
  用户改选「降级为体检」。教训记在这里：**选项的描述会决定选择**，
  写「含类型转换」时没有先核实它有没有消费方，等于给了个看起来更大、实际是负收益的选项。
- 2026-10-02 切片 1–5 完成，后端 641 passed。过程中值得留下的几条：
  - **`Issue.cols` 是必需的**，不是装饰：表头类问题的主语是**列**（「第 3 列没列名」），
    整理要照着它删列。只给 `rows` 的话，删列这件事在台布里无从表达。
  - **整理不自己判一遍**：`clean()` 先要一份 `inspector` 的报告，再照着报告动手。
    「报告说第 5 行重复」和「整理删了第 5 行」于是是同一句话的两面，不存在两套判定跑偏。
  - **改值的台账在写文件那一趟里生成**，不是回头补。先改文件再补台账，迟早漏一处。
  - **对账器必须反证过**：拿「台账 + 输入」还原输出、逐格比对，然后故意喂五种坏台账
    （漏记改值 / 多记没发生的改动 / 静默多删一行 / 漏记删列 / before 记错），确认五种都被抓到。
    不反证的「不变量测试」有可能整个是空转的。
  - **手算期望会算错**：写 `rows == (4, 5)` 时忘了表头占第 1 行，实际是 `(5, 6)`。
    错的是期望不是实现 —— 这类偏差正好说明「行号必须手写常量、不能让代码算」。
  - **`clean.py` 的文件名不能叫 `inspect.py`**：会遮蔽标准库 `inspect`，
    而且 `from . import inspect` 会让人以为是标准库。模块名定为 `inspector`。
- 2026-10-02 回归尾巴：全量跑时 `test_monitor.py::test_runner_monitor_branch_runs_and_logs_hit`
  偶发失败（单独跑通过）。它与本次改动无关（runner 线程 + 5s 超时的时序），
  先记在这里，不混进这个工单。
- 2026-10-02 切片 6 完成，工单关闭（后端 644 / 前端 445 / 截图 16 张）。截图这一趟抓出三件真问题：
  - **`json()` 不认后端写的 detail**。引擎把「为什么不行」写成了给人看的中文
    （`找不到文件：…`、`只支持 .xlsx / .xlsm，收到的是…`），前端却抛
    `GET /excel/inspect?... failed: 404` —— 用户看到的是地址栏。库里早就有 `failWith`
    （挖 detail / message，挖不到退回 fallback），只是 `json()` 没走它。一行改掉，
    补两个测试钉住（detail 优先 / 无 detail 时退回带状态码的话）。
  - **台账里的空白被 CSS 折掉**。`  A005  → A005` 在默认 `white-space` 下渲染成
    `A005 → A005`，看起来像什么都没改 —— 而台账的用途正是「照着原表核对」。
    改值那一行加 `whitespace-pre-wrap`。这条没有单测可写（CSS 不是 seam），
    守它的是截图 harness 的两条断言：DOM 文字里留有空格 + computed `white-space` 是 `pre-wrap`。
  - **截图抓在进场动画进行中**。`shotWhen` 在数据一到就读 `innerText`，全部断言通过，
    但 `motion` 的 staggerList 那一刻刚起步，截图里是一整块 opacity:0 的空白 ——
    正是「只信 innerText 会假通过」的现形。改成 `shotSection`：等文字出现 →
    等 1.1s 动画落定 → 滚到目标区 → 再落图断言 `inViewport`。
  - 另外两条自动化本身的教训：
    - **Radix Select 合成事件驱不动**：`PointerEvent('pointerdown')` 能开面板、
      选项也点得着，`pointerup` 就是不提交（`SelectItemImpl` 内部那份 pointerType 状态）。
      调它比直接发真实输入事件更贵 —— 改用 `sendInputEvent`（mouseMove/Down/Up），
      与用户点一下完全同路，一次过。
    - **等待条件会被页头文案骗到**：`has('改动台账')` 在页头描述
      「并留下逐处改动台账」上立刻假通过。等待条件必须用只在目标状态才出现的文案
      （这里换成了 `已整理出「excel-messy_已整理.xlsx」`）。
  - 界面验收数据与镜头对应关系记在 `.scratch/verify/seed_excel.py` 与 `excel.cjs` 的注释里；
    跑法：`bash .scratch/verify/run-excel.sh`（构建 → 造数据 → 起引擎 → 截图 → 杀引擎，一条命令跑完）。
